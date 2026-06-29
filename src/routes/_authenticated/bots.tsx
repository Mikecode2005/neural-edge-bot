import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Play, Square, Activity } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import { startBot, stopBot, listBots, tickBot } from "@/lib/bots/bots.functions";
import { getActiveDerivToken } from "@/lib/deriv/connections.functions";
import { checkRisk, logTradeOpen, logTradeClose } from "@/lib/trading/execute.functions";
import { recordOutcome } from "@/lib/ai/qwen.functions";
import { analyzeMarketWithHfRouter } from "@/lib/ai/hf-router";
import { getDerivWS } from "@/lib/deriv/ws";
import { analyze } from "@/lib/ob-fvg";
import { DERIV_SYMBOLS } from "@/lib/deriv-ws";

export const Route = createFileRoute("/_authenticated/bots")({
  head: () => ({ meta: [{ title: "Bots — Autonomous AI Loop" }] }),
  component: BotsPage,
});

interface BotRow {
  id: string;
  symbol: string;
  timeframe: string;
  account_type: "demo" | "real";
  status: "running" | "paused" | "stopped" | "error";
  interval_seconds: number;
  min_confidence: number;
  max_stake_per_trade: number;
  total_trades: number;
  total_pnl: number;
  last_tick_at: string | null;
  last_error: string | null;
  market_mode: string;
}

function BotsPage() {
  const fnStart = useServerFn(startBot);
  const fnStop = useServerFn(stopBot);
  const fnList = useServerFn(listBots);
  const fnTick = useServerFn(tickBot);
  const fnGetToken = useServerFn(getActiveDerivToken);
  const fnCheckRisk = useServerFn(checkRisk);
  const fnLogOpen = useServerFn(logTradeOpen);
  const fnLogClose = useServerFn(logTradeClose);
  const fnRecordOutcome = useServerFn(recordOutcome);

  const [bots, setBots] = useState<BotRow[]>([]);
  const [form, setForm] = useState({
    symbol: "R_10",
    account_type: "demo" as "demo" | "real",
    interval_seconds: 60,
    min_confidence: 0.7,
    max_stake_per_trade: 1,
  });
  const loopsRef = useRef<Map<string, number>>(new Map());

  const load = async () => setBots((await fnList()) as BotRow[]);
  useEffect(() => {
    load();
    return () => {
      loopsRef.current.forEach((id) => clearInterval(id));
    };
  }, []);

  const runOneTick = async (bot: BotRow) => {
    try {
      const ws = getDerivWS();
      const candles = await ws.fetchCandles(bot.symbol, 60, 200);
      if (candles.length < 30) return;
      const analysis = analyze(candles);
      const price = candles.at(-1)!.close;
      const ai = await analyzeMarketWithHfRouter({
        symbol: bot.symbol,
        timeframe: bot.timeframe,
        candles: candles.slice(-60),
        analysis,
        currentPrice: price,
        balance: 1000,
      });
      if (ai.direction === "NONE" || ai.confidence < bot.min_confidence) {
        await fnTick({ data: { id: bot.id, executed: false, pnl_delta: 0 } });
        return;
      }
      // Risk + execute
      const stake = Math.max(0.35, Math.min(ai.stake ?? 1, bot.max_stake_per_trade));
      const risk = (await fnCheckRisk({
        data: { proposed_stake: stake, account_type: bot.account_type },
      })) as { ok: boolean; reason?: string };
      if (!risk.ok) {
        await fnTick({ data: { id: bot.id, executed: false, pnl_delta: 0, error: risk.reason } });
        return;
      }
      const tok = (await fnGetToken()) as { token: string; currency: string; loginid: string; account_type: string } | null;
      if (!tok || tok.account_type !== bot.account_type) {
        await fnTick({
          data: { id: bot.id, executed: false, pnl_delta: 0, error: `Active Deriv account not ${bot.account_type}` },
        });
        return;
      }
      await ws.authorize(tok.token);
      const prop = await ws.proposal({
        symbol: bot.symbol,
        amount: stake,
        contract_type: ai.direction,
        duration: ai.duration && ai.duration > 0 ? ai.duration : 5,
        duration_unit: (ai.duration_unit as "t" | "s" | "m" | "h") || "t",
        basis: "stake",
        currency: tok.currency,
      });
      const buy = await ws.buy(prop.proposal.id, prop.proposal.ask_price);
      const contractId = String(buy.buy.contract_id);
      const tradeRow = (await fnLogOpen({
        data: {
          decision_id: ai.decision_id,
          symbol: bot.symbol,
          side: ai.direction,
          stake,
          contract_id: contractId,
          buy_price: buy.buy.buy_price,
          payout: buy.buy.payout,
          take_profit: ai.take_profit,
          stop_loss: ai.stop_loss,
          account_type: bot.account_type,
        },
      })) as { id: string };
      // Settle async
      const unsub = await ws.subscribeOpenContract(Number(contractId), async (msg) => {
        const c = msg.proposal_open_contract;
        if (!c) return;
        if (c.is_sold || c.status === "sold" || c.status === "won" || c.status === "lost") {
          unsub();
          const pnl = Number(c.profit ?? 0);
          const exit = Number(c.exit_tick ?? c.sell_price ?? 0);
          const outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven";
          await fnLogClose({ data: { trade_id: tradeRow.id, exit_price: exit, pnl, outcome } });
          if (ai.decision_id) {
            await fnRecordOutcome({
              data: { decision_id: ai.decision_id, outcome, pnl, contract_id: contractId },
            });
          }
          await fnTick({ data: { id: bot.id, executed: true, pnl_delta: pnl } });
          load();
        }
      });
    } catch (e: any) {
      await fnTick({ data: { id: bot.id, executed: false, pnl_delta: 0, error: e?.message } });
    }
  };

  const startLoop = (bot: BotRow) => {
    if (loopsRef.current.has(bot.id)) return;
    runOneTick(bot);
    const handle = window.setInterval(() => runOneTick(bot), bot.interval_seconds * 1000);
    loopsRef.current.set(bot.id, handle);
  };

  // Auto-attach loops to running bots while page is open
  useEffect(() => {
    bots.forEach((b) => {
      if (b.status === "running") startLoop(b);
      else {
        const h = loopsRef.current.get(b.id);
        if (h) {
          clearInterval(h);
          loopsRef.current.delete(b.id);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots]);

  const onCreate = async () => {
    if (form.account_type === "real") {
      const ok = confirm("Start an autonomous bot trading REAL money? This will place live trades.");
      if (!ok) return;
    }
    const row = (await fnStart({
      data: {
        symbol: form.symbol,
        timeframe: "1m",
        account_type: form.account_type,
        market_mode: "synthetic",
        interval_seconds: form.interval_seconds,
        min_confidence: form.min_confidence,
        max_stake_per_trade: form.max_stake_per_trade,
      },
    })) as BotRow;
    setBots((p) => [row, ...p]);
    toast.success(`Bot started on ${row.symbol}`);
  };

  const onStop = async (id: string) => {
    const h = loopsRef.current.get(id);
    if (h) {
      clearInterval(h);
      loopsRef.current.delete(id);
    }
    await fnStop({ data: { id } });
    load();
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Autonomous Bots</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Each bot polls the market at its interval, asks the AI, and trades when confidence ≥
            threshold. The loop runs while this tab is open. Continuous server-side execution is on
            the next slice.
          </p>
        </header>

        <div className="glass rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold">New bot</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <Label className="text-xs">Symbol</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={form.symbol}
                onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              >
                {DERIV_SYMBOLS.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Account</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={form.account_type}
                onChange={(e) => setForm({ ...form, account_type: e.target.value as any })}
              >
                <option value="demo">Demo</option>
                <option value="real">Real</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Interval (s)</Label>
              <Input
                type="number"
                min={10}
                max={3600}
                value={form.interval_seconds}
                onChange={(e) => setForm({ ...form, interval_seconds: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className="text-xs">Min confidence</Label>
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={form.min_confidence}
                onChange={(e) => setForm({ ...form, min_confidence: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className="text-xs">Max stake / trade</Label>
              <Input
                type="number"
                step="0.5"
                min={0.35}
                value={form.max_stake_per_trade}
                onChange={(e) =>
                  setForm({ ...form, max_stake_per_trade: Number(e.target.value) })
                }
              />
            </div>
          </div>
          <Button onClick={onCreate} className="gap-1.5">
            <Play className="size-3.5" /> Start bot
          </Button>
        </div>

        <div className="space-y-3">
          {bots.map((b) => (
            <div key={b.id} className="glass rounded-xl p-4 flex items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Activity
                    className={`size-3.5 ${b.status === "running" ? "text-primary animate-pulse" : "text-muted-foreground"}`}
                  />
                  {b.symbol}
                  <Badge variant={b.account_type === "demo" ? "secondary" : "destructive"}>
                    {b.account_type}
                  </Badge>
                  <Badge variant="outline">{b.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  every {b.interval_seconds}s · min conf {(b.min_confidence * 100).toFixed(0)}% ·
                  max ${b.max_stake_per_trade} · trades {b.total_trades} · PnL{" "}
                  <span className={b.total_pnl >= 0 ? "text-bull" : "text-bear"}>
                    {b.total_pnl >= 0 ? "+" : ""}
                    {Number(b.total_pnl).toFixed(2)}
                  </span>
                  {b.last_error && <span className="text-bear ml-2">· {b.last_error}</span>}
                </p>
              </div>
              {b.status === "running" && (
                <Button size="sm" variant="destructive" onClick={() => onStop(b.id)} className="gap-1.5">
                  <Square className="size-3.5" /> Stop
                </Button>
              )}
            </div>
          ))}
          {!bots.length && (
            <p className="text-sm text-muted-foreground text-center py-12">No bots yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

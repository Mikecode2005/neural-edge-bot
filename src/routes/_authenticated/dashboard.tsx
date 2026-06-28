import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Activity,
  BarChart3,
  Brain,
  Cpu,
  LogOut,
  Plug,
  Power,
  Sparkles,
  Wallet,
  Zap,
} from "lucide-react";

import { MetricCard } from "@/components/dashboard/MetricCard";
import { SymbolSelector } from "@/components/dashboard/SymbolSelector";
import { PriceChart } from "@/components/dashboard/PriceChart";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import { getDerivWS, type DerivCandle } from "@/lib/deriv/ws";
import { analyze, type LiveAnalysis } from "@/lib/ob-fvg";
import { startDerivOAuth } from "@/lib/deriv/oauth";
import {
  getActiveDerivToken,
  listDerivAccounts,
  setActiveDerivAccount,
  disconnectDeriv,
} from "@/lib/deriv/connections.functions";
import { recordOutcome } from "@/lib/ai/qwen.functions";
import { analyzeMarketWithHfRouter } from "@/lib/ai/hf-router.client";
import { logTradeOpen, logTradeClose, checkRisk } from "@/lib/trading/execute.functions";
import { supabase } from "@/integrations/supabase/client";
import { fmtMoney, fmtPct } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — AI Trading Workstation" },
      {
        name: "description",
        content: "Live AI-driven Order Block + FVG trading on Deriv synthetics.",
      },
    ],
  }),
  component: Dashboard,
});

interface AIResult {
  decision_id?: string;
  direction: "CALL" | "PUT" | "NONE";
  confidence: number;
  stake: number | null;
  duration: number | null;
  duration_unit: string | null;
  take_profit: number | null;
  stop_loss: number | null;
  reasoning: string;
  lesson_added: boolean;
  model?: string;
}

interface AccountRow {
  id: string;
  loginid: string;
  account_type: "demo" | "real";
  currency: string;
  balance: number | null;
  is_active: boolean;
}

function Dashboard() {
  const navigate = useNavigate();
  const [symbol, setSymbol] = useState("R_10");
  const [candles, setCandles] = useState<DerivCandle[]>([]);
  const [livePrice, setLivePrice] = useState<number | null>(null);

  // Auth/account
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const [activeLogin, setActiveLogin] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"demo" | "real">("demo");
  const [activeCurrency, setActiveCurrency] = useState("USD");
  const [balance, setBalance] = useState<number | null>(null);

  // AI
  const [ai, setAi] = useState<AIResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [tradeBusy, setTradeBusy] = useState(false);
  const openTradeRowRef = useRef<{ id: string; decisionId?: string; contractId: string } | null>(
    null,
  );

  // server fns
  const fnListAccounts = useServerFn(listDerivAccounts);
  const fnGetToken = useServerFn(getActiveDerivToken);
  const fnSetActive = useServerFn(setActiveDerivAccount);
  const fnDisconnect = useServerFn(disconnectDeriv);
  const fnLogOpen = useServerFn(logTradeOpen);
  const fnLogClose = useServerFn(logTradeClose);
  const fnRecordOutcome = useServerFn(recordOutcome);
  const fnCheckRisk = useServerFn(checkRisk);

  // Load Deriv accounts + active token
  const loadConnections = async () => {
    try {
      const list = (await fnListAccounts()) as AccountRow[];
      setAccounts(list);
      const tok = (await fnGetToken()) as {
        loginid: string;
        token: string;
        account_type: "demo" | "real";
        currency: string;
      } | null;
      if (tok) {
        setActiveToken(tok.token);
        setActiveLogin(tok.loginid);
        setActiveType(tok.account_type);
        setActiveCurrency(tok.currency);
      } else {
        setActiveToken(null);
        setActiveLogin(null);
      }
    } catch (e: any) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadConnections();
  }, []);

  // Authorize Deriv WS when token available + subscribe balance
  useEffect(() => {
    if (!activeToken) return;
    const ws = getDerivWS();
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        await ws.authorize(activeToken);
        unsub = await ws.subscribeBalance((b) => {
          if (b.loginid === activeLogin) setBalance(b.balance);
        });
      } catch (e: any) {
        toast.error("Deriv authorize failed", { description: e.message });
      }
    })();
    return () => {
      unsub?.();
    };
  }, [activeToken, activeLogin]);

  // Load candles + subscribe ticks
  useEffect(() => {
    const ws = getDerivWS();
    let active = true;
    let unsub: (() => void) | null = null;
    setCandles([]);
    setLivePrice(null);
    (async () => {
      try {
        const c = await ws.fetchCandles(symbol, 60, 200);
        if (!active) return;
        setCandles(c);
        setLivePrice(c.at(-1)?.close ?? null);
        unsub = await ws.subscribeTicks(symbol, (t) => {
          setLivePrice(t.quote);
          setCandles((prev) => {
            if (!prev.length) return prev;
            const bucket = Math.floor(t.epoch / 60) * 60;
            const last = prev[prev.length - 1];
            if (bucket > last.epoch) {
              return [
                ...prev.slice(-199),
                { epoch: bucket, open: last.close, high: t.quote, low: t.quote, close: t.quote },
              ];
            }
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                high: Math.max(last.high, t.quote),
                low: Math.min(last.low, t.quote),
                close: t.quote,
              },
            ];
          });
        });
      } catch (e: any) {
        toast.error("Market data error", { description: e.message });
      }
    })();
    return () => {
      active = false;
      unsub?.();
    };
  }, [symbol]);

  const analysis: LiveAnalysis | null = useMemo(
    () => (candles.length >= 30 ? analyze(candles) : null),
    [candles],
  );

  const onConnectDeriv = () => startDerivOAuth();

  const onSwitchAccount = async (loginid: string) => {
    await fnSetActive({ data: { loginid } });
    await loadConnections();
    toast.success(`Switched to ${loginid}`);
  };

  const onDisconnect = async () => {
    await fnDisconnect();
    setAccounts([]);
    setActiveToken(null);
    setActiveLogin(null);
    setBalance(null);
    toast.message("Deriv accounts unlinked");
  };

  const onSignOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  };

  const onAnalyze = async () => {
    if (!analysis || !livePrice) {
      toast.error("Waiting for market data");
      return;
    }
    setAiBusy(true);
    setAi(null);
    try {
      const res = await analyzeMarketWithHfRouter({
        symbol,
        timeframe: "1m",
        candles: candles.slice(-60),
        analysis,
        currentPrice: livePrice,
        balance: balance ?? 1000,
      });
      setAi(res);
      if (res.direction === "NONE") {
        toast.message("AI says wait", { description: res.reasoning });
      } else {
        toast.success(`AI suggests ${res.direction} @ conf ${(res.confidence * 100).toFixed(0)}%`);
      }
    } catch (e: any) {
      toast.error("AI failed", { description: e.message });
    } finally {
      setAiBusy(false);
    }
  };

  const onExecute = async () => {
    if (!ai || ai.direction === "NONE" || !activeToken) return;
    setTradeBusy(true);
    try {
      const stake = Math.max(0.35, Math.min(ai.stake ?? 1, 100));

      // Risk gate
      const risk = (await fnCheckRisk({
        data: { proposed_stake: stake, account_type: activeType },
      })) as { ok: boolean; reason?: string };
      if (!risk.ok) {
        toast.error("Risk gate", { description: risk.reason });
        return;
      }

      const ws = getDerivWS();
      // Use rise/fall (CALL/PUT) on synthetic indices with duration in ticks/seconds
      const duration = ai.duration && ai.duration > 0 ? ai.duration : 5;
      const duration_unit = (ai.duration_unit as "t" | "s" | "m" | "h") || "t";

      const prop = await ws.proposal({
        symbol,
        amount: stake,
        contract_type: ai.direction,
        duration,
        duration_unit,
        basis: "stake",
        currency: activeCurrency,
      });
      if (!prop.proposal?.id) throw new Error("No proposal id");

      const buy = await ws.buy(prop.proposal.id, prop.proposal.ask_price);
      if (!buy.buy?.contract_id) throw new Error("Buy failed");

      const contractId = String(buy.buy.contract_id);
      const row = (await fnLogOpen({
        data: {
          decision_id: ai.decision_id,
          symbol,
          side: ai.direction,
          stake,
          contract_id: contractId,
          buy_price: buy.buy.buy_price,
          payout: buy.buy.payout,
          take_profit: ai.take_profit,
          stop_loss: ai.stop_loss,
          account_type: activeType,
        },
      })) as { id: string };
      openTradeRowRef.current = { id: row.id, decisionId: ai.decision_id, contractId };
      toast.success("Trade placed", { description: `Contract ${contractId}` });

      // Track contract until settlement
      const unsub = await ws.subscribeOpenContract(Number(contractId), async (msg) => {
        const c = msg.proposal_open_contract;
        if (!c) return;
        if (c.is_sold || c.status === "sold" || c.status === "won" || c.status === "lost") {
          unsub();
          const pnl = Number(c.profit ?? 0);
          const exit = Number(c.exit_tick ?? c.sell_price ?? livePrice ?? 0);
          const outcome: "win" | "loss" | "breakeven" =
            pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven";
          const ref = openTradeRowRef.current;
          if (ref) {
            await fnLogClose({ data: { trade_id: ref.id, exit_price: exit, pnl, outcome } });
            if (ref.decisionId) {
              await fnRecordOutcome({
                data: { decision_id: ref.decisionId, outcome, pnl, contract_id: ref.contractId },
              });
            }
            openTradeRowRef.current = null;
          }
          toast[outcome === "win" ? "success" : outcome === "loss" ? "error" : "message"](
            `Contract closed: ${outcome.toUpperCase()} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ${activeCurrency}`,
          );
        }
      });
    } catch (e: any) {
      toast.error("Execution failed", { description: e.message });
    } finally {
      setTradeBusy(false);
    }
  };

  const connected = !!activeToken;

  return (
    <div className="min-h-screen px-6 py-6 max-w-[1600px] mx-auto">
      <Toaster theme="dark" position="top-right" richColors />

      <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
            <Brain className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">AI Trading Workstation</h1>
            <p className="text-xs text-muted-foreground">
              Order Block + Fair Value Gap · Qwen 2.5 7B · Deriv synthetics
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {connected ? (
            <>
              <Badge
                variant={activeType === "demo" ? "secondary" : "destructive"}
                className="gap-1"
              >
                <Power className="size-3" />
                {activeType === "demo" ? "DEMO" : "REAL"} · {activeLogin}
              </Badge>
              {accounts.length > 1 && (
                <select
                  aria-label="Select active Deriv account"
                  className="bg-card border border-border rounded-md px-2 py-1 text-xs"
                  value={activeLogin ?? ""}
                  onChange={(e) => onSwitchAccount(e.target.value)}
                >
                  {accounts.map((a) => (
                    <option key={a.loginid} value={a.loginid}>
                      {a.loginid} ({a.account_type})
                    </option>
                  ))}
                </select>
              )}
              <Button size="sm" variant="ghost" onClick={onDisconnect}>
                Unlink
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={onConnectDeriv} className="gap-1.5">
              <Plug className="size-3.5" /> Connect Deriv
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onSignOut} className="gap-1">
            <LogOut className="size-3.5" /> Sign out
          </Button>
        </div>
      </header>

      {!connected && (
        <div className="glass rounded-xl p-4 mb-4 border border-primary/30 bg-primary/5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-medium">Link your Deriv account to start trading</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Live market data shows below using public feeds. Connect Deriv to see balance and
                place real (or demo) trades.
              </p>
            </div>
            <Button onClick={onConnectDeriv} className="gap-1.5">
              <Plug className="size-3.5" /> Connect with Deriv
            </Button>
          </div>
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <MetricCard
          label={connected ? `${activeType.toUpperCase()} Balance` : "Balance"}
          value={balance != null ? fmtMoney(balance) : connected ? "…" : "—"}
          sublabel={connected ? `${activeCurrency} · ${activeLogin}` : "Not connected"}
          icon={<Wallet className="size-3.5" />}
        />
        <MetricCard
          label="Live Price"
          value={livePrice != null ? livePrice.toFixed(4) : "—"}
          sublabel={symbol}
          icon={<Activity className="size-3.5" />}
        />
        <MetricCard
          label="AI Confidence"
          value={ai ? fmtPct(ai.confidence) : analysis ? fmtPct(analysis.confidence) : "—"}
          sublabel={`Signal · ${ai?.direction ?? analysis?.decision ?? "—"}`}
          tone={
            ai?.direction === "CALL" || analysis?.decision === "BUY"
              ? "bull"
              : ai?.direction === "PUT" || analysis?.decision === "SELL"
                ? "bear"
                : "warn"
          }
          icon={<Brain className="size-3.5" />}
        />
        <MetricCard
          label="Market Trend"
          value={analysis?.trend?.toUpperCase() ?? "—"}
          sublabel={
            analysis ? `EMA20 ${analysis.ema20.toFixed(4)} · RSI ${analysis.rsi14.toFixed(0)}` : ""
          }
          tone={analysis?.trend === "up" ? "bull" : "bear"}
          icon={<BarChart3 className="size-3.5" />}
        />
      </section>

      <div className="mb-4">
        <SymbolSelector value={symbol} onChange={setSymbol} />
      </div>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <PriceChart candles={candles} analysis={analysis} livePrice={livePrice} />
        </div>

        <div className="glass rounded-xl p-4 flex flex-col gap-3 min-h-[420px]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">AI Decision</h3>
            </div>
            <Badge variant="outline" className="text-[10px]">
              HF Router · Qwen 2.5 7B
            </Badge>
          </div>

          <Button onClick={onAnalyze} disabled={aiBusy || !analysis} className="gap-1.5">
            <Sparkles className="size-3.5" />
            {aiBusy ? "Analyzing…" : "Analyze market with AI"}
          </Button>

          {ai ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    ai.direction === "CALL"
                      ? "default"
                      : ai.direction === "PUT"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {ai.direction}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Confidence {(ai.confidence * 100).toFixed(0)}%
                </span>
                {ai.lesson_added && (
                  <Badge variant="outline" className="text-[10px]">
                    + lesson
                  </Badge>
                )}
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed border-l-2 border-primary/40 pl-3">
                {ai.reasoning || "No reasoning."}
              </p>

              {ai.direction !== "NONE" && (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-card/50 p-2 border border-border">
                    <p className="text-muted-foreground">Stake</p>
                    <p className="font-mono">{ai.stake?.toFixed(2) ?? "—"}</p>
                  </div>
                  <div className="rounded-md bg-card/50 p-2 border border-border">
                    <p className="text-muted-foreground">Duration</p>
                    <p className="font-mono">
                      {ai.duration} {ai.duration_unit}
                    </p>
                  </div>
                  <div className="rounded-md bg-card/50 p-2 border border-border">
                    <p className="text-muted-foreground">Take Profit</p>
                    <p className="font-mono">{ai.take_profit?.toFixed(4) ?? "—"}</p>
                  </div>
                  <div className="rounded-md bg-card/50 p-2 border border-border">
                    <p className="text-muted-foreground">Stop Loss</p>
                    <p className="font-mono">{ai.stop_loss?.toFixed(4) ?? "—"}</p>
                  </div>
                </div>
              )}

              {ai.direction !== "NONE" && (
                <Button
                  onClick={onExecute}
                  disabled={tradeBusy || !connected}
                  variant={ai.direction === "CALL" ? "default" : "destructive"}
                  className="gap-1.5"
                >
                  <Zap className="size-3.5" />
                  {tradeBusy
                    ? "Placing…"
                    : connected
                      ? `Execute ${ai.direction} on ${activeType.toUpperCase()}`
                      : "Connect Deriv to execute"}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Click "Analyze" — the frontend calls Hugging Face Router directly with your Vite HF
              token, then Qwen returns a structured prediction plus explanation.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Play,
  Square,
  Activity,
  Wallet,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Settings,
  Terminal,
  ExternalLink,
  Info,
  Target,
  Shield,
  BarChart3,
  Zap,
  Eye,
  EyeOff,
  Trash2,
} from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import { startBot, stopBot, listBots, tickBot, updateBotBalance, resetBotStats } from "@/lib/bots/bots.functions";
import { getActiveDerivToken } from "@/lib/deriv/connections.functions";
import { checkRisk, logTradeOpen, logTradeClose } from "@/lib/trading/execute.functions";
import { recordOutcome, analyzeMarket } from "@/lib/ai/qwen.functions";
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
  account_balance?: number;
}

interface ActivityEntry {
  id: string;
  timestamp: number;
  action: "SCAN" | "SKIP" | "ENTRY" | "EXIT" | "ERROR" | "PROTECTION";
  symbol: string;
  direction: "CALL" | "PUT" | "NONE" | "—";
  confidence: number;
  entryPrice: number | null;
  stake: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  duration: string | null;
  pnl: number | null;
  reasoning: string;
  obZone: string | null;
  fvgZone: string | null;
  riskCheck: string | null;
  trend: string | null;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
}

// Track active simulated trades in memory: mapped by botId -> trade details
interface SimulatedTrade {
  tradeId: string;
  direction: "CALL" | "PUT";
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  stake: number;
  candlesHeld: number;
  openedAt: number;
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
  const fnUpdateBalance = useServerFn(updateBotBalance);
  const fnResetStats = useServerFn(resetBotStats);
  const fnAnalyzeMarket = useServerFn(analyzeMarket);

  const [bots, setBots] = useState<BotRow[]>([]);
  const [form, setForm] = useState({
    symbol: "R_10",
    account_type: "simulated" as "simulated" | "demo" | "real",
    interval_seconds: 60,
    min_confidence: 0.7,
    max_stake_per_trade: 1,
    account_balance: 1000,
  });

  // Activity logs per bot
  const [activityLogs, setActivityLogs] = useState<Map<string, ActivityEntry[]>>(new Map());
  const [expandedBots, setExpandedBots] = useState<Set<string>>(new Set());
  const [editingBalance, setEditingBalance] = useState<string | null>(null);
  const [newBalance, setNewBalance] = useState("");
  const [showMt5Guide, setShowMt5Guide] = useState(false);

  // Simulated trades in-memory tracker
  const [simulatedTrades, setSimulatedTrades] = useState<Map<string, SimulatedTrade>>(new Map());

  const loopsRef = useRef<Map<string, number>>(new Map());
  const logIdRef = useRef(0);

  const addLog = useCallback((botId: string, entry: Omit<ActivityEntry, "id">) => {
    const id = `log-${++logIdRef.current}`;
    setActivityLogs((prev) => {
      const next = new Map(prev);
      const existing = next.get(botId) ?? [];
      next.set(botId, [{ ...entry, id }, ...existing].slice(0, 100)); // cap at 100 to prevent memory bloat
      return next;
    });
  }, []);

  const load = async () => setBots((await fnList()) as BotRow[]);
  useEffect(() => {
    load();
    return () => {
      loopsRef.current.forEach((id) => clearInterval(id));
    };
  }, []);

  const clearActivityLog = (botId: string) => {
    setActivityLogs((prev) => {
      const next = new Map(prev);
      next.delete(botId);
      return next;
    });
    toast.message("Activity log cleared");
  };

  const handleResetStats = async (botId: string) => {
    if (!confirm("Are you sure you want to reset trade count and P&L statistics for this bot?")) return;
    await fnResetStats({ data: { id: botId } });
    toast.success("Statistics reset successfully");
    load();
  };

  const runOneTick = async (bot: BotRow) => {
    const ts = Date.now();
    const isSimulated = bot.market_mode === "simulated";
    const currentBalance = (bot.account_balance ?? 1000) + (bot.total_pnl ?? 0);

    try {
      const ws = getDerivWS();
      const candles = await ws.fetchCandles(bot.symbol, 60, 200);
      if (candles.length < 30) {
        addLog(bot.id, {
          timestamp: ts, action: "SKIP", symbol: bot.symbol, direction: "—",
          confidence: 0, entryPrice: null, stake: null, stopLoss: null,
          takeProfit: null, duration: null, pnl: null,
          reasoning: "Not enough candles for analysis (<30)",
          obZone: null, fvgZone: null, riskCheck: null,
          trend: null, ema20: null, ema50: null, rsi14: null, atr14: null,
        });
        return;
      }
      const analysis = analyze(candles);
      const price = candles.at(-1)!.close;

      // ── SIMULATED TRADE SETTLEMENT ENGINE ──
      if (isSimulated && simulatedTrades.has(bot.id)) {
        const activeSim = simulatedTrades.get(bot.id)!;
        const exitPrice = price;
        const dirSign = activeSim.direction === "CALL" ? 1 : -1;
        const hitTP = activeSim.direction === "CALL" ? exitPrice >= activeSim.takeProfit : exitPrice <= activeSim.takeProfit;
        const hitSL = activeSim.direction === "CALL" ? exitPrice <= activeSim.stopLoss : exitPrice >= activeSim.stopLoss;
        const maxBarsReached = activeSim.candlesHeld >= 5; // typical hold limit

        if (hitTP || hitSL || maxBarsReached) {
          const won = hitTP || (!hitSL && (exitPrice - activeSim.entryPrice) * dirSign > 0);
          const pnl = won ? activeSim.stake * 0.85 : -activeSim.stake;
          const outcome = won ? "win" : "loss";

          addLog(bot.id, {
            timestamp: Date.now(), action: "EXIT", symbol: bot.symbol,
            direction: activeSim.direction, confidence: 0,
            entryPrice: activeSim.entryPrice, stake: activeSim.stake,
            stopLoss: activeSim.stopLoss, takeProfit: activeSim.takeProfit,
            duration: `${activeSim.candlesHeld}m`,
            pnl,
            reasoning: `Simulated Exit: ${outcome.toUpperCase()} at ${exitPrice.toFixed(4)}. SL/TP boundary touched. P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
            obZone: null, fvgZone: null,
            riskCheck: `Simulated settlement`,
            trend: analysis.trend, ema20: analysis.ema20, ema50: analysis.ema50,
            rsi14: analysis.rsi14, atr14: analysis.atr14,
          });

          await fnLogClose({ data: { trade_id: activeSim.tradeId, exit_price: exitPrice, pnl, outcome } });
          await fnTick({ data: { id: bot.id, executed: true, pnl_delta: pnl } });
          
          setSimulatedTrades((prev) => {
            const next = new Map(prev);
            next.delete(bot.id);
            return next;
          });
          load();
          return;
        } else {
          // Increment bar count held
          setSimulatedTrades((prev) => {
            const next = new Map(prev);
            const t = next.get(bot.id);
            if (t) t.candlesHeld += 1;
            return next;
          });
        }
      }

      // Check consecutive loss pause protection
      const logs = activityLogs.get(bot.id) ?? [];
      const exitTrades = logs.filter((l) => l.action === "EXIT");
      if (exitTrades.length >= 3) {
        const lastThreeLosing = exitTrades.slice(0, 3).every((t) => (t.pnl ?? 0) < 0);
        if (lastThreeLosing && bot.status === "running") {
          addLog(bot.id, {
            timestamp: ts, action: "PROTECTION", symbol: bot.symbol, direction: "—",
            confidence: 0, entryPrice: null, stake: null, stopLoss: null,
            takeProfit: null, duration: null, pnl: null,
            reasoning: "Consecutive loss protection activated (3 losses). Pausing bot.",
            obZone: null, fvgZone: null, riskCheck: "Active",
            trend: null, ema20: null, ema50: null, rsi14: null, atr14: null,
          });
          await fnStop({ data: { id: bot.id } });
          toast.warning("Bot paused due to consecutive loss protection");
          load();
          return;
        }
      }

      // Build OB/FVG info
      const obInfo = analysis.activeOB
        ? `${analysis.activeOB.kind} OB [${analysis.activeOB.bottom.toFixed(4)}, ${analysis.activeOB.top.toFixed(4)}]`
        : "None";
      const fvgInfo = analysis.activeFVG
        ? `${analysis.activeFVG.kind} FVG [${analysis.activeFVG.bottom.toFixed(4)}, ${analysis.activeFVG.top.toFixed(4)}]`
        : "None";

      // Call server-side Qwen which retrieves lessons and classifies setup
      const ai = await fnAnalyzeMarket({
        data: {
          symbol: bot.symbol,
          timeframe: bot.timeframe,
          candles: candles.slice(-60),
          ob_zones: [],
          fvg_zones: [],
          current_price: price,
          balance: currentBalance,
        }
      });

      if (ai.direction === "NONE" || ai.confidence < bot.min_confidence) {
        addLog(bot.id, {
          timestamp: ts, action: "SCAN", symbol: bot.symbol,
          direction: ai.direction, confidence: ai.confidence,
          entryPrice: price, stake: null,
          stopLoss: ai.stop_loss, takeProfit: ai.take_profit,
          duration: ai.duration && ai.duration_unit ? `${ai.duration}${ai.duration_unit}` : null,
          pnl: null,
          reasoning: ai.reasoning || `Confidence ${(ai.confidence * 100).toFixed(0)}% below threshold ${(bot.min_confidence * 100).toFixed(0)}%`,
          obZone: obInfo, fvgZone: fvgInfo,
          riskCheck: "N/A (no trade)",
          trend: analysis.trend, ema20: analysis.ema20, ema50: analysis.ema50,
          rsi14: analysis.rsi14, atr14: analysis.atr14,
        });
        await fnTick({ data: { id: bot.id, executed: false, pnl_delta: 0 } });
        return;
      }

      const stake = Math.max(0.35, Math.min(ai.stake ?? 1, bot.max_stake_per_trade));
      const risk = (await fnCheckRisk({
        data: { proposed_stake: stake, account_type: "demo" },
      })) as { ok: boolean; reason?: string };

      if (!risk.ok) {
        addLog(bot.id, {
          timestamp: ts, action: "SKIP", symbol: bot.symbol,
          direction: ai.direction, confidence: ai.confidence,
          entryPrice: price, stake,
          stopLoss: ai.stop_loss, takeProfit: ai.take_profit,
          duration: ai.duration && ai.duration_unit ? `${ai.duration}${ai.duration_unit}` : null,
          pnl: null,
          reasoning: `Risk gate blocked: ${risk.reason}`,
          obZone: obInfo, fvgZone: fvgInfo,
          riskCheck: `❌ ${risk.reason}`,
          trend: analysis.trend, ema20: analysis.ema20, ema50: analysis.ema50,
          rsi14: analysis.rsi14, atr14: analysis.atr14,
        });
        await fnTick({ data: { id: bot.id, executed: false, pnl_delta: 0, error: risk.reason } });
        return;
      }

      // ── EXECUTION PATH ──
      if (isSimulated) {
        // Simulated execution (Paper trade offline)
        const mockContractId = `sim-${Date.now()}`;
        const finalSL = ai.stop_loss ?? (ai.direction === "CALL" ? price - 1.0 * analysis.atr14 : price + 1.0 * analysis.atr14);
        const finalTP = ai.take_profit ?? (ai.direction === "CALL" ? price + 1.5 * analysis.atr14 : price - 1.5 * analysis.atr14);

        addLog(bot.id, {
          timestamp: ts, action: "ENTRY", symbol: bot.symbol,
          direction: ai.direction, confidence: ai.confidence,
          entryPrice: price, stake,
          stopLoss: finalSL, takeProfit: finalTP,
          duration: "Simulated", pnl: null,
          reasoning: ai.reasoning || "Paper trade entry",
          obZone: obInfo, fvgZone: fvgInfo,
          riskCheck: `✅ Passed (Simulated $${stake.toFixed(2)})`,
          trend: analysis.trend, ema20: analysis.ema20, ema50: analysis.ema50,
          rsi14: analysis.rsi14, atr14: analysis.atr14,
        });

        const tradeRow = (await fnLogOpen({
          data: {
            decision_id: ai.decision_id,
            symbol: bot.symbol,
            side: ai.direction,
            stake,
            contract_id: `simulated-${mockContractId}`,
            buy_price: price,
            payout: stake * 1.85,
            take_profit: finalTP,
            stop_loss: finalSL,
            account_type: "demo",
          },
        })) as { id: string };

        setSimulatedTrades((prev) => {
          const next = new Map(prev);
          next.set(bot.id, {
            tradeId: tradeRow.id,
            direction: ai.direction as "CALL" | "PUT",
            entryPrice: price,
            takeProfit: finalTP,
            stopLoss: finalSL,
            stake,
            candlesHeld: 0,
            openedAt: ts,
          });
          return next;
        });

      } else {
        // Live Deriv Execution (Requires login token)
        const tok = (await fnGetToken()) as { token: string; currency: string; loginid: string; account_type: string } | null;
        if (!tok || tok.account_type !== bot.account_type) {
          const err = `Active Deriv account not ${bot.account_type}`;
          addLog(bot.id, {
            timestamp: ts, action: "ERROR", symbol: bot.symbol,
            direction: ai.direction, confidence: ai.confidence,
            entryPrice: price, stake, stopLoss: ai.stop_loss, takeProfit: ai.take_profit,
            duration: null, pnl: null, reasoning: err,
            obZone: obInfo, fvgZone: fvgInfo, riskCheck: "Token mismatch",
            trend: analysis.trend, ema20: analysis.ema20, ema50: analysis.ema50,
            rsi14: analysis.rsi14, atr14: analysis.atr14,
          });
          await fnTick({ data: { id: bot.id, executed: false, pnl_delta: 0, error: err } });
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

        addLog(bot.id, {
          timestamp: ts, action: "ENTRY", symbol: bot.symbol,
          direction: ai.direction, confidence: ai.confidence,
          entryPrice: buy.buy.buy_price, stake,
          stopLoss: ai.stop_loss, takeProfit: ai.take_profit,
          duration: ai.duration && ai.duration_unit ? `${ai.duration}${ai.duration_unit}` : "5t",
          pnl: null,
          reasoning: ai.reasoning || "AI approved trade",
          obZone: obInfo, fvgZone: fvgInfo,
          riskCheck: `✅ Passed (stake $${stake.toFixed(2)})`,
          trend: analysis.trend, ema20: analysis.ema20, ema50: analysis.ema50,
          rsi14: analysis.rsi14, atr14: analysis.atr14,
        });

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

        // Settle async via WebSocket open contract stream
        const unsub = await ws.subscribeOpenContract(Number(contractId), async (msg) => {
          const c = msg.proposal_open_contract;
          if (!c) return;
          if (c.is_sold || c.status === "sold" || c.status === "won" || c.status === "lost") {
            unsub();
            const pnl = Number(c.profit ?? 0);
            const exit = Number(c.exit_tick ?? c.sell_price ?? 0);
            const outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven";

            addLog(bot.id, {
              timestamp: Date.now(), action: "EXIT", symbol: bot.symbol,
              direction: ai.direction, confidence: ai.confidence,
              entryPrice: buy.buy.buy_price, stake,
              stopLoss: ai.stop_loss, takeProfit: ai.take_profit,
              duration: ai.duration && ai.duration_unit ? `${ai.duration}${ai.duration_unit}` : "5t",
              pnl,
              reasoning: `Contract ${outcome.toUpperCase()} — exit at ${exit.toFixed(4)}, P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
              obZone: obInfo, fvgZone: fvgInfo,
              riskCheck: `Settled: ${outcome}`,
              trend: analysis.trend, ema20: analysis.ema20, ema50: analysis.ema50,
              rsi14: analysis.rsi14, atr14: analysis.atr14,
            });

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
      }
    } catch (e: any) {
      addLog(bot.id, {
        timestamp: ts, action: "ERROR", symbol: bot.symbol,
        direction: "—", confidence: 0,
        entryPrice: null, stake: null, stopLoss: null, takeProfit: null,
        duration: null, pnl: null,
        reasoning: e?.message || "Unknown error",
        obZone: null, fvgZone: null, riskCheck: "Error",
        trend: null, ema20: null, ema50: null, rsi14: null, atr14: null,
      });
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
    const isSimulated = form.account_type === "simulated";
    if (form.account_type === "real") {
      const ok = confirm("Start an autonomous bot trading REAL money? This will place live trades.");
      if (!ok) return;
    }
    const row = (await fnStart({
      data: {
        symbol: form.symbol,
        timeframe: "1m",
        account_type: isSimulated ? "demo" : form.account_type, // save as demo in DB if simulated to satisfy constraint
        market_mode: isSimulated ? "simulated" : "synthetic",
        interval_seconds: form.interval_seconds,
        min_confidence: form.min_confidence,
        max_stake_per_trade: form.max_stake_per_trade,
        account_balance: form.account_balance,
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

  const onUpdateBalance = async (botId: string) => {
    const val = parseFloat(newBalance);
    if (!val || val <= 0) {
      toast.error("Enter a valid balance");
      return;
    }
    await fnUpdateBalance({ data: { id: botId, account_balance: val } });
    setEditingBalance(null);
    setNewBalance("");
    toast.success("Balance updated");
    load();
  };

  const toggleExpand = (id: string) => {
    setExpandedBots((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Compute bot stats
  const getBotStats = (bot: BotRow) => {
    const logs = activityLogs.get(bot.id) ?? [];
    const trades = logs.filter((l) => l.action === "EXIT");
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const scans = logs.filter((l) => l.action === "SCAN").length;
    const entries = logs.filter((l) => l.action === "ENTRY").length;
    const errors = logs.filter((l) => l.action === "ERROR").length;

    // Compute peak balance & drawdown from trade sequence
    let peak = bot.account_balance ?? 1000;
    let current = peak;
    let maxDD = 0;
    for (const t of [...trades].reverse()) {
      current += t.pnl ?? 0;
      if (current > peak) peak = current;
      const dd = ((peak - current) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    return { wins, losses, winRate, scans, entries, errors, maxDD, trades: trades.length };
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Autonomous Bots</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Each bot polls the market at its interval, calls the Qwen AI models (with lessons recalled from memory),
            and trades when confidence ≥ threshold. The loop runs while this tab is open.
          </p>
        </header>

        {/* ── New Bot Form ── */}
        <div className="glass rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Play className="size-3.5 text-primary" /> New Bot
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
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
              <Label className="text-xs">Account / Execution Mode</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={form.account_type}
                onChange={(e) => setForm({ ...form, account_type: e.target.value as any })}
              >
                <option value="simulated">Local Simulated Demo (Paper trade)</option>
                <option value="demo">Deriv Virtual Demo Account</option>
                <option value="real">Deriv Live Real Account</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Account Balance ($)</Label>
              <Input
                type="number"
                min={1}
                step="100"
                value={form.account_balance}
                onChange={(e) => setForm({ ...form, account_balance: Number(e.target.value) })}
              />
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
              <Label className="text-xs">Min Confidence</Label>
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
              <Label className="text-xs">Max Stake / Trade</Label>
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
            <Play className="size-3.5" /> Start Bot
          </Button>
        </div>

        {/* ── Bot Cards ── */}
        <div className="space-y-4">
          {bots.map((b) => {
            const stats = getBotStats(b);
            const isExpanded = expandedBots.has(b.id);
            const logs = activityLogs.get(b.id) ?? [];
            const currentBalance = (b.account_balance ?? 1000) + (b.total_pnl ?? 0);
            const isSimulated = b.market_mode === "simulated";

            return (
              <div key={b.id} className="glass rounded-xl overflow-hidden">
                {/* Bot header */}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="space-y-2 flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium flex-wrap">
                        <Activity
                          className={`size-4 ${b.status === "running" ? "text-primary animate-pulse" : "text-muted-foreground"}`}
                        />
                        <span className="font-semibold text-base">{b.symbol}</span>
                        {isSimulated ? (
                          <Badge className="bg-primary/20 text-primary border-primary/30">
                            LOCAL SIMULATED
                          </Badge>
                        ) : (
                          <Badge variant={b.account_type === "demo" ? "secondary" : "destructive"}>
                            DERIV {b.account_type.toUpperCase()}
                          </Badge>
                        )}
                        <Badge variant="outline">{b.status}</Badge>
                        {b.status === "running" && (
                          <span className="text-xs text-primary">● Live Loop Running</span>
                        )}
                      </div>

                      {/* Quick stats row */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                        <MiniStat
                          icon={<Wallet className="size-3" />}
                          label="Balance"
                          value={`$${currentBalance.toFixed(2)}`}
                        />
                        <MiniStat
                          icon={<TrendingUp className="size-3" />}
                          label="P&L"
                          value={`${b.total_pnl >= 0 ? "+" : ""}${Number(b.total_pnl ?? 0).toFixed(2)}`}
                          tone={b.total_pnl >= 0 ? "bull" : "bear"}
                        />
                        <MiniStat
                          icon={<Target className="size-3" />}
                          label="Trades"
                          value={`${b.total_trades ?? 0}`}
                        />
                        <MiniStat
                          icon={<BarChart3 className="size-3" />}
                          label="Win Rate"
                          value={stats.trades > 0 ? `${stats.winRate.toFixed(0)}%` : "—"}
                          tone={stats.winRate >= 50 ? "bull" : stats.winRate > 0 ? "bear" : undefined}
                        />
                        <MiniStat
                          icon={<TrendingDown className="size-3" />}
                          label="Max DD"
                          value={stats.maxDD > 0 ? `${stats.maxDD.toFixed(1)}%` : "—"}
                          tone={stats.maxDD > 10 ? "bear" : undefined}
                        />
                        <MiniStat
                          icon={<Clock className="size-3" />}
                          label="Interval"
                          value={`${b.interval_seconds}s`}
                        />
                        <MiniStat
                          icon={<Shield className="size-3" />}
                          label="Min Conf"
                          value={`${(b.min_confidence * 100).toFixed(0)}%`}
                        />
                      </div>

                      {/* Errors */}
                      {b.last_error && (
                        <p className="text-xs text-bear flex items-center gap-1">
                          <AlertTriangle className="size-3" /> {b.last_error}
                        </p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-2 items-end shrink-0">
                      <div className="flex items-center gap-1.5">
                        {b.status === "running" && (
                          <Button size="sm" variant="destructive" onClick={() => onStop(b.id)} className="gap-1.5 h-8">
                            <Square className="size-3.5" /> Stop Bot
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => handleResetStats(b.id)}>
                          <RefreshCw className="size-3" /> Reset Stats
                        </Button>
                      </div>

                      {/* Balance edit */}
                      {editingBalance === b.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            className="w-24 h-7 text-xs"
                            placeholder="New balance"
                            value={newBalance}
                            onChange={(e) => setNewBalance(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && onUpdateBalance(b.id)}
                          />
                          <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={() => onUpdateBalance(b.id)}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => setEditingBalance(null)}>
                            ✕
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1 text-xs h-7"
                          onClick={() => {
                            setEditingBalance(b.id);
                            setNewBalance(String(b.account_balance ?? 1000));
                          }}
                        >
                          <Settings className="size-3" /> Update Balance
                        </Button>
                      )}

                      <div className="flex items-center gap-1.5">
                        {logs.length > 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1 text-xs h-7 text-bear/80 hover:text-bear"
                            onClick={() => clearActivityLog(b.id)}
                          >
                            <Trash2 className="size-3" /> Clear Logs
                          </Button>
                        )}

                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1 text-xs h-7"
                          onClick={() => toggleExpand(b.id)}
                        >
                          {isExpanded ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                          {isExpanded ? "Hide Activity" : "Show Activity"}
                          {logs.length > 0 && (
                            <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1">
                              {logs.length}
                            </Badge>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Activity feed */}
                {isExpanded && (
                  <div className="border-t border-border">
                    <div className="p-3 bg-card/30">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-xs font-semibold flex items-center gap-1.5">
                          <Terminal className="size-3 text-primary" /> Live Activity Feed (Calibrated Setup Classification)
                        </h4>
                        <span className="text-[10px] text-muted-foreground">
                          {logs.length} entries (session only)
                        </span>
                      </div>

                      {logs.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-4 text-center">
                          No activity yet. Bot will log here on each tick.
                        </p>
                      ) : (
                        <div className="max-h-[500px] overflow-y-auto space-y-1.5 pr-1">
                          {logs.map((entry) => (
                            <ActivityRow key={entry.id} entry={entry} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!bots.length && (
            <p className="text-sm text-muted-foreground text-center py-12">No bots yet.</p>
          )}
        </div>

        {/* ── MT5 Direct & Deriv Bot Demo Section ── */}
        <div className="glass rounded-xl overflow-hidden">
          <button
            onClick={() => setShowMt5Guide(!showMt5Guide)}
            className="w-full p-4 flex items-center justify-between hover:bg-card/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ExternalLink className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">MT5 Direct & Deriv Bot Demo</h2>
              <Badge variant="default" className="text-[10px]">NEW</Badge>
            </div>
            {showMt5Guide ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {showMt5Guide && (
            <div className="px-4 pb-5 border-t border-border space-y-4 pt-4">
              {/* Quick link to MT5 Direct page */}
              <div className="flex items-start gap-3 bg-primary/5 border border-primary/20 rounded-lg p-4">
                <Zap className="size-5 text-primary shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-semibold">Try the new MT5 Direct Page</p>
                  <p className="text-xs text-muted-foreground">
                    Connect directly to MetaTrader 5 from within the app — place orders, view positions,
                    and manage your MT5 account. No Python bridge needed.
                  </p>
                  <Button
                    size="sm"
                    variant="default"
                    className="mt-2 gap-1"
                    onClick={() => window.location.href = "/mt5-direct"}
                  >
                    <ExternalLink className="size-3.5" /> Open MT5 Direct
                  </Button>
                </div>
              </div>

              {/* Step 1 — Get Credentials */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <span className="size-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center">1</span>
                  Get MT5 Credentials from Deriv
                </h3>
                <div className="ml-7 text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <p>1. Log into <a href="https://app.deriv.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">app.deriv.com</a></p>
                  <p>2. Go to <strong>Trader's Hub</strong> → under "CFDs"</p>
                  <p>3. Click <strong>"Get"</strong> next to a demo MT5 account (Synthetic Indices or Financial)</p>
                  <p>4. Note your <strong>Login ID</strong>, <strong>Password</strong>, and <strong>Server</strong></p>
                  <p>5. Add them to <code className="bg-card px-1 rounded">.env</code> as <code className="bg-card px-1 rounded">MT5_ACCOUNT_LOGIN</code>, <code className="bg-card px-1 rounded">MT5_ACCOUNT_PASSWORD</code>, <code className="bg-card px-1 rounded">MT5_ACCOUNT_SERVER</code></p>
                </div>
              </div>

              {/* Step 2 — Node SDK (Primary) */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <span className="size-5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold flex items-center justify-center">2</span>
                  Connect via Node.js SDK <Badge variant="default" className="text-[10px]">Primary</Badge>
                </h3>
                <div className="ml-7 text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <p>The <code className="bg-card px-1 rounded">metatrader5-sdk</code> npm package connects to the MT5 Web API
                  without needing the MT5 terminal installed. Just configure credentials in .env and click
                  <strong> "Connect"</strong> on the MT5 Direct page.</p>
                </div>
              </div>

              {/* Step 3 — Python Bridge (Fallback) */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <span className="size-5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold flex items-center justify-center">3</span>
                  Python Bridge Fallback <Badge variant="outline" className="text-[10px]">Fallback</Badge>
                </h3>
                <div className="ml-7">
                  <div className="bg-card rounded-lg p-3 border border-border text-xs font-mono overflow-x-auto">
                    <pre className="text-muted-foreground">{`# Install dependencies
pip install MetaTrader5 fastapi uvicorn websockets

# Create bridge server (run.py)
from fastapi import FastAPI
from pydantic import BaseModel
import MetaTrader5 as mt5
import uvicorn

app = FastAPI()

class Creds(BaseModel):
    login: int
    password: str
    server: str

@app.post("/initialize")
async def init(creds: Creds):
    if not mt5.initialize():
        return {"status": "error", "detail": mt5.last_error()}
    authorized = mt5.login(creds.login, creds.password, creds.server)
    if not authorized:
        return {"status": "error", "detail": mt5.last_error()}
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8765)`}</pre>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Set <code className="bg-card px-1 rounded">MT5_LIB_MODE=python-bridge</code> in .env to use this path.
                  </p>
                </div>
              </div>

              {/* Architecture flow */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <span className="size-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center">4</span>
                  Trading Architecture
                </h3>
                <div className="ml-7 text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <div className="bg-card rounded-lg p-3 border border-border my-2">
                    <p className="font-mono text-center text-xs">
                      Bot Decision → AI Analysis → MT5 Direct API → MT5 Broker Server
                    </p>
                  </div>
                  <p>These bots use <strong>Deriv's WebSocket API</strong> for synthetic indices (R_10, R_25, etc.). 
                  The <strong>MT5 Direct</strong> page provides parallel access to MT5 accounts for CFDs & forex trading.</p>
                  <div className="flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-lg p-3 mt-2">
                    <Info className="size-4 text-primary shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      <strong className="text-foreground">Demo Mode:</strong> When the account type is set to 
                      <strong> "Local Simulated"</strong>, trades are executed in-memory without real money. 
                      Use this to test strategies before switching to Deriv demo or real accounts.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Subcomponents ── */

function MiniStat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div className="bg-card/50 rounded-lg px-2.5 py-1.5 border border-border/60">
      <div className="flex items-center gap-1 text-muted-foreground mb-0.5">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p
        className={`text-sm font-semibold numeric ${
          tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [expanded, setExpanded] = useState(false);

  const actionColors: Record<string, string> = {
    SCAN: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    SKIP: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    ENTRY: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    EXIT: entry.pnl && entry.pnl > 0
      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
      : "bg-red-500/15 text-red-400 border-red-500/30",
    ERROR: "bg-red-500/15 text-red-400 border-red-500/30",
    PROTECTION: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  };

  const directionColors: Record<string, string> = {
    CALL: "text-bull",
    PUT: "text-bear",
    NONE: "text-muted-foreground",
    "—": "text-muted-foreground",
  };

  return (
    <div className="bg-card/40 rounded-lg border border-border/40 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 text-xs hover:bg-card/60 transition-colors"
      >
        {/* Time */}
        <span className="text-muted-foreground numeric w-16 text-left shrink-0">
          {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>

        {/* Action badge */}
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${actionColors[entry.action] ?? ""} w-20 text-center shrink-0`}>
          {entry.action}
        </span>

        {/* Direction */}
        <span className={`font-semibold w-10 text-left shrink-0 ${directionColors[entry.direction] ?? ""}`}>
          {entry.direction}
        </span>

        {/* Confidence */}
        <span className="numeric w-10 text-left shrink-0">
          {entry.confidence > 0 ? `${(entry.confidence * 100).toFixed(0)}%` : "—"}
        </span>

        {/* Stake */}
        <span className="numeric w-12 text-left shrink-0">
          {entry.stake != null ? `$${entry.stake.toFixed(2)}` : "—"}
        </span>

        {/* P&L */}
        <span className={`numeric w-14 text-left shrink-0 font-semibold ${
          entry.pnl != null ? (entry.pnl >= 0 ? "text-bull" : "text-bear") : ""
        }`}>
          {entry.pnl != null ? `${entry.pnl >= 0 ? "+" : ""}${entry.pnl.toFixed(2)}` : "—"}
        </span>

        {/* Reasoning (truncated) */}
        <span className="text-muted-foreground truncate flex-1 text-left">
          {entry.reasoning.length > 80 ? entry.reasoning.slice(0, 80) + "…" : entry.reasoning}
        </span>

        {/* Expand icon */}
        {expanded ? (
          <ChevronUp className="size-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="size-3 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-border/30 pt-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
            <DetailCell label="Entry Price" value={entry.entryPrice?.toFixed(4) ?? "—"} />
            <DetailCell label="Stop Loss" value={entry.stopLoss?.toFixed(4) ?? "—"} />
            <DetailCell label="Take Profit" value={entry.takeProfit?.toFixed(4) ?? "—"} />
            <DetailCell label="Duration" value={entry.duration ?? "—"} />
            <DetailCell label="Trend" value={entry.trend?.toUpperCase() ?? "—"} />
            <DetailCell label="EMA 20" value={entry.ema20?.toFixed(4) ?? "—"} />
            <DetailCell label="EMA 50" value={entry.ema50?.toFixed(4) ?? "—"} />
            <DetailCell label="RSI 14" value={entry.rsi14?.toFixed(1) ?? "—"} />
            <DetailCell label="ATR 14" value={entry.atr14?.toFixed(5) ?? "—"} />
            <DetailCell label="Risk Check" value={entry.riskCheck ?? "—"} />
            <div className="col-span-2">
              <DetailCell label="Order Block" value={entry.obZone ?? "None"} />
            </div>
            <div className="col-span-2">
              <DetailCell label="Fair Value Gap" value={entry.fvgZone ?? "None"} />
            </div>
          </div>
          <div className="mt-2 pt-2 border-t border-border/30">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">AI Reasoning</p>
            <p className="text-xs text-foreground/80 leading-relaxed">{entry.reasoning}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-xs font-mono mt-0.5">{value}</p>
    </div>
  );
}

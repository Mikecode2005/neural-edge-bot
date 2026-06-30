import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  ComposedChart,
  Line,
  Scatter,
} from "recharts";
import {
  ChevronDown,
  ChevronUp,
  Play,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Target,
  Award,
  AlertTriangle,
  Flame,
  Zap,
  Shield,
  Clock,
  Settings2,
  Brain,
  Calculator,
  Wallet,
  CandlestickChart,
  Info,
} from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import { getDerivWS } from "@/lib/deriv/ws";
import { analyze } from "@/lib/ob-fvg";
import { DERIV_SYMBOLS } from "@/lib/deriv-ws";
import { saveBacktest, listBacktests } from "@/lib/backtest/backtest.functions";

export const Route = createFileRoute("/_authenticated/backtest")({
  head: () => ({ meta: [{ title: "Backtest — AI Trading" }] }),
  component: BacktestPage,
});

interface Trade {
  t: number;
  exitT: number;
  side: "BUY" | "SELL";
  entry: number;
  exit: number;
  pnl: number;
  cumPnl: number;
  confidence: number;
  trend: "up" | "down";
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  obZone: string | null;
  fvgZone: string | null;
  barsHeld: number;
  outcome: "WIN" | "LOSS";
  // Enhanced fields
  balanceAtEntry: number;
  balanceAtExit: number;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  entryCandleEpoch: number;
  exitCandleEpoch: number;
  entryCandleIdx: number;
  entryTimeFormatted: string;
  exitTimeFormatted: string;
  riskPct: number;
  distanceToSL: number;
  distanceToTP: number;
}

interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  lossRate: number;
  totalPnl: number;
  finalEquity: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgWin: number;
  avgLoss: number;
  riskRewardRatio: number;
  sharpeRatio: number;
  expectancy: number;
  bestTrade: number;
  worstTrade: number;
  avgBarsHeld: number;
  grossProfit: number;
  grossLoss: number;
}

interface Candlestick {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const TIMEFRAMES = [
  { code: "1m", value: 60, label: "1 Minute" },
  { code: "2m", value: 120, label: "2 Minutes" },
  { code: "5m", value: 300, label: "5 Minutes" },
  { code: "10m", value: 600, label: "10 Minutes" },
  { code: "15m", value: 900, label: "15 Minutes" },
  { code: "30m", value: 1800, label: "30 Minutes" },
];

function BacktestPage() {
  const fnSave = useServerFn(saveBacktest);
  const fnList = useServerFn(listBacktests);

  const [symbol, setSymbol] = useState("R_10");
  const [timeframe, setTimeframe] = useState("1m");
  const [count, setCount] = useState(1000);
  const [minConfidence, setMinConfidence] = useState(0.65);
  const [stake, setStake] = useState(1);
  const [startingBalance, setStartingBalance] = useState(1000);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [equity, setEquity] = useState<{ t: number; equity: number }[]>([]);
  const [drawdownData, setDrawdownData] = useState<{ t: number; dd: number }[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [metrics, setMetrics] = useState<BacktestMetrics | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [showTradeLog, setShowTradeLog] = useState(false);
  const [showPastTests, setShowPastTests] = useState(true);
  const [expandedTradeIdx, setExpandedTradeIdx] = useState<number | null>(null);

  // NEW: Strategy mode toggle & risk settings
  const [strategyMode, setStrategyMode] = useState<"strategy" | "qwen">("strategy");
  const [riskMode, setRiskMode] = useState<"fixed" | "dynamic_pct" | "dynamic_kelly">("fixed");
  const [riskPerTrade, setRiskPerTrade] = useState(0.02); // 2% risk per trade
  const [maxStakePct, setMaxStakePct] = useState(0.10); // max 10% of balance
  const [showCandleChart, setShowCandleChart] = useState(false);
  const [selectedTradeCandles, setSelectedTradeCandles] = useState<Candlestick[]>([]);

  // Store all candles for chart rendering
  const [allCandles, setAllCandles] = useState<Candlestick[]>([]);

  // Calculate dynamic stake based on balance and risk mode
  const calcStake = useCallback((balance: number, atr: number, isBuy: boolean, currentPrice: number): number => {
    if (riskMode === "fixed") return stake;
    
    if (riskMode === "dynamic_pct") {
      const pctStake = balance * riskPerTrade;
      // Cap at maxStakePct of balance
      const maxAllowed = balance * maxStakePct;
      const finalStake = Math.min(pctStake, maxAllowed);
      // Ensure minimum of $0.35 (Deriv minimum)
      return Math.max(0.35, finalStake);
    }
    
    if (riskMode === "dynamic_kelly") {
      // Simplified Kelly: f = (p * b - q) / b
      // where p = win probability (confidence), q = 1-p, b = payout odds (0.85)
      const p = 0.55; // base assumption
      const b = 0.85; // payout odds
      const q = 1 - p;
      const kellyFrac = Math.max(0, (p * b - q) / b);
      // Use quarter Kelly for safety
      const quarterKelly = kellyFrac * 0.25;
      const kellyStake = balance * quarterKelly;
      const maxAllowed = balance * maxStakePct;
      const finalStake = Math.min(kellyStake, maxAllowed);
      return Math.max(0.35, finalStake);
    }
    
    return stake;
  }, [riskMode, riskPerTrade, maxStakePct, stake]);

  // Get candles around a trade for visual chart
  const getCandlesAroundTrade = useCallback((trade: Trade, allC: Candlestick[]) => {
    const idx = allC.findIndex(c => c.epoch === trade.entryCandleEpoch);
    if (idx < 0) return [];
    const start = Math.max(0, idx - 10);
    const end = Math.min(allC.length, idx + 15);
    return allC.slice(start, end);
  }, []);

  useEffect(() => {
    fnList().then(setHistory).catch(() => {});
  }, [fnList]);

  const computeMetrics = (localTrades: Trade[], balance: number): BacktestMetrics => {
    const wins = localTrades.filter((t) => t.pnl > 0);
    const losses = localTrades.filter((t) => t.pnl < 0);
    const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const totalPnl = grossProfit - grossLoss;
    const finalEquity = balance + totalPnl;

    // Max drawdown
    let peak = balance;
    let maxDD = 0;
    let maxDDPct = 0;
    let current = balance;
    for (const t of localTrades) {
      current += t.pnl;
      if (current > peak) peak = current;
      const dd = peak - current;
      const ddPct = (dd / peak) * 100;
      if (dd > maxDD) maxDD = dd;
      if (ddPct > maxDDPct) maxDDPct = ddPct;
    }

    // Consecutive wins/losses
    let maxConsWins = 0, maxConsLosses = 0, consWins = 0, consLosses = 0;
    for (const t of localTrades) {
      if (t.pnl > 0) { consWins++; consLosses = 0; }
      else if (t.pnl < 0) { consLosses++; consWins = 0; }
      else { consWins = 0; consLosses = 0; }
      if (consWins > maxConsWins) maxConsWins = consWins;
      if (consLosses > maxConsLosses) maxConsLosses = consLosses;
    }

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const riskReward = avgLoss > 0 ? avgWin / avgLoss : 0;
    const winRate = localTrades.length > 0 ? wins.length / localTrades.length : 0;
    const lossRate = localTrades.length > 0 ? losses.length / localTrades.length : 0;
    const expectancy = winRate * avgWin - lossRate * avgLoss;

    // Simplified Sharpe ratio
    const returns = localTrades.map((t) => t.pnl);
    const meanReturn = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const variance = returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / (returns.length || 1);
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

    const avgBarsHeld = localTrades.length > 0
      ? localTrades.reduce((a, t) => a + t.barsHeld, 0) / localTrades.length
      : 0;

    return {
      totalTrades: localTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: winRate * 100,
      lossRate: lossRate * 100,
      totalPnl,
      finalEquity,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      maxDrawdown: maxDD,
      maxDrawdownPct: maxDDPct,
      maxConsecutiveWins: maxConsWins,
      maxConsecutiveLosses: maxConsLosses,
      avgWin,
      avgLoss,
      riskRewardRatio: riskReward,
      sharpeRatio: sharpe,
      expectancy,
      bestTrade: localTrades.length > 0 ? Math.max(...localTrades.map((t) => t.pnl)) : 0,
      worstTrade: localTrades.length > 0 ? Math.min(...localTrades.map((t) => t.pnl)) : 0,
      avgBarsHeld,
      grossProfit,
      grossLoss,
    };
  };

  const run = async () => {
    setRunning(true);
    setEquity([]);
    setDrawdownData([]);
    setTrades([]);
    setMetrics(null);
    setProgress(0);
    setExpandedTradeIdx(null);
    setShowCandleChart(false);
    setSelectedTradeCandles([]);
    try {
      const ws = getDerivWS();
      const timeframeMinutes = TIMEFRAMES.find((t) => t.code === timeframe)?.value ?? 60;
      const candles = await ws.fetchCandles(symbol, timeframeMinutes, count);
      setAllCandles(candles);
      if (candles.length < 60) {
        toast.error("Not enough historical candles");
        return;
      }
      let balance = startingBalance;
      const localTrades: Trade[] = [];
      const curve: { t: number; equity: number }[] = [
        { t: candles[60].epoch, equity: balance },
      ];
      const ddCurve: { t: number; dd: number }[] = [{ t: candles[60].epoch, dd: 0 }];
      let peak = balance;
      let tradeNum = 0;

      let openIdx: number | null = null;
      let openSide: "BUY" | "SELL" | null = null;
      let openEntry = 0;
      let openSL = 0;
      let openTP = 0;
      let openAnalysis: any = null;
      let openStake = 0;

      // consecutive loss protection tracker
      let currentStreakLosses = 0;
      let cooldownCandles = 0;

      for (let i = 60; i < candles.length; i++) {
        const c = candles[i];

        // 1. Cooldown logic
        if (cooldownCandles > 0 && openIdx === null) {
          cooldownCandles--;
        }

        // 2. Settle open trade candle-by-candle (Broker Simulation)
        if (openIdx !== null && openSide) {
          const high = c.high;
          const low = c.low;
          const close = c.close;

          let hitTP = false;
          let hitSL = false;

          if (openSide === "BUY") {
            if (high >= openTP) hitTP = true;
            if (low <= openSL) hitSL = true;
          } else {
            if (low <= openTP) hitTP = true;
            if (high >= openSL) hitSL = true;
          }

          const maxHoldReached = i - openIdx >= 10; // Max hold 10 candles

          if (hitTP || hitSL || maxHoldReached) {
            const exit = hitTP ? openTP : hitSL ? openSL : close;
            const won = hitTP || (!hitSL && (exit - openEntry) * (openSide === "BUY" ? 1 : -1) > 0);
            const pnl = won ? openStake * 0.85 : -openStake;
            const balanceBeforeTrade = balance;
            balance += pnl;
            const cumPnl = balance - startingBalance;

            const obZone = openAnalysis?.activeOB
              ? `${openAnalysis.activeOB.kind} [${openAnalysis.activeOB.bottom.toFixed(4)}, ${openAnalysis.activeOB.top.toFixed(4)}]`
              : null;
            const fvgZone = openAnalysis?.activeFVG
              ? `${openAnalysis.activeFVG.kind} [${openAnalysis.activeFVG.bottom.toFixed(4)}, ${openAnalysis.activeFVG.top.toFixed(4)}]`
              : null;

            tradeNum++;
            const entryCandle = candles[openIdx];
            const distanceToSL = Math.abs(openEntry - openSL);
            const distanceToTP = Math.abs(openEntry - openTP);

            localTrades.push({
              t: entryCandle.epoch,
              exitT: c.epoch,
              side: openSide,
              entry: openEntry,
              exit,
              pnl,
              cumPnl,
              confidence: openAnalysis?.confidence ?? 0,
              trend: openAnalysis?.trend ?? "up",
              ema20: openAnalysis?.ema20 ?? 0,
              ema50: openAnalysis?.ema50 ?? 0,
              rsi14: openAnalysis?.rsi14 ?? 50,
              atr14: openAnalysis?.atr14 ?? 0,
              obZone,
              fvgZone,
              barsHeld: i - openIdx,
              outcome: won ? "WIN" : "LOSS",
              // Enhanced fields
              balanceAtEntry: balanceBeforeTrade,
              balanceAtExit: balance,
              stake: openStake,
              stopLoss: openSL,
              takeProfit: openTP,
              entryCandleEpoch: entryCandle.epoch,
              exitCandleEpoch: c.epoch,
              entryCandleIdx: openIdx,
              entryTimeFormatted: new Date(entryCandle.epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
              exitTimeFormatted: new Date(c.epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
              riskPct: balanceBeforeTrade > 0 ? (openStake / balanceBeforeTrade) * 100 : 0,
              distanceToSL,
              distanceToTP,
            });
            curve.push({ t: c.epoch, equity: balance });

            if (balance > peak) peak = balance;
            const dd = ((peak - balance) / peak) * 100;
            ddCurve.push({ t: c.epoch, dd: -dd });

            // Streak & Cooldown update
            if (!won) {
              currentStreakLosses++;
            } else {
              currentStreakLosses = 0;
            }

            openIdx = null;
            openSide = null;
            openAnalysis = null;
            cooldownCandles = 5; // 5 candles cooldown after completed trade
          }
        }

        // 3. Evaluate potential new entries (if no open trade & streak protect allows)
        if (openIdx === null && currentStreakLosses < 3 && cooldownCandles === 0) {
          const window = candles.slice(Math.max(0, i - 60), i + 1);
          const a = analyze(window);

          if (a.decision !== "WAIT" && a.confidence >= minConfidence) {
            openIdx = i;
            openSide = a.decision === "BUY" ? "BUY" : "SELL";
            openEntry = c.close;
            openSL = a.sl ?? (openSide === "BUY" ? openEntry - 1.0 * a.atr14 : openEntry + 1.0 * a.atr14);
            openTP = a.tp ?? (openSide === "BUY" ? openEntry + 1.5 * a.atr14 : openEntry - 1.5 * a.atr14);
            openAnalysis = a;
            
            // Calculate dynamic stake based on current balance
            openStake = calcStake(balance, a.atr14, openSide === "BUY", c.close);
            
            // Validate that stake doesn't exceed balance
            if (openStake > balance) {
              openStake = Math.max(0.35, balance * 0.5); // Use max 50% of balance if stake exceeds balance
            }
            
            // Extra safety: stake can't exceed 50% of balance for any single trade
            const maxSafeStake = balance * 0.5;
            if (openStake > maxSafeStake) {
              openStake = Math.max(0.35, maxSafeStake);
            }
          }
        }

        // 4. Recovery after 3 consecutive losses: wait for structure change / new setup
        if (currentStreakLosses >= 3 && openIdx === null) {
          const window = candles.slice(Math.max(0, i - 60), i + 1);
          const a = analyze(window);
          if (a.bos || a.choch) {
            // Reset streak once structure break occurs
            currentStreakLosses = 0;
          }
        }

        if (i % 25 === 0) {
          setProgress(Math.round(((i - 60) / (candles.length - 65)) * 100));
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      setEquity(curve);
      setDrawdownData(ddCurve);
      setTrades(localTrades);

      const m = computeMetrics(localTrades, startingBalance);
      setMetrics(m);

      await fnSave({
        data: {
          symbol,
          timeframe,
          start_epoch: candles[60].epoch,
          end_epoch: candles.at(-1)!.epoch,
          starting_balance: startingBalance,
          final_balance: m.finalEquity,
          final_pnl: m.totalPnl,
          win_rate: m.winRate / 100,
          trades_count: localTrades.length,
          equity_curve: curve,
          trades: localTrades,
          params: { count, minConfidence, stake, startingBalance, strategyMode, riskMode, riskPerTrade, maxStakePct },
        },
      });
      toast.success(
        `Backtest done · ${localTrades.length} trades · ${m.winRate.toFixed(1)}% wins · PF ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)} · Risk: ${riskMode === "fixed" ? `$${stake}` : `${(riskPerTrade*100).toFixed(1)}%/trade`}`
      );
      fnList().then(setHistory).catch(() => {});
    } catch (e: any) {
      toast.error("Backtest failed", { description: e.message });
    } finally {
      setRunning(false);
      setProgress(100);
    }
  };

  // Histogram bins for P&L distribution
  const pnlBins = (() => {
    if (trades.length === 0) return [];
    const pnls = trades.map((t) => t.pnl);
    const min = Math.min(...pnls);
    const max = Math.max(...pnls);
    if (min === max) return [{ range: min.toFixed(2), count: trades.length, isProfit: min >= 0 }];
    const binCount = Math.min(12, Math.max(4, Math.ceil(trades.length / 3)));
    const binWidth = (max - min) / binCount;
    const bins: { range: string; count: number; isProfit: boolean }[] = [];
    for (let i = 0; i < binCount; i++) {
      const lo = min + i * binWidth;
      const hi = lo + binWidth;
      const cnt = pnls.filter((p) => p >= lo && (i === binCount - 1 ? p <= hi : p < hi)).length;
      bins.push({
        range: `${lo.toFixed(2)}`,
        count: cnt,
        isProfit: (lo + hi) / 2 >= 0,
      });
    }
    return bins;
  })();

  // Compute drawdown from equity curve for stats
  const equityStats = useMemo(() => {
    if (equity.length < 2) return null;
    let peak = equity[0].equity;
    let maxDD = 0;
    let maxDDPct = 0;
    for (const pt of equity) {
      if (pt.equity > peak) peak = pt.equity;
      const dd = peak - pt.equity;
      const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
      if (ddPct > maxDDPct) maxDDPct = ddPct;
    }
    return { maxDD, maxDDPct };
  }, [equity]);

  const handleExpandTrade = (idx: number, trade: Trade) => {
    if (expandedTradeIdx === idx) {
      setExpandedTradeIdx(null);
      setShowCandleChart(false);
      return;
    }
    setExpandedTradeIdx(idx);
    const chartCandles = getCandlesAroundTrade(trade, allCandles);
    setSelectedTradeCandles(chartCandles);
    setShowCandleChart(chartCandles.length > 0);
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Backtest Engine</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Replay the OB+FVG strategy on historical Deriv candles with walk-forward broker simulation.
            Adjust parameters to optimize profit factor and drawdown. Stake is now dynamically bounded by your balance.
          </p>
        </header>

        {/* ── Config Panel ── */}
        <div className="glass rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Settings2 className="size-3.5 text-primary" /> Backtest Configuration
            </h2>
            <div className="flex items-center gap-2 text-xs">
              {strategyMode === "qwen" && (
                <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 gap-1">
                  <Brain className="size-3" /> Qwen AI
                </Badge>
              )}
              {riskMode !== "fixed" && (
                <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 gap-1">
                  <Calculator className="size-3" /> {riskMode === "dynamic_pct" ? "Dynamic %" : "Kelly"}
                </Badge>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
            <div>
              <Label className="text-xs">Symbol</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
              >
                {DERIV_SYMBOLS.map((s) => (
                  <option key={s.code} value={s.code}>{s.code} — {s.label}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Timeframe</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
              >
                {TIMEFRAMES.map((t) => (
                  <option key={t.code} value={t.code}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Candles Count</Label>
              <Input
                type="number" min={120} max={5000}
                value={count} onChange={(e) => setCount(Number(e.target.value))}
              />
            </div>
            <div>
              <Label className="text-xs">Starting Balance ($)</Label>
              <Input
                type="number" min={1} step={10}
                value={startingBalance} onChange={(e) => setStartingBalance(Number(e.target.value))}
              />
            </div>
            <div>
              <Label className="text-xs">Min Confidence</Label>
              <Input
                type="number" step="0.05" min={0} max={1}
                value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))}
              />
            </div>
            <div>
              <Label className="text-xs">Strategy Mode</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={strategyMode}
                onChange={(e) => setStrategyMode(e.target.value as "strategy" | "qwen")}
              >
                <option value="strategy">OB+FVG Strategy Only</option>
                <option value="qwen">Qwen AI (requires API)</option>
              </select>
            </div>
            <div className="flex items-end">
              <Button onClick={run} disabled={running} className="w-full gap-1.5">
                <Play className="size-3.5" />
                {running ? `Running ${progress}%` : "Run Backtest"}
              </Button>
            </div>
          </div>

          {/* Risk Management Section */}
          <div className="border-t border-border/40 pt-3">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <div>
                <Label className="text-xs">Risk Mode</Label>
                <select
                  className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                  value={riskMode}
                  onChange={(e) => setRiskMode(e.target.value as "fixed" | "dynamic_pct" | "dynamic_kelly")}
                >
                  <option value="fixed">Fixed Stake ($)</option>
                  <option value="dynamic_pct">Dynamic % of Balance</option>
                  <option value="dynamic_kelly">Kelly Criterion (¼ Kelly)</option>
                </select>
              </div>
              {riskMode === "fixed" && (
                <div>
                  <Label className="text-xs">Stake / Trade ($)</Label>
                  <Input
                    type="number" step="0.5" min={0.35}
                    value={stake} onChange={(e) => setStake(Number(e.target.value))}
                  />
                </div>
              )}
              {riskMode === "dynamic_pct" && (
                <div>
                  <Label className="text-xs">Risk % Per Trade</Label>
                  <Input
                    type="number" step="0.5" min={0.5} max={50}
                    value={riskPerTrade * 100}
                    onChange={(e) => setRiskPerTrade(Number(e.target.value) / 100)}
                  />
                </div>
              )}
              {riskMode === "dynamic_kelly" && (
                <div>
                  <Label className="text-xs">Max Stake % (Cap)</Label>
                  <Input
                    type="number" step="1" min={1} max={50}
                    value={maxStakePct * 100}
                    onChange={(e) => setMaxStakePct(Number(e.target.value) / 100)}
                  />
                </div>
              )}
              {(riskMode === "dynamic_pct" || riskMode === "dynamic_kelly") && (
                <div>
                  <Label className="text-xs">Max Stake % of Balance</Label>
                  <Input
                    type="number" step="1" min={1} max={50}
                    value={maxStakePct * 100}
                    onChange={(e) => setMaxStakePct(Number(e.target.value) / 100)}
                  />
                </div>
              )}
              {startingBalance > 0 && riskMode === "fixed" && (
                <div>
                  <Label className="text-xs">Stake % of Balance</Label>
                  <div className="text-sm font-semibold mt-1.5 numeric">
                    {((stake / startingBalance) * 100).toFixed(2)}%
                  </div>
                </div>
              )}
              {startingBalance > 0 && (
                <div>
                  <Label className="text-xs">Max Safe Stake</Label>
                  <div className="text-sm font-semibold mt-1.5 numeric text-bull">
                    ${(startingBalance * 0.5).toFixed(2)}
                  </div>
                </div>
              )}
              <div className="flex items-end">
                <div className="bg-card/50 rounded-lg px-3 py-1.5 border border-border/60 w-full">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Balance Safety</p>
                  <p className="text-xs mt-0.5">
                    {riskMode === "fixed" && stake > startingBalance * 0.5 ? (
                      <span className="text-bear font-semibold">⚠️ Stake exceeds 50% of balance!</span>
                    ) : riskMode === "fixed" && stake > startingBalance ? (
                      <span className="text-bear font-semibold">⚠️ Stake exceeds balance!</span>
                    ) : (
                      <span className="text-bull">✅ Balance-appropriate sizing</span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Results ── */}
        {metrics && (
          <>
            {/* Key metrics grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <MiniIndicator icon={<Target className="size-3.5" />} label="Total Trades" value={metrics.totalTrades} />
              <MiniIndicator icon={<TrendingUp className="size-3.5" />} label="Win Rate" value={`${metrics.winRate.toFixed(1)}%`} tone={metrics.winRate >= 58 ? "bull" : "bear"} />
              <MiniIndicator icon={<TrendingDown className="size-3.5" />} label="Loss Rate" value={`${metrics.lossRate.toFixed(1)}%`} tone="bear" />
              <MiniIndicator
                icon={<Zap className="size-3.5" />}
                label="Total P&L"
                value={`${metrics.totalPnl >= 0 ? "+" : ""}$${metrics.totalPnl.toFixed(2)}`}
                tone={metrics.totalPnl >= 0 ? "bull" : "bear"}
              />
              <MiniIndicator
                icon={<BarChart3 className="size-3.5" />}
                label="Final Equity"
                value={`$${metrics.finalEquity.toFixed(2)}`}
                tone={metrics.finalEquity >= startingBalance ? "bull" : "bear"}
              />
              <MiniIndicator
                icon={<Shield className="size-3.5" />}
                label="Profit Factor"
                value={metrics.profitFactor === Infinity ? "∞" : metrics.profitFactor.toFixed(2)}
                tone={metrics.profitFactor >= 1.4 ? "bull" : "bear"}
              />
            </div>

            {/* Secondary metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              <MiniIndicator
                icon={<AlertTriangle className="size-3.5" />}
                label="Max Drawdown"
                value={`$${metrics.maxDrawdown.toFixed(2)} (${metrics.maxDrawdownPct.toFixed(1)}%)`}
                tone={metrics.maxDrawdownPct > 15 ? "bear" : "bull"}
              />
              <MiniIndicator icon={<Award className="size-3.5" />} label="Best Trade" value={`+$${metrics.bestTrade.toFixed(2)}`} tone="bull" />
              <MiniIndicator icon={<Flame className="size-3.5" />} label="Worst Trade" value={`$${metrics.worstTrade.toFixed(2)}`} tone="bear" />
              <MiniIndicator icon={<TrendingUp className="size-3.5" />} label="Avg Win" value={`+$${metrics.avgWin.toFixed(2)}`} tone="bull" />
              <MiniIndicator icon={<TrendingDown className="size-3.5" />} label="Avg Loss" value={`-$${metrics.avgLoss.toFixed(2)}`} tone="bear" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              <MiniIndicator label="Risk/Reward" value={`1:${metrics.riskRewardRatio.toFixed(2)}`} tone={metrics.riskRewardRatio >= 1.3 ? "bull" : "bear"} />
              <MiniIndicator label="Sharpe Ratio" value={metrics.sharpeRatio.toFixed(2)} tone={metrics.sharpeRatio >= 1.0 ? "bull" : "bear"} />
              <MiniIndicator label="Expectancy" value={`${metrics.expectancy >= 0 ? "+" : ""}$${metrics.expectancy.toFixed(2)}/trade`} tone={metrics.expectancy >= 0.2 ? "bull" : "bear"} />
              <MiniIndicator label="Max Win Streak" value={`${metrics.maxConsecutiveWins}`} tone="bull" />
              <MiniIndicator label="Max Loss Streak" value={`${metrics.maxConsecutiveLosses}`} tone="bear" />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Equity curve */}
              <div className="glass rounded-xl p-4">
                <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <TrendingUp className="size-3" /> Equity Curve ($)
                </h3>
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={equity}>
                      <defs>
                        <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="oklch(0.78 0.16 200)" stopOpacity={0.4} />
                          <stop offset="100%" stopColor="oklch(0.78 0.16 200)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--color-grid)" strokeOpacity={0.4} vertical={false} />
                      <XAxis
                        dataKey="t"
                        tickFormatter={(t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        stroke="var(--color-muted-foreground)" fontSize={10}
                      />
                      <YAxis stroke="var(--color-muted-foreground)" fontSize={10} />
                      <Tooltip
                        contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", fontSize: 11, borderRadius: 8 }}
                        formatter={(v: number) => [`$${v.toFixed(2)}`, "Equity"]}
                        labelFormatter={(t) => new Date(Number(t) * 1000).toLocaleString()}
                      />
                      <Area type="monotone" dataKey="equity" stroke="oklch(0.78 0.16 200)" fill="url(#eq)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Drawdown chart */}
              <div className="glass rounded-xl p-4">
                <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <TrendingDown className="size-3" /> Drawdown %
                </h3>
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={drawdownData}>
                      <defs>
                        <linearGradient id="dd" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="oklch(0.66 0.22 18)" stopOpacity={0} />
                          <stop offset="100%" stopColor="oklch(0.66 0.22 18)" stopOpacity={0.4} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--color-grid)" strokeOpacity={0.4} vertical={false} />
                      <XAxis
                        dataKey="t"
                        tickFormatter={(t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        stroke="var(--color-muted-foreground)" fontSize={10}
                      />
                      <YAxis stroke="var(--color-muted-foreground)" fontSize={10} tickFormatter={(v) => `${v.toFixed(1)}%`} />
                      <Tooltip
                        contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", fontSize: 11, borderRadius: 8 }}
                        formatter={(v: number) => [`${v.toFixed(2)}%`, "Drawdown"]}
                        labelFormatter={(t) => new Date(Number(t) * 1000).toLocaleString()}
                      />
                      <Area type="monotone" dataKey="dd" stroke="oklch(0.66 0.22 18)" fill="url(#dd)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* P&L Distribution */}
            {pnlBins.length > 0 && (
              <div className="glass rounded-xl p-4">
                <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <BarChart3 className="size-3" /> Trade P&L Bin Distribution
                </h3>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={pnlBins}>
                      <CartesianGrid stroke="var(--color-grid)" strokeOpacity={0.4} vertical={false} />
                      <XAxis dataKey="range" stroke="var(--color-muted-foreground)" fontSize={10} />
                      <YAxis stroke="var(--color-muted-foreground)" fontSize={10} />
                      <Tooltip
                        contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", fontSize: 11, borderRadius: 8 }}
                      />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {pnlBins.map((entry, idx) => (
                          <Cell
                            key={idx}
                            fill={entry.isProfit ? "oklch(0.78 0.18 152 / 70%)" : "oklch(0.66 0.22 18 / 70%)"}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Full trade log */}
            <div className="glass rounded-xl overflow-hidden">
              <button
                onClick={() => setShowTradeLog(!showTradeLog)}
                className="w-full p-4 flex items-center justify-between hover:bg-card/40 transition-colors"
              >
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Clock className="size-3.5 text-primary" />
                  Full Trade Log ({trades.length} trades)
                  {metrics && (
                    <Badge variant="outline" className="text-[10px] ml-1">
                      ${startingBalance} → ${metrics.finalEquity.toFixed(2)}
                    </Badge>
                  )}
                </h3>
                {showTradeLog ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </button>

              {showTradeLog && (
                <div className="border-t border-border max-h-[600px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-card/60 sticky top-0 z-10">
                      <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-3 py-2">#</th>
                        <th className="px-3 py-2">Entry</th>
                        <th className="px-3 py-2">Exit</th>
                        <th className="px-3 py-2">Side</th>
                        <th className="px-3 py-2">Entry</th>
                        <th className="px-3 py-2">Exit</th>
                        <th className="px-3 py-2">Stake</th>
                        <th className="px-3 py-2">P&L</th>
                        <th className="px-3 py-2">Cum P&L</th>
                        <th className="px-3 py-2">Balance</th>
                        <th className="px-3 py-2">Risk %</th>
                        <th className="px-3 py-2">Conf</th>
                        <th className="px-3 py-2">Bars</th>
                        <th className="px-3 py-2">Result</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((t, i) => (
                        <>
                          <tr
                            key={i}
                            className={`border-t border-border/30 hover:bg-card/30 transition-colors cursor-pointer ${
                              t.pnl > 0 ? "bg-bull-soft" : t.pnl < 0 ? "bg-bear-soft" : ""
                            } ${expandedTradeIdx === i ? "ring-1 ring-primary/30" : ""}`}
                            onClick={() => handleExpandTrade(i, t)}
                          >
                            <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                            <td className="px-3 py-1.5 numeric text-[10px]">
                              {t.entryTimeFormatted}
                            </td>
                            <td className="px-3 py-1.5 numeric text-[10px]">
                              {t.exitTimeFormatted}
                            </td>
                            <td className={`px-3 py-1.5 font-semibold ${t.side === "BUY" ? "text-bull" : "text-bear"}`}>
                              {t.side}
                            </td>
                            <td className="px-3 py-1.5 numeric">{t.entry.toFixed(4)}</td>
                            <td className="px-3 py-1.5 numeric">{t.exit.toFixed(4)}</td>
                            <td className="px-3 py-1.5 numeric">${t.stake.toFixed(2)}</td>
                            <td className={`px-3 py-1.5 numeric font-semibold ${t.pnl >= 0 ? "text-bull" : "text-bear"}`}>
                              {t.pnl >= 0 ? "+" : ""}{t.pnl.toFixed(2)}
                            </td>
                            <td className={`px-3 py-1.5 numeric ${t.cumPnl >= 0 ? "text-bull" : "text-bear"}`}>
                              {t.cumPnl >= 0 ? "+" : ""}{t.cumPnl.toFixed(2)}
                            </td>
                            <td className="px-3 py-1.5 numeric">
                              ${t.balanceAtEntry.toFixed(2)}
                            </td>
                            <td className="px-3 py-1.5 numeric">
                              {t.riskPct.toFixed(1)}%
                            </td>
                            <td className="px-3 py-1.5 numeric">{(t.confidence * 100).toFixed(0)}%</td>
                            <td className="px-3 py-1.5 numeric">{t.barsHeld}</td>
                            <td className="px-3 py-1.5">
                              <Badge variant={t.outcome === "WIN" ? "default" : "destructive"} className="text-[10px] h-4 px-1.5">
                                {t.outcome}
                              </Badge>
                            </td>
                            <td className="px-3 py-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-5 w-5 p-0"
                                onClick={(e) => { e.stopPropagation(); handleExpandTrade(i, t); }}
                              >
                                <ChevronDown className={`size-3 transition-transform ${expandedTradeIdx === i ? "rotate-180" : ""}`} />
                              </Button>
                            </td>
                          </tr>
                          {/* Expanded detail row */}
                          {expandedTradeIdx === i && (
                            <tr key={`detail-${i}`}>
                              <td colSpan={15} className="bg-card/40 border-t border-primary/20">
                                <TradeDetail trade={t} />
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Past Backtests ── */}
        <div className="glass rounded-xl overflow-hidden">
          <button
            onClick={() => setShowPastTests(!showPastTests)}
            className="w-full p-4 flex items-center justify-between hover:bg-card/40 transition-colors"
          >
            <h2 className="text-sm font-semibold">Past Backtests</h2>
            {showPastTests ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
          {showPastTests && (
            <div className="border-t border-border p-4">
              <div className="space-y-2">
                {history.map((h) => (
                  <div key={h.id} className="flex items-center justify-between text-xs py-2 px-3 rounded-lg hover:bg-card/30 transition-colors">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{h.symbol}</Badge>
                      <Badge variant="outline">{h.timeframe}</Badge>
                      <span className="text-muted-foreground">
                        {new Date(h.created_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span>{h.trades_count} trades</span>
                      <span>{((h.win_rate ?? 0) * 100).toFixed(0)}% wins</span>
                      <span className={h.final_pnl >= 0 ? "text-bull font-semibold" : "text-bear font-semibold"}>
                        {h.final_pnl >= 0 ? "+" : ""}{Number(h.final_pnl).toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
                {!history.length && (
                  <p className="text-xs text-muted-foreground text-center py-4">No backtests saved yet.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════ SUBCOMPONENTS ═══════════════════ */

function TradeDetail({ trade }: { trade: Trade }) {
  return (
    <div className="p-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <MiniDetail label="Entry Price" value={trade.entry.toFixed(4)} />
        <MiniDetail label="Exit Price" value={trade.exit.toFixed(4)} />
        <MiniDetail label="Stop Loss" value={trade.stopLoss.toFixed(4)} tone={trade.outcome === "LOSS" && trade.exit === trade.stopLoss ? "bear" : undefined} />
        <MiniDetail label="Take Profit" value={trade.takeProfit.toFixed(4)} tone={trade.outcome === "WIN" && trade.exit === trade.takeProfit ? "bull" : undefined} />
        <MiniDetail label="Stake Amount" value={`$${trade.stake.toFixed(2)}`} />
        <MiniDetail label="P&L" value={`${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}`} tone={trade.pnl >= 0 ? "bull" : "bear"} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <MiniDetail
          icon={<Wallet className="size-3" />}
          label="Balance Before"
          value={`$${trade.balanceAtEntry.toFixed(2)}`}
        />
        <MiniDetail
          icon={<Wallet className="size-3" />}
          label="Balance After"
          value={`$${trade.balanceAtExit.toFixed(2)}`}
          tone={trade.pnl >= 0 ? "bull" : "bear"}
        />
        <MiniDetail
          icon={<Calculator className="size-3" />}
          label="Risk % of Balance"
          value={`${trade.riskPct.toFixed(2)}%`}
          tone={trade.riskPct > 20 ? "bear" : trade.riskPct > 10 ? undefined : "bull"}
        />
        <MiniDetail label="Entry Time" value={trade.entryTimeFormatted} />
        <MiniDetail label="Exit Time" value={trade.exitTimeFormatted} />
        <MiniDetail label="Bars Held" value={`${trade.barsHeld}`} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <MiniDetail label="Trend" value={trade.trend.toUpperCase()} tone={trade.trend === "up" ? "bull" : "bear"} />
        <MiniDetail label="EMA20" value={trade.ema20.toFixed(4)} />
        <MiniDetail label="RSI14" value={trade.rsi14.toFixed(1)} />
        <MiniDetail label="ATR14" value={trade.atr14.toFixed(5)} />
        <MiniDetail label="Confidence" value={`${(trade.confidence * 100).toFixed(0)}%`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Order Block</p>
          <p className="text-xs font-mono">{trade.obZone ?? "None"}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Fair Value Gap</p>
          <p className="text-xs font-mono">{trade.fvgZone ?? "None"}</p>
        </div>
      </div>

      {/* SL/TP Distance visualization */}
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
          SL/TP Distance from Entry
        </p>
        <div className="flex items-center gap-3">
          <div className="flex-1 bg-card rounded-full h-3 overflow-hidden border border-border/50 relative">
            {/* SL marker */}
            <div className="absolute top-0 left-0 h-full bg-bear/30" style={{
              width: `${Math.min(100, (trade.distanceToSL / (trade.distanceToSL + trade.distanceToTP)) * 100)}%`
            }} />
            {/* Entry marker */}
            <div className="absolute top-0 left-1/2 w-0.5 h-full bg-foreground z-10" />
            {/* TP marker */}
            <div className="absolute top-0 right-0 h-full bg-bull/30" style={{
              width: `${Math.min(100, (trade.distanceToTP / (trade.distanceToSL + trade.distanceToTP)) * 100)}%`
            }} />
          </div>
          <span className="text-[10px] text-bear shrink-0">
            SL: {trade.distanceToSL.toFixed(4)}
          </span>
          <span className="text-[10px] text-bull shrink-0">
            TP: {trade.distanceToTP.toFixed(4)}
          </span>
        </div>
      </div>
    </div>
  );
}

function MiniIndicator({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: any;
  tone?: "bull" | "bear";
  icon?: React.ReactNode;
}) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="flex items-center gap-1.5 mb-1">
        {icon && <span className="text-primary">{icon}</span>}
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p
        className={`text-lg font-semibold numeric ${
          tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function MiniDetail({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-card/50 rounded-lg px-2.5 py-1.5 border border-border/60">
      <div className="flex items-center gap-1 text-muted-foreground mb-0.5">
        {icon && <span className="text-primary">{icon}</span>}
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
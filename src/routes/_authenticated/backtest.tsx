import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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

function BacktestPage() {
  const fnSave = useServerFn(saveBacktest);
  const fnList = useServerFn(listBacktests);

  const [symbol, setSymbol] = useState("R_10");
  const [count, setCount] = useState(500);
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

    // Simplified Sharpe ratio (mean return / std dev of returns)
    const returns = localTrades.map((t) => t.pnl);
    const meanReturn = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const variance = returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / (returns.length || 1);
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0; // annualized

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
    try {
      const ws = getDerivWS();
      const candles = await ws.fetchCandles(symbol, 60, count);
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

      let openIdx: number | null = null;
      let openSide: "BUY" | "SELL" | null = null;
      let openEntry = 0;
      let openAnalysis: any = null;

      for (let i = 60; i < candles.length - 5; i++) {
        const window = candles.slice(Math.max(0, i - 60), i + 1);
        const a = analyze(window);
        const c = candles[i];

        // settle any open trade after 5 bars
        if (openIdx != null && openSide && i - openIdx >= 5) {
          const exit = candles[i].close;
          const dir = openSide === "BUY" ? 1 : -1;
          const win = (exit - openEntry) * dir > 0;
          const pnl = win ? stake * 0.85 : -stake;
          balance += pnl;
          const cumPnl = balance - startingBalance;

          const obZone = openAnalysis?.activeOB
            ? `${openAnalysis.activeOB.kind} [${openAnalysis.activeOB.bottom.toFixed(4)}, ${openAnalysis.activeOB.top.toFixed(4)}]`
            : null;
          const fvgZone = openAnalysis?.activeFVG
            ? `${openAnalysis.activeFVG.kind} [${openAnalysis.activeFVG.bottom.toFixed(4)}, ${openAnalysis.activeFVG.top.toFixed(4)}]`
            : null;

          localTrades.push({
            t: candles[openIdx].epoch,
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
          });
          curve.push({ t: c.epoch, equity: balance });

          if (balance > peak) peak = balance;
          const dd = ((peak - balance) / peak) * 100;
          ddCurve.push({ t: c.epoch, dd: -dd }); // negative for visual

          openIdx = null;
          openSide = null;
          openAnalysis = null;
        }

        if (openIdx == null && a.decision !== "WAIT" && a.confidence >= minConfidence) {
          openIdx = i;
          openSide = a.decision;
          openEntry = c.close;
          openAnalysis = a;
        }

        if (i % 20 === 0) {
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
          timeframe: "1m",
          start_epoch: candles[60].epoch,
          end_epoch: candles.at(-1)!.epoch,
          starting_balance: startingBalance,
          final_balance: m.finalEquity,
          final_pnl: m.totalPnl,
          win_rate: m.winRate / 100,
          trades_count: localTrades.length,
          equity_curve: curve,
          trades: localTrades,
          params: { count, minConfidence, stake, startingBalance },
        },
      });
      toast.success(
        `Backtest done · ${localTrades.length} trades · ${m.winRate.toFixed(0)}% wins · PF ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}`
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

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Backtest Engine</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Replay the OB+FVG strategy on historical Deriv candles with comprehensive analytics.
            No Deriv account required — uses the public candle feed.
          </p>
        </header>

        {/* ── Config Panel ── */}
        <div className="glass rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
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
              <Label className="text-xs">Candles (1m)</Label>
              <Input
                type="number" min={120} max={5000}
                value={count} onChange={(e) => setCount(Number(e.target.value))}
              />
            </div>
            <div>
              <Label className="text-xs">Starting Balance ($)</Label>
              <Input
                type="number" min={100} step={100}
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
              <Label className="text-xs">Stake / Trade ($)</Label>
              <Input
                type="number" step="0.5"
                value={stake} onChange={(e) => setStake(Number(e.target.value))}
              />
            </div>
            <div className="flex items-end">
              <Button onClick={run} disabled={running} className="w-full gap-1.5">
                <Play className="size-3.5" />
                {running ? `Running ${progress}%` : "Run Backtest"}
              </Button>
            </div>
          </div>
        </div>

        {/* ── Results ── */}
        {metrics && (
          <>
            {/* Key metrics grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <Stat icon={<Target className="size-3.5" />} label="Total Trades" value={metrics.totalTrades} />
              <Stat icon={<TrendingUp className="size-3.5" />} label="Win Rate" value={`${metrics.winRate.toFixed(1)}%`} tone={metrics.winRate >= 50 ? "bull" : "bear"} />
              <Stat icon={<TrendingDown className="size-3.5" />} label="Loss Rate" value={`${metrics.lossRate.toFixed(1)}%`} tone="bear" />
              <Stat
                icon={<Zap className="size-3.5" />}
                label="Total P&L"
                value={`${metrics.totalPnl >= 0 ? "+" : ""}$${metrics.totalPnl.toFixed(2)}`}
                tone={metrics.totalPnl >= 0 ? "bull" : "bear"}
              />
              <Stat
                icon={<BarChart3 className="size-3.5" />}
                label="Final Equity"
                value={`$${metrics.finalEquity.toFixed(2)}`}
                tone={metrics.finalEquity >= startingBalance ? "bull" : "bear"}
              />
              <Stat
                icon={<Shield className="size-3.5" />}
                label="Profit Factor"
                value={metrics.profitFactor === Infinity ? "∞" : metrics.profitFactor.toFixed(2)}
                tone={metrics.profitFactor >= 1 ? "bull" : "bear"}
              />
            </div>

            {/* Secondary metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              <Stat
                icon={<AlertTriangle className="size-3.5" />}
                label="Max Drawdown"
                value={`$${metrics.maxDrawdown.toFixed(2)} (${metrics.maxDrawdownPct.toFixed(1)}%)`}
                tone="bear"
              />
              <Stat icon={<Award className="size-3.5" />} label="Best Trade" value={`+$${metrics.bestTrade.toFixed(2)}`} tone="bull" />
              <Stat icon={<Flame className="size-3.5" />} label="Worst Trade" value={`$${metrics.worstTrade.toFixed(2)}`} tone="bear" />
              <Stat icon={<TrendingUp className="size-3.5" />} label="Avg Win" value={`+$${metrics.avgWin.toFixed(2)}`} tone="bull" />
              <Stat icon={<TrendingDown className="size-3.5" />} label="Avg Loss" value={`-$${metrics.avgLoss.toFixed(2)}`} tone="bear" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              <Stat label="Risk/Reward" value={metrics.riskRewardRatio.toFixed(2)} tone={metrics.riskRewardRatio >= 1 ? "bull" : "bear"} />
              <Stat label="Sharpe Ratio" value={metrics.sharpeRatio.toFixed(2)} tone={metrics.sharpeRatio >= 1 ? "bull" : "bear"} />
              <Stat label="Expectancy" value={`$${metrics.expectancy.toFixed(2)}/trade`} tone={metrics.expectancy >= 0 ? "bull" : "bear"} />
              <Stat label="Max Win Streak" value={`${metrics.maxConsecutiveWins}`} tone="bull" />
              <Stat label="Max Loss Streak" value={`${metrics.maxConsecutiveLosses}`} tone="bear" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Gross Profit" value={`$${metrics.grossProfit.toFixed(2)}`} tone="bull" />
              <Stat label="Gross Loss" value={`$${metrics.grossLoss.toFixed(2)}`} tone="bear" />
              <Stat label="Avg Bars Held" value={metrics.avgBarsHeld.toFixed(1)} />
              <Stat label="Wins / Losses" value={`${metrics.wins}W / ${metrics.losses}L`} />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Equity curve */}
              <div className="glass rounded-xl p-4">
                <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <TrendingUp className="size-3" /> Equity Curve
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
                      <YAxis stroke="var(--color-muted-foreground)" fontSize={10} tickFormatter={(v) => `${v.toFixed(0)}%`} />
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
                  <BarChart3 className="size-3" /> P&L Distribution
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
                </h3>
                {showTradeLog ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </button>

              {showTradeLog && (
                <div className="border-t border-border max-h-[500px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-card/60 sticky top-0">
                      <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-3 py-2">#</th>
                        <th className="px-3 py-2">Entry Time</th>
                        <th className="px-3 py-2">Exit Time</th>
                        <th className="px-3 py-2">Side</th>
                        <th className="px-3 py-2">Entry</th>
                        <th className="px-3 py-2">Exit</th>
                        <th className="px-3 py-2">P&L</th>
                        <th className="px-3 py-2">Cum P&L</th>
                        <th className="px-3 py-2">Conf</th>
                        <th className="px-3 py-2">Trend</th>
                        <th className="px-3 py-2">EMA20</th>
                        <th className="px-3 py-2">RSI14</th>
                        <th className="px-3 py-2">ATR14</th>
                        <th className="px-3 py-2">Bars</th>
                        <th className="px-3 py-2">OB Zone</th>
                        <th className="px-3 py-2">FVG Zone</th>
                        <th className="px-3 py-2">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((t, i) => (
                        <tr
                          key={i}
                          className={`border-t border-border/30 hover:bg-card/30 transition-colors ${
                            t.pnl > 0 ? "bg-bull-soft" : t.pnl < 0 ? "bg-bear-soft" : ""
                          }`}
                        >
                          <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                          <td className="px-3 py-1.5 numeric">
                            {new Date(t.t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </td>
                          <td className="px-3 py-1.5 numeric">
                            {new Date(t.exitT * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </td>
                          <td className={`px-3 py-1.5 font-semibold ${t.side === "BUY" ? "text-bull" : "text-bear"}`}>
                            {t.side}
                          </td>
                          <td className="px-3 py-1.5 numeric">{t.entry.toFixed(4)}</td>
                          <td className="px-3 py-1.5 numeric">{t.exit.toFixed(4)}</td>
                          <td className={`px-3 py-1.5 numeric font-semibold ${t.pnl >= 0 ? "text-bull" : "text-bear"}`}>
                            {t.pnl >= 0 ? "+" : ""}{t.pnl.toFixed(2)}
                          </td>
                          <td className={`px-3 py-1.5 numeric ${t.cumPnl >= 0 ? "text-bull" : "text-bear"}`}>
                            {t.cumPnl >= 0 ? "+" : ""}{t.cumPnl.toFixed(2)}
                          </td>
                          <td className="px-3 py-1.5 numeric">{(t.confidence * 100).toFixed(0)}%</td>
                          <td className={`px-3 py-1.5 ${t.trend === "up" ? "text-bull" : "text-bear"}`}>
                            {t.trend.toUpperCase()}
                          </td>
                          <td className="px-3 py-1.5 numeric">{t.ema20.toFixed(4)}</td>
                          <td className="px-3 py-1.5 numeric">{t.rsi14.toFixed(0)}</td>
                          <td className="px-3 py-1.5 numeric">{t.atr14.toFixed(5)}</td>
                          <td className="px-3 py-1.5 numeric">{t.barsHeld}</td>
                          <td className="px-3 py-1.5 text-[10px]">{t.obZone ?? "—"}</td>
                          <td className="px-3 py-1.5 text-[10px]">{t.fvgZone ?? "—"}</td>
                          <td className="px-3 py-1.5">
                            <Badge variant={t.pnl > 0 ? "default" : "destructive"} className="text-[10px] h-4 px-1.5">
                              {t.pnl > 0 ? "WIN" : "LOSS"}
                            </Badge>
                          </td>
                        </tr>
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

function Stat({
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

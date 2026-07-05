/**
 * Shared helpers extracted from backtest.tsx and bots.tsx trading logic.
 *
 * These utilities are reused by the MT5 Direct page and any future
 * broker-integration pages.
 */

import { analyze } from "@/lib/ob-fvg";

// ── Types (shared) ──

export interface TradeEntry {
  t: number;
  exitT: number;
  side: "BUY" | "SELL" | "CALL" | "PUT";
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
}

export interface BacktestMetrics {
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

export interface ActivityEntry {
  id: string;
  timestamp: number;
  action: "SCAN" | "SKIP" | "ENTRY" | "EXIT" | "ERROR" | "PROTECTION";
  symbol: string;
  direction: "CALL" | "PUT" | "BUY" | "SELL" | "NONE" | "—";
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

// ── Trade signal helpers (reused from backtest.tsx OB+FVG logic) ──

export interface SignalResult {
  decision: "BUY" | "SELL" | "WAIT";
  confidence: number;
  trend: "up" | "down";
  sl: number;
  tp: number;
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  activeOB: { kind: string; bottom: number; top: number } | null;
  activeFVG: { kind: string; bottom: number; top: number } | null;
  bos: boolean;
  choch: boolean;
}

/**
 * Analyze candles using OB+FVG strategy (wraps src/lib/ob-fvg analyze()).
 */
export function analyzeCandles(
  candles: {
    open: number;
    high: number;
    low: number;
    close: number;
    time: number;
    epoch?: number;
  }[],
): SignalResult {
  // Cast to Candle[] for ob-fvg compatibility
  return analyze(candles as any) as unknown as SignalResult;
}

// ── Metrics computation (extracted from backtest.tsx) ──

export function computeMetrics(trades: TradeEntry[], startingBalance: number): BacktestMetrics {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const totalPnl = grossProfit - grossLoss;
  const finalEquity = startingBalance + totalPnl;

  let peak = startingBalance;
  let maxDD = 0;
  let maxDDPct = 0;
  let current = startingBalance;
  for (const t of trades) {
    current += t.pnl;
    if (current > peak) peak = current;
    const dd = peak - current;
    const ddPct = (dd / peak) * 100;
    if (dd > maxDD) maxDD = dd;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }

  let maxConsWins = 0,
    maxConsLosses = 0,
    consWins = 0,
    consLosses = 0;
  for (const t of trades) {
    if (t.pnl > 0) {
      consWins++;
      consLosses = 0;
    } else if (t.pnl < 0) {
      consLosses++;
      consWins = 0;
    } else {
      consWins = 0;
      consLosses = 0;
    }
    if (consWins > maxConsWins) maxConsWins = consWins;
    if (consLosses > maxConsLosses) maxConsLosses = consLosses;
  }

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const riskReward = avgLoss > 0 ? avgWin / avgLoss : 0;
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const lossRate = trades.length > 0 ? losses.length / trades.length : 0;
  const expectancy = winRate * avgWin - lossRate * avgLoss;

  const returns = trades.map((t) => t.pnl);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / (returns.length || 1);
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

  const avgBarsHeld =
    trades.length > 0 ? trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length : 0;

  return {
    totalTrades: trades.length,
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
    bestTrade: trades.length > 0 ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worstTrade: trades.length > 0 ? Math.min(...trades.map((t) => t.pnl)) : 0,
    avgBarsHeld,
    grossProfit,
    grossLoss,
  };
}

// ── Consecutive Loss Protection ──

export function checkConsecutiveLosses(
  logs: { pnl: number | null; action: string }[],
  threshold = 3,
): boolean {
  const exitTrades = logs.filter((l) => l.action === "EXIT");
  if (exitTrades.length < threshold) return false;
  const lastN = exitTrades.slice(0, threshold);
  return lastN.every((t) => (t.pnl ?? 0) < 0);
}

// ── P&L Distribution Binning ──

export function computePnlBins(
  trades: { pnl: number }[],
  maxBins = 12,
): { range: string; count: number; isProfit: boolean }[] {
  if (trades.length === 0) return [];
  const pnls = trades.map((t) => t.pnl);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  if (min === max) return [{ range: min.toFixed(2), count: trades.length, isProfit: min >= 0 }];
  const binCount = Math.min(maxBins, Math.max(4, Math.ceil(trades.length / 3)));
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
}

// ── Bot Stats (extracted from bots.tsx) ──

export function computeBotStats(logs: ActivityEntry[], initialBalance: number) {
  const trades = logs.filter((l) => l.action === "EXIT");
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const scans = logs.filter((l) => l.action === "SCAN").length;
  const entries = logs.filter((l) => l.action === "ENTRY").length;
  const errors = logs.filter((l) => l.action === "ERROR").length;

  let peak = initialBalance;
  let current = peak;
  let maxDD = 0;
  for (const t of [...trades].reverse()) {
    current += t.pnl ?? 0;
    if (current > peak) peak = current;
    const dd = ((peak - current) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return { wins, losses, winRate, scans, entries, errors, maxDD, trades: trades.length };
}

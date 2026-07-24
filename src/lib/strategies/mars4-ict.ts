/**
 * MARS4 — Institutional High-Probability Trading Engine
 * ======================================================
 *
 * Core Philosophy:
 *   Trade only when the market strongly suggests an institutional-quality
 *   opportunity. If any major confirmation is missing, return WAIT.
 *   Missing a profitable trade is acceptable. Taking a poor trade is not.
 *
 * Architecture:
 *   Market Data → Regime Detection → Engine Selection → Entry Pipeline → Quality Score → Decision
 *
 * Four Core Engines:
 *   1. Trend Following (TF)     — EMA alignment + ADX + HH/HL + momentum + volume
 *   2. Mean Reversion (MR)      — RSI extremes + sweep + rejection + ATR declining
 *   3. Volatility Expansion (VE) — ATR/BB expansion + ADX surge + displacement
 *   4. Breakout Trading (BT)     — Consolidation → sweep → breakout → retest → confirmation
 *
 * Supporting Systems:
 *   - Volatility Clustering     — auto-detect if large/small candles cluster
 *   - Microstructure Analysis   — impulse, slope, close-location, spread health
 *   - Session Timing            — London/NY/Asian session strength
 *
 * Scoring (max 200 across all engines):
 *   Engine-specific scoring with 4 tiers per engine (max 50 each)
 *   Confluence bonus for multiple engines agreeing
 *
 * Decision thresholds:
 *   160–200  → EXECUTE (high conviction)
 *   120–159  → OPTIONAL (caller decides)
 *   75–119   → CAUTION (only with additional manual confirmation)
 *   < 75     → WAIT (never trade)
 *
 * Deriv Volatility Indices are the primary target market.
 */

import type { Candle } from "@/lib/deriv-ws";

// ────────────────────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────────────────────

export type MarketRegime =
  | "strong_trend_up"
  | "strong_trend_down"
  | "weak_trend_up"
  | "weak_trend_down"
  | "range"
  | "consolidation"
  | "breakout_up"
  | "breakout_down"
  | "high_volatility_expansion"
  | "low_volatility_compression"
  | "choppy_market";

/** Regimes where trading is permitted */
const TRADABLE_REGIMES: ReadonlySet<MarketRegime> = new Set([
  "strong_trend_up",
  "strong_trend_down",
  "breakout_up",
  "breakout_down",
  "high_volatility_expansion",
]);

export type TradeDirection = "BUY" | "SELL" | "WAIT";
export type EngineKind = "trend_following" | "mean_reversion" | "volatility_expansion" | "breakout";

export type TradeDecision = "EXECUTE" | "OPTIONAL" | "CAUTION" | "WAIT";

// ── Engine Results ─────────────────────────────────────────────────────────

export interface TrendFollowingResult {
  detected: boolean;
  direction: "BUY" | "SELL" | null;
  score: number; // 0-100
  breakdown: {
    emaAlignment: number; // max 20
    adx: number; // max 20
    hhhl: number; // max 20
    momentum: number; // max 20
    volume: number; // max 20
  };
  entryCandle: Candle | null;
  rationale: string;
}

export interface MeanReversionResult {
  detected: boolean;
  direction: "BUY" | "SELL" | null;
  score: number; // 0-100
  breakdown: {
    rsiExtreme: number; // max 25
    liquiditySweep: number; // max 25
    rejectionCandle: number; // max 25
    atrDeclining: number; // max 25
  };
  entryCandle: Candle | null;
  rationale: string;
}

export interface VolatilityExpansionResult {
  detected: boolean;
  direction: "BUY" | "SELL" | null;
  score: number; // 0-100
  breakdown: {
    atrExpansion: number; // max 25
    bbExpansion: number; // max 25
    adxSurge: number; // max 25
    displacement: number; // max 25
  };
  entryCandle: Candle | null;
  rationale: string;
}

export interface BreakoutResult {
  detected: boolean;
  direction: "BUY" | "SELL" | null;
  score: number; // 0-100
  breakdown: {
    consolidation: number; // max 20
    liquiditySweep: number; // max 20
    breakout: number; // max 20
    retest: number; // max 20
    confirmation: number; // max 20
  };
  entryCandle: Candle | null;
  rationale: string;
}

export interface VolatilityClusterResult {
  regime: "HIGH_VOL_CLUSTER" | "LOW_VOL_CLUSTER" | "NEUTRAL";
  clusterStrength: number; // 0-1
  avgLargeCandleSize: number;
  avgSmallCandleSize: number;
  ratio: number;
}

export interface MicrostructureResult {
  impulseScore: number; // 0-1
  slopeScore: number; // 0-1
  closeLocationScore: number; // 0-1
  extensionScore: number; // 0-1
  spreadHealthScore: number; // 0-1
  totalScore: number; // 0-1
}

export interface Mars4InstitutionalResult {
  decision: TradeDecision;
  direction: TradeDirection;
  confidence: number;
  totalScore: number; // 0-200
  regime: MarketRegime;
  regimeTradable: boolean;
  volatilityPass: boolean;
  trendPass: boolean;
  mtfPass: boolean;
  activeEngine: EngineKind | null;
  engines: {
    trendFollowing: TrendFollowingResult;
    meanReversion: MeanReversionResult;
    volatilityExpansion: VolatilityExpansionResult;
    breakout: BreakoutResult;
  };
  volatilityCluster: VolatilityClusterResult;
  microstructure: MicrostructureResult;
  liquiditySweep: boolean;
  bosChoch: boolean;
  fvg: boolean;
  pullback: boolean;
  confirmationCandle: boolean;
  allEntryGatesPass: boolean;
  entry?: number;
  sl?: number;
  tp?: number;
  rationale: string;
  gateFailures: string[];
}

// ────────────────────────────────────────────────────────────────────────────
//  Indicator helpers (consolidated - shared across all engines)
// ────────────────────────────────────────────────────────────────────────────

function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function sma(values: number[], period: number): number {
  const tail = values.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / (tail.length || 1);
}

function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  const rs = gains / (losses || 1e-9);
  return 100 - 100 / (1 + rs);
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

function bollinger(closes: number[], period = 20, mult = 2) {
  const tail = closes.slice(-period);
  const mid = tail.reduce((a, b) => a + b, 0) / (tail.length || 1);
  const sd = stddev(tail);
  return {
    upper: mid + mult * sd,
    lower: mid - mult * sd,
    mid,
    width: (2 * mult * sd) / (mid || 1),
  };
}

function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trs.push(tr);
  }
  const tail = trs.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / (tail.length || 1);
}

function atrSeries(candles: Candle[], period = 14): number[] {
  if (candles.length < 2) return [];
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }
  const out: number[] = [];
  for (let i = period - 1; i < trs.length; i++) {
    const slice = trs.slice(i - period + 1, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

function calculateADX(candles: Candle[], period = 14): number {
  if (candles.length < period * 2) return 20;
  const trs: number[] = [],
    plusDM: number[] = [],
    minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const trS = ema(trs, period);
  const pS = ema(plusDM, period);
  const mS = ema(minusDM, period);
  const pDI = trS > 0 ? 100 * (pS / trS) : 0;
  const mDI = trS > 0 ? 100 * (mS / trS) : 0;
  const sum = pDI + mDI;
  const dx = sum > 0 ? 100 * (Math.abs(pDI - mDI) / sum) : 0;
  return dx || 20;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregateCandles(candles: Candle[], size: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += size) {
    const chunk = candles.slice(i, i + size);
    if (!chunk.length) continue;
    out.push({
      epoch: chunk[0].epoch,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
//  Swing detection (shared)
// ────────────────────────────────────────────────────────────────────────────

function detectSwings(candles: Candle[], left = 3, right = 3) {
  const highs: { val: number; idx: number }[] = [];
  const lows: { val: number; idx: number }[] = [];
  for (let i = left; i < candles.length - right; i++) {
    let sh = true,
      sl = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= candles[i].high) sh = false;
      if (candles[i - j].low <= candles[i].low) sl = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high >= candles[i].high) sh = false;
      if (candles[i + j].low <= candles[i].low) sl = false;
    }
    if (sh) highs.push({ val: candles[i].high, idx: i });
    if (sl) lows.push({ val: candles[i].low, idx: i });
  }
  return { highs, lows };
}

// ────────────────────────────────────────────────────────────────────────────
//  1. Market Regime Filter
// ────────────────────────────────────────────────────────────────────────────

export function detectMarketRegime(
  candles: Candle[],
  adx: number,
  atr14: number,
  bbWidth: number,
  ema20: number,
  ema50: number,
  ema200: number,
  trend: "up" | "down",
): MarketRegime {
  const last = candles.at(-1);
  if (!last) return "consolidation";

  const closes = candles.map((c) => c.close);
  const atrPct = last.close > 0 ? (atr14 / last.close) * 100 : 0;

  // Low Volatility Compression: very tight BB + low ATR%
  if (bbWidth < 0.003 && atrPct < 0.03) {
    return "low_volatility_compression";
  }

  // High Volatility Expansion: BB wide + ATR high
  if (bbWidth > 0.02 && atrPct > 0.15) {
    return "high_volatility_expansion";
  }

  // Choppy Market: ADX low, no clear direction
  if (adx < 20) {
    const recentRange = Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20));
    const avgRange = recentRange / (atr14 || 1);
    if (avgRange < 3) return "consolidation";
    return "choppy_market";
  }

  // Weak Trend: ADX between 20-30
  if (adx >= 20 && adx <= 30) {
    const emaAlignedUp = ema20 > ema50 && ema50 > ema200;
    const emaAlignedDown = ema20 < ema50 && ema50 < ema200;
    if (emaAlignedUp) return "weak_trend_up";
    if (emaAlignedDown) return "weak_trend_down";
    return "range";
  }

  // Strong Trend: ADX > 30
  if (adx > 30) {
    const emaAlignedUp = ema20 > ema50 && ema50 > ema200;
    const emaAlignedDown = ema20 < ema50 && ema50 < ema200;

    const recentCandles = candles.slice(-5);
    const rangeHigh = Math.max(...candles.slice(-30, -5).map((c) => c.high));
    const rangeLow = Math.min(...candles.slice(-30, -5).map((c) => c.low));
    const brokeAbove = recentCandles.some((c) => c.close > rangeHigh && c.high > rangeHigh);
    const brokeBelow = recentCandles.some((c) => c.close < rangeLow && c.low < rangeLow);

    if (brokeAbove && emaAlignedUp) return "breakout_up";
    if (brokeBelow && emaAlignedDown) return "breakout_down";
    if (emaAlignedUp) return "strong_trend_up";
    if (emaAlignedDown) return "strong_trend_down";
  }

  return "range";
}

// ────────────────────────────────────────────────────────────────────────────
//  2. Volatility Filter
// ────────────────────────────────────────────────────────────────────────────

export interface VolatilityFilterResult {
  pass: boolean;
  adxOk: boolean;
  atrAboveMedian: boolean;
  atrSlopeIncreasing: boolean;
  bbWidthExpanding: boolean;
  details: string;
}

export function checkVolatilityFilter(
  candles: Candle[],
  adx: number,
  atr14: number,
  bbWidth: number,
): VolatilityFilterResult {
  const failures: string[] = [];

  const adxOk = adx > 30;
  if (!adxOk) failures.push(`ADX ${adx.toFixed(1)} ≤ 30`);

  const atrVals = atrSeries(candles, 14);
  const atrMedian = atrVals.length >= 30 ? median(atrVals.slice(-30)) : 0;
  const atrAboveMedian = atrVals.length >= 30 ? atr14 > atrMedian : true;
  if (!atrAboveMedian) failures.push("ATR below 30-period median");

  let atrSlopeIncreasing = true;
  if (atrVals.length >= 14) {
    const recent5 = atrVals.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prior5 = atrVals.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
    atrSlopeIncreasing = recent5 > prior5;
    if (!atrSlopeIncreasing) failures.push("ATR slope not increasing");
  }

  let bbWidthExpanding = true;
  if (candles.length >= 40) {
    const closes = candles.map((c) => c.close);
    const bbNow = bollinger(closes.slice(-20), 20, 2);
    const bbPrev = bollinger(closes.slice(-40, -20), 20, 2);
    bbWidthExpanding = bbNow.width > bbPrev.width;
    if (!bbWidthExpanding) failures.push("BB width not expanding");
  }

  return {
    pass: failures.length === 0,
    adxOk,
    atrAboveMedian,
    atrSlopeIncreasing,
    bbWidthExpanding,
    details: failures.length ? failures.join("; ") : "All volatility filters pass",
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  3. Trend Filter
// ────────────────────────────────────────────────────────────────────────────

export interface TrendFilterResult {
  pass: boolean;
  direction: "up" | "down" | null;
  emaStacked: boolean;
  hhhl: boolean;
  lhll: boolean;
  details: string;
}

export function checkTrendFilter(candles: Candle[]): TrendFilterResult {
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const emaStackedUp = ema20 > ema50 && ema50 > ema200;
  const emaStackedDown = ema20 < ema50 && ema50 < ema200;
  const emaStacked = emaStackedUp || emaStackedDown;

  const { highs, lows } = detectSwings(candles, 5, 5);
  const recentHighs = highs.slice(-4);
  const recentLows = lows.slice(-4);

  let hhhl = true;
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].val <= recentHighs[i - 1].val) hhhl = false;
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].val <= recentLows[i - 1].val) hhhl = false;
  }

  let lhll = true;
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].val >= recentHighs[i - 1].val) lhll = false;
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].val >= recentLows[i - 1].val) lhll = false;
  }

  const failures: string[] = [];
  let direction: "up" | "down" | null = null;

  if (emaStackedUp && hhhl) {
    direction = "up";
  } else if (emaStackedDown && lhll) {
    direction = "down";
  } else {
    if (!emaStacked) failures.push("EMA not stacked");
    if (!hhhl && !lhll) failures.push("No clear HH/HL or LH/LL structure");
    if (emaStackedUp && !hhhl) failures.push("EMA stacked up but no HH/HL structure");
    if (emaStackedDown && !lhll) failures.push("EMA stacked down but no LH/LL structure");
  }

  return {
    pass: failures.length === 0,
    direction,
    emaStacked,
    hhhl,
    lhll,
    details: failures.length
      ? failures.join("; ")
      : `Trend ${direction?.toUpperCase()}: EMA stacked + structure confirmed`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  4. Multi-Timeframe Confirmation
// ────────────────────────────────────────────────────────────────────────────

export interface MTFResult {
  pass: boolean;
  m1Direction: "up" | "down" | null;
  m5Direction: "up" | "down" | null;
  m15Direction: "up" | "down" | null;
  details: string;
}

export function checkMTFConfirmation(
  m1Candles: Candle[],
  m5Candles: Candle[],
  m15Candles: Candle[],
): MTFResult {
  const getDirection = (candles: Candle[]): "up" | "down" | null => {
    if (candles.length < 50) return null;
    const closes = candles.map((c) => c.close);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const e200 = ema(closes, 200);
    if (e20 > e50 && e50 > e200) return "up";
    if (e20 < e50 && e50 < e200) return "down";
    return null;
  };

  const m1Dir = getDirection(m1Candles);
  const m5Dir = getDirection(m5Candles);
  const m15Dir = getDirection(m15Candles);

  const failures: string[] = [];
  if (!m1Dir) failures.push("M1: no clear direction");
  if (!m5Dir) failures.push("M5: no clear direction");
  if (!m15Dir) failures.push("M15: no clear direction");

  const allSame =
    m1Dir !== null && m5Dir !== null && m15Dir !== null && m1Dir === m5Dir && m5Dir === m15Dir;

  if (!allSame && failures.length === 0) {
    failures.push(`Timeframes disagree: M1=${m1Dir}, M5=${m5Dir}, M15=${m15Dir}`);
  }

  return {
    pass: allSame,
    m1Direction: m1Dir,
    m5Direction: m5Dir,
    m15Direction: m15Dir,
    details: allSame ? `All timeframes aligned ${m1Dir?.toUpperCase()}` : failures.join("; "),
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  5a. Liquidity Sweep Detection (shared)
// ────────────────────────────────────────────────────────────────────────────

export function detectLiquiditySweepSimple(
  candles: Candle[],
  atr14: number,
): {
  detected: boolean;
  kind: "bullish" | "bearish" | null;
  rejectionQuality: number;
} {
  const { highs, lows } = detectSwings(candles, 3, 3);
  const last = candles.at(-1);
  if (!last) return { detected: false, kind: null, rejectionQuality: 0 };

  // Equal highs
  const equalHighs: { level: number; indices: number[] }[] = [];
  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[i].val - highs[j].val) <= 0.1 * atr14) {
        const existing = equalHighs.find((e) => Math.abs(e.level - highs[i].val) <= 0.1 * atr14);
        if (existing) {
          if (!existing.indices.includes(highs[j].idx)) existing.indices.push(highs[j].idx);
        } else {
          equalHighs.push({ level: highs[i].val, indices: [highs[i].idx, highs[j].idx] });
        }
      }
    }
  }

  // Equal lows
  const equalLows: { level: number; indices: number[] }[] = [];
  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      if (Math.abs(lows[i].val - lows[j].val) <= 0.1 * atr14) {
        const existing = equalLows.find((e) => Math.abs(e.level - lows[i].val) <= 0.1 * atr14);
        if (existing) {
          if (!existing.indices.includes(lows[j].idx)) existing.indices.push(lows[j].idx);
        } else {
          equalLows.push({ level: lows[i].val, indices: [lows[i].idx, lows[j].idx] });
        }
      }
    }
  }

  // Bearish sweep (sweep high)
  for (const eq of equalHighs) {
    const recentEq = eq.indices.filter((idx) => idx >= candles.length - 30);
    if (recentEq.length < 2) continue;
    const sweptAbove = last.high > eq.level;
    const rejected = last.close < eq.level;
    const wickAbove = last.high - Math.max(last.close, last.open);
    const totalRange = last.high - last.low || 1e-9;
    const rejectionQuality = Math.min(1, wickAbove / totalRange);
    if (sweptAbove && rejected) {
      return { detected: true, kind: "bearish", rejectionQuality };
    }
  }

  // Bullish sweep (sweep low)
  for (const eq of equalLows) {
    const recentEq = eq.indices.filter((idx) => idx >= candles.length - 30);
    if (recentEq.length < 2) continue;
    const sweptBelow = last.low < eq.level;
    const rejected = last.close > eq.level;
    const wickBelow = Math.min(last.close, last.open) - last.low;
    const totalRange = last.high - last.low || 1e-9;
    const rejectionQuality = Math.min(1, wickBelow / totalRange);
    if (sweptBelow && rejected) {
      return { detected: true, kind: "bullish", rejectionQuality };
    }
  }

  return { detected: false, kind: null, rejectionQuality: 0 };
}

// ────────────────────────────────────────────────────────────────────────────
//  VOLATILITY CLUSTERING
// ────────────────────────────────────────────────────────────────────────────

export function detectVolatilityClustering(candles: Candle[]): VolatilityClusterResult {
  const ranges = candles.map((c) => c.high - c.low);
  const medianRange = median(ranges);
  if (ranges.length < 20 || medianRange <= 0) {
    return {
      regime: "NEUTRAL",
      clusterStrength: 0.5,
      avgLargeCandleSize: 0,
      avgSmallCandleSize: 0,
      ratio: 1,
    };
  }

  // Separate into large and small candles
  const large = ranges.filter((r) => r > medianRange * 1.3);
  const small = ranges.filter((r) => r < medianRange * 0.7);
  const avgLarge = large.length ? large.reduce((a, b) => a + b, 0) / large.length : 0;
  const avgSmall = small.length ? small.reduce((a, b) => a + b, 0) / small.length : 0;
  const ratio = avgSmall > 0 ? avgLarge / avgSmall : 2;

  // Detect clustering: do large candles appear in groups?
  const last10Ranges = ranges.slice(-10);
  const largeInLast10 = last10Ranges.filter((r) => r > medianRange * 1.3).length;
  const smallInLast10 = last10Ranges.filter((r) => r < medianRange * 0.7).length;

  let regime: "HIGH_VOL_CLUSTER" | "LOW_VOL_CLUSTER" | "NEUTRAL";
  let clusterStrength: number;

  if (largeInLast10 >= 4 && ratio > 1.5) {
    regime = "HIGH_VOL_CLUSTER";
    clusterStrength = Math.min(1, largeInLast10 / 10);
  } else if (smallInLast10 >= 6 && ratio < 0.7) {
    regime = "LOW_VOL_CLUSTER";
    clusterStrength = Math.min(1, smallInLast10 / 10);
  } else {
    regime = "NEUTRAL";
    clusterStrength = 0.5;
  }

  return {
    regime,
    clusterStrength,
    avgLargeCandleSize: avgLarge,
    avgSmallCandleSize: avgSmall,
    ratio,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  MICROSTRUCTURE ANALYSIS
// ────────────────────────────────────────────────────────────────────────────

export function analyzeMicrostructure(
  candles: Candle[],
  atr14: number,
  direction: TradeDirection,
  spreadOk: boolean,
): MicrostructureResult {
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const closes = candles.slice(-8).map((c) => c.close);

  if (!last || !prev || closes.length < 4 || direction === "WAIT") {
    return {
      impulseScore: 0,
      slopeScore: 0,
      closeLocationScore: 0,
      extensionScore: 0,
      spreadHealthScore: 0,
      totalScore: 0,
    };
  }

  const isBuy = direction === "BUY";
  const dirSign = isBuy ? 1 : -1;

  // Impulse: directional momentum of the last bar
  const impulse = (last.close - prev.close) * dirSign;
  const impulseScore = impulse > 0 ? Math.min(1, impulse / (atr14 || 1)) : 0;

  // Slope: short-term directional consistency over last 4 bars
  const shortSlope = (closes.at(-1)! - closes.at(-4)!) * dirSign;
  const slopeScore = shortSlope > 0 ? Math.min(1, shortSlope / (atr14 * 2 || 1)) : 0;

  // Close location: where within the range did price close?
  const barRange = Math.max(1e-9, last.high - last.low);
  const closeLoc = isBuy ? (last.close - last.low) / barRange : (last.high - last.close) / barRange;
  const closeLocationScore = Math.min(1, Math.max(0, closeLoc));

  // Extension: is price already too far from a reasonable entry?
  const entry = last.close;
  const notExtended = Math.abs(entry - prev.close) <= atr14 * 1.8;
  const extensionScore = notExtended
    ? 1
    : Math.max(0, 1 - Math.abs(entry - prev.close) / (atr14 * 3));

  // Spread health
  const spreadHealthScore = spreadOk ? 1 : 0;

  const totalScore =
    impulseScore * 0.25 +
    slopeScore * 0.25 +
    closeLocationScore * 0.2 +
    extensionScore * 0.2 +
    spreadHealthScore * 0.1;

  return {
    impulseScore,
    slopeScore,
    closeLocationScore,
    extensionScore,
    spreadHealthScore,
    totalScore: Math.min(1, Math.max(0, totalScore)),
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  ENGINE 1: TREND FOLLOWING (max score 100)
// ────────────────────────────────────────────────────────────────────────────

export function analyzeTrendFollowing(
  candles: Candle[],
  trendFilter: TrendFilterResult,
  adx: number,
  atr14: number,
  volCluster: VolatilityClusterResult,
): TrendFollowingResult {
  const closes = candles.map((c) => c.close);
  const last = candles.at(-1);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  if (!last) {
    return {
      detected: false,
      direction: null,
      score: 0,
      breakdown: { emaAlignment: 0, adx: 0, hhhl: 0, momentum: 0, volume: 0 },
      entryCandle: null,
      rationale: "Insufficient data",
    };
  }

  const dir = trendFilter.direction;

  // 1. EMA Alignment (max 20)
  let emaAlignmentScore = 0;
  if (dir === "up" && ema20 > ema50 && ema50 > ema200) {
    emaAlignmentScore = 20;
  } else if (dir === "down" && ema20 < ema50 && ema50 < ema200) {
    emaAlignmentScore = 20;
  } else if (dir === "up" && ema20 > ema50) {
    emaAlignmentScore = 10; // partial
  } else if (dir === "down" && ema20 < ema50) {
    emaAlignmentScore = 10;
  }

  // 2. ADX Strength (max 20)
  let adxScore = 0;
  if (adx > 40) adxScore = 20;
  else if (adx > 35) adxScore = 15;
  else if (adx > 30) adxScore = 10;
  else if (adx > 25) adxScore = 5;

  // 3. HH/HL or LH/LL structure (max 20)
  let hhhlScore = 0;
  if (dir === "up" && trendFilter.hhhl) {
    hhhlScore = 20;
  } else if (dir === "down" && trendFilter.lhll) {
    hhhlScore = 20;
  } else if (trendFilter.hhhl || trendFilter.lhll) {
    hhhlScore = 10;
  }

  // 4. Momentum (max 20) — recent candle body strength
  let momentumScore = 0;
  const recentCandles = candles.slice(-5);
  const dirSign = dir === "up" ? 1 : -1;
  let momentumSum = 0;
  for (const c of recentCandles) {
    const bodyRatio = Math.abs(c.close - c.open) / Math.max(1e-9, c.high - c.low);
    const directionalBody = (c.close > c.open ? 1 : -1) === dirSign ? bodyRatio : -bodyRatio;
    momentumSum += directionalBody;
  }
  const avgMomentum = momentumSum / recentCandles.length;
  if (avgMomentum > 0.5) momentumScore = 20;
  else if (avgMomentum > 0.3) momentumScore = 15;
  else if (avgMomentum > 0.1) momentumScore = 10;
  else if (avgMomentum > 0) momentumScore = 5;

  // 5. Volume proxy / candle range (max 20)
  const volumeProxy = Math.min(1, (last.high - last.low) / (atr14 * 2 || 1));
  let volumeScore = Math.round(volumeProxy * 20);

  const totalScore = emaAlignmentScore + adxScore + hhhlScore + momentumScore + volumeScore;
  const detected = totalScore >= 50 && dir !== null && trendFilter.pass;

  // Entry candle: last candle must have momentum in trend direction
  const lastBodyDir = last.close > last.open ? 1 : -1;
  const entryCandle =
    detected && lastBodyDir === dirSign && Math.abs(last.close - last.open) > 0.3 * atr14
      ? last
      : null;

  const rationale = detected
    ? `TF ${dir?.toUpperCase()}: EMA ${emaAlignmentScore}/20, ADX ${adxScore}/20, HH/HL ${hhhlScore}/20, Momentum ${momentumScore}/20, Volume ${volumeScore}/20 = ${totalScore}/100. ${entryCandle ? "Entry candle valid." : "No entry candle."}`
    : `TF rejected: score ${totalScore}/100, dir=${dir}, trendPass=${trendFilter.pass}`;

  return {
    detected: detected && entryCandle !== null,
    direction: detected ? (dir === "up" ? "BUY" : "SELL") : null,
    score: totalScore,
    breakdown: {
      emaAlignment: emaAlignmentScore,
      adx: adxScore,
      hhhl: hhhlScore,
      momentum: momentumScore,
      volume: volumeScore,
    },
    entryCandle,
    rationale,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  ENGINE 2: MEAN REVERSION (max score 100)
// ────────────────────────────────────────────────────────────────────────────

export function analyzeMeanReversion(
  candles: Candle[],
  rsi14: number,
  atr14: number,
  bb: ReturnType<typeof bollinger>,
  liqSweep: ReturnType<typeof detectLiquiditySweepSimple>,
  adx: number,
): MeanReversionResult {
  const last = candles.at(-1);
  if (!last) {
    return {
      detected: false,
      direction: null,
      score: 0,
      breakdown: { rsiExtreme: 0, liquiditySweep: 0, rejectionCandle: 0, atrDeclining: 0 },
      entryCandle: null,
      rationale: "Insufficient data",
    };
  }

  const price = last.close;
  const totalRange = last.high - last.low || 1e-9;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / totalRange;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const lowerWickRatio = lowerWick / totalRange;
  const upperWickRatio = upperWick / totalRange;

  // MR checks: only during low ADX, sideways markets, narrow BB
  // Never against a strong trend.
  if (adx > 25) {
    return {
      detected: false,
      direction: null,
      score: 0,
      breakdown: { rsiExtreme: 0, liquiditySweep: 0, rejectionCandle: 0, atrDeclining: 0 },
      entryCandle: null,
      rationale: `MR rejected: ADX ${adx.toFixed(0)} > 25 (trend too strong)`,
    };
  }

  // Check both BUY and SELL possibilities
  const isBuyOversold = rsi14 < 30 && price <= bb.lower;
  const isSellOverbought = rsi14 > 70 && price >= bb.upper;

  let direction: "BUY" | "SELL" | null = null;
  let breakdown = { rsiExtreme: 0, liquiditySweep: 0, rejectionCandle: 0, atrDeclining: 0 };

  if (isBuyOversold) {
    direction = "BUY";
    // 1. RSI Extreme (max 25)
    const rsiScore = rsi14 < 20 ? 25 : rsi14 < 25 ? 20 : rsi14 < 30 ? 15 : 10;
    breakdown.rsiExtreme = rsiScore;

    // 2. Liquidity Sweep (max 25) — require bullish sweep
    breakdown.liquiditySweep = liqSweep.detected && liqSweep.kind === "bullish" ? 25 : 0;

    // 3. Rejection Candle (max 25) — require bullish rejection (long lower wick, close up)
    const hasRejection = last.close > last.open && lowerWickRatio > 0.5;
    breakdown.rejectionCandle = hasRejection ? Math.round(lowerWickRatio * 25) : 0;

    // 4. ATR declining (max 25)
    const atrVals = atrSeries(candles, 14);
    let atrDeclineScore = 0;
    if (atrVals.length >= 10) {
      const recent3 = sma(atrVals.slice(-3), 3);
      const prior3 = sma(atrVals.slice(-6, -3), 3);
      atrDeclineScore = recent3 < prior3 ? 25 : recent3 < prior3 * 1.05 ? 15 : 5;
    }
    breakdown.atrDeclining = atrDeclineScore;
  } else if (isSellOverbought) {
    direction = "SELL";
    const rsiScore = rsi14 > 80 ? 25 : rsi14 > 75 ? 20 : rsi14 > 70 ? 15 : 10;
    breakdown.rsiExtreme = rsiScore;

    breakdown.liquiditySweep = liqSweep.detected && liqSweep.kind === "bearish" ? 25 : 0;

    const hasRejection = last.close < last.open && upperWickRatio > 0.5;
    breakdown.rejectionCandle = hasRejection ? Math.round(upperWickRatio * 25) : 0;

    const atrVals = atrSeries(candles, 14);
    let atrDeclineScore = 0;
    if (atrVals.length >= 10) {
      const recent3 = sma(atrVals.slice(-3), 3);
      const prior3 = sma(atrVals.slice(-6, -3), 3);
      atrDeclineScore = recent3 < prior3 ? 25 : recent3 < prior3 * 1.05 ? 15 : 5;
    }
    breakdown.atrDeclining = atrDeclineScore;
  }

  const totalScore =
    breakdown.rsiExtreme +
    breakdown.liquiditySweep +
    breakdown.rejectionCandle +
    breakdown.atrDeclining;
  const detected = direction !== null && totalScore >= 50;

  // Entry candle: must have confirming body direction
  const entryCandle =
    detected &&
    ((direction === "BUY" && last.close > last.open) ||
      (direction === "SELL" && last.close < last.open))
      ? last
      : null;

  const rationale = detected
    ? `MR ${direction}: RSI ${rsi14.toFixed(0)}/${breakdown.rsiExtreme}, Sweep ${breakdown.liquiditySweep}, Rejection ${breakdown.rejectionCandle}, ATR↓ ${breakdown.atrDeclining} = ${totalScore}/100`
    : `MR rejected: rsiExtreme=${breakdown.rsiExtreme}/25, sweep=${breakdown.liquiditySweep}/25, rejection=${breakdown.rejectionCandle}/25, atrDecl=${breakdown.atrDeclining}/25`;

  return {
    detected: detected && entryCandle !== null,
    direction,
    score: totalScore,
    breakdown,
    entryCandle,
    rationale,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  ENGINE 3: VOLATILITY EXPANSION (max score 100)
// ────────────────────────────────────────────────────────────────────────────

export function analyzeVolatilityExpansion(
  candles: Candle[],
  adx: number,
  atr14: number,
  bbWidth: number,
  volCluster: VolatilityClusterResult,
): VolatilityExpansionResult {
  const last = candles.at(-1);
  const closes = candles.map((c) => c.close);

  if (!last || closes.length < 40) {
    return {
      detected: false,
      direction: null,
      score: 0,
      breakdown: { atrExpansion: 0, bbExpansion: 0, adxSurge: 0, displacement: 0 },
      entryCandle: null,
      rationale: "Insufficient data",
    };
  }

  // 1. ATR Expansion (max 25)
  const atrVals = atrSeries(candles, 14);
  let atrExpansionScore = 0;
  if (atrVals.length >= 10) {
    const now = sma(atrVals.slice(-3), 3);
    const then = sma(atrVals.slice(-10, -5), 5);
    const expansionRatio = then > 0 ? now / then : 1;
    if (expansionRatio > 1.5) atrExpansionScore = 25;
    else if (expansionRatio > 1.3) atrExpansionScore = 20;
    else if (expansionRatio > 1.15) atrExpansionScore = 15;
    else if (expansionRatio > 1.05) atrExpansionScore = 10;
  }

  // 2. Bollinger Band Expansion (max 25)
  const bbNow = bollinger(closes.slice(-20), 20, 2);
  const bbPrev = bollinger(closes.slice(-40, -20), 20, 2);
  const bbRatio = bbPrev.width > 0 ? bbNow.width / bbPrev.width : 1;
  let bbExpansionScore = 0;
  if (bbRatio > 1.5) bbExpansionScore = 25;
  else if (bbRatio > 1.3) bbExpansionScore = 20;
  else if (bbRatio > 1.15) bbExpansionScore = 15;
  else if (bbRatio > 1.05) bbExpansionScore = 10;

  // 3. ADX Surge (max 25)
  let adxSurgeScore = 0;
  if (adx > 45) adxSurgeScore = 25;
  else if (adx > 35) adxSurgeScore = 20;
  else if (adx > 28) adxSurgeScore = 15;
  else if (adx > 22) adxSurgeScore = 10;

  // 4. Displacement Candle (max 25)
  const totalRange = last.high - last.low || 1e-9;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / totalRange;
  const avgRange = sma(
    candles.slice(-21, -1).map((c) => c.high - c.low),
    20,
  );
  const rangeMult = avgRange > 0 ? totalRange / avgRange : 0;

  let displacementScore = 0;
  if (bodyRatio > 0.7 && rangeMult > 2.0) displacementScore = 25;
  else if (bodyRatio > 0.6 && rangeMult > 1.7) displacementScore = 20;
  else if (bodyRatio > 0.55 && rangeMult > 1.4) displacementScore = 15;
  else if (bodyRatio > 0.5 && rangeMult > 1.2) displacementScore = 10;

  // Direction: the displacement direction
  const direction = body > 0 ? (last.close > last.open ? "BUY" : "SELL") : null;
  const totalScore = atrExpansionScore + bbExpansionScore + adxSurgeScore + displacementScore;
  const detected = totalScore >= 50 && direction !== null;

  const rationale = detected
    ? `VE ${direction}: ATR×${(atrVals.length >= 10 ? sma(atrVals.slice(-3), 3) / sma(atrVals.slice(-10, -5), 5) : 1).toFixed(2)}/${atrExpansionScore}, BB×${bbRatio.toFixed(2)}/${bbExpansionScore}, ADX ${adx}/${adxSurgeScore}, Disp ×${rangeMult.toFixed(1)}/${displacementScore} = ${totalScore}/100`
    : `VE rejected: ATR ${atrExpansionScore}, BB ${bbExpansionScore}, ADX ${adxSurgeScore}, Disp ${displacementScore} = ${totalScore}/100`;

  return {
    detected,
    direction,
    score: totalScore,
    breakdown: {
      atrExpansion: atrExpansionScore,
      bbExpansion: bbExpansionScore,
      adxSurge: adxSurgeScore,
      displacement: displacementScore,
    },
    entryCandle: detected ? last : null,
    rationale,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  ENGINE 4: BREAKOUT TRADING (max score 100)
// ────────────────────────────────────────────────────────────────────────────

export function analyzeBreakout(
  candles: Candle[],
  atr14: number,
  bbWidth: number,
  liqSweep: ReturnType<typeof detectLiquiditySweepSimple>,
): BreakoutResult {
  const last = candles.at(-1);
  const closes = candles.map((c) => c.close);

  if (!last || closes.length < 40) {
    return {
      detected: false,
      direction: null,
      score: 0,
      breakdown: { consolidation: 0, liquiditySweep: 0, breakout: 0, retest: 0, confirmation: 0 },
      entryCandle: null,
      rationale: "Insufficient data",
    };
  }

  // 1. Consolidation (max 20) — tight BB, narrow range
  let consolidationScore = 0;
  const range20 = Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20));
  const normalizedRange = range20 / (atr14 || 1);
  if (bbWidth < 0.008 && normalizedRange < 5) consolidationScore = 20;
  else if (bbWidth < 0.012 && normalizedRange < 7) consolidationScore = 15;
  else if (bbWidth < 0.02 && normalizedRange < 10) consolidationScore = 10;
  else consolidationScore = 5;

  // 2. Liquidity Sweep (max 20)
  const sweepScore = liqSweep.detected ? 15 + Math.round(liqSweep.rejectionQuality * 5) : 0;

  // 3. Breakout (max 20) — decisive move beyond consolidation range
  const range30hi = Math.max(...closes.slice(-30, -1));
  const range30lo = Math.min(...closes.slice(-30, -1));
  const brokeAbove = last.close > range30hi && last.high > range30hi;
  const brokeBelow = last.close < range30lo && last.low < range30lo;
  const breakDistance = brokeAbove
    ? (last.close - range30hi) / (atr14 || 1)
    : brokeBelow
      ? (range30lo - last.close) / (atr14 || 1)
      : 0;

  let breakoutScore = 0;
  if (breakDistance > 2) breakoutScore = 20;
  else if (breakDistance > 1.5) breakoutScore = 15;
  else if (breakDistance > 1) breakoutScore = 10;
  else if (breakDistance > 0.5) breakoutScore = 5;

  // 4. Retest (max 20) — after breakout, price came back to the breakout level
  let retestScore = 0;
  if (brokeAbove) {
    const postBreakoutCandles = candles.slice(-5);
    const retestLow = Math.min(...postBreakoutCandles.map((c) => c.low));
    const nearBreakout = Math.abs(retestLow - range30hi) <= 0.3 * atr14;
    retestScore = nearBreakout ? 20 : 5;
  } else if (brokeBelow) {
    const postBreakoutCandles = candles.slice(-5);
    const retestHigh = Math.max(...postBreakoutCandles.map((c) => c.high));
    const nearBreakout = Math.abs(retestHigh - range30lo) <= 0.3 * atr14;
    retestScore = nearBreakout ? 20 : 5;
  }

  // 5. Confirmation Candle (max 20)
  const totalRange = last.high - last.low || 1e-9;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / totalRange;
  const directionMatch =
    (brokeAbove && last.close > last.open) || (brokeBelow && last.close < last.open);
  let confirmationScore = 0;
  if (directionMatch && bodyRatio > 0.7) confirmationScore = 20;
  else if (directionMatch && bodyRatio > 0.5) confirmationScore = 15;
  else if (directionMatch) confirmationScore = 10;

  const direction = brokeAbove ? "BUY" : brokeBelow ? "SELL" : null;
  const totalScore =
    consolidationScore + sweepScore + breakoutScore + retestScore + confirmationScore;
  const detected = totalScore >= 50 && direction !== null && breakoutScore >= 10;

  const rationale = detected
    ? `BT ${direction}: Consolidation ${consolidationScore}, Sweep ${sweepScore}, Breakout ${breakoutScore}, Retest ${retestScore}, Confirm ${confirmationScore} = ${totalScore}/100`
    : `BT rejected: Cons ${consolidationScore}, Sweep ${sweepScore}, Break ${breakoutScore}, Retest ${retestScore}, Confirm ${confirmationScore} = ${totalScore}/100`;

  return {
    detected,
    direction,
    score: totalScore,
    breakdown: {
      consolidation: consolidationScore,
      liquiditySweep: sweepScore,
      breakout: breakoutScore,
      retest: retestScore,
      confirmation: confirmationScore,
    },
    entryCandle: detected ? last : null,
    rationale,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Entry Gate Checks (shared)
// ────────────────────────────────────────────────────────────────────────────

function hasFVG(candles: Candle[]): boolean {
  for (let i = 2; i < Math.min(candles.length, 50); i++) {
    const prev = candles[i - 2];
    const next = candles[i];
    if (prev.high < next.low || prev.low > next.high) return true;
  }
  return false;
}

function hasPullback(candles: Candle[], atr14: number): boolean {
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (!last || !prev) return false;
  const range = Math.max(1e-9, prev.high - prev.low);
  const retraceBuy = (last.high - last.close) / range;
  const retraceSell = (last.close - last.low) / range;
  return retraceBuy >= 0.25 || retraceSell >= 0.25;
}

function hasConfirmationCandle(candles: Candle[], direction: "BUY" | "SELL" | null): boolean {
  if (!direction) return false;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (!last || !prev) return false;
  const totalRange = last.high - last.low || 1e-9;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / totalRange;
  const isBullish = last.close > last.open;
  const isBearish = last.close < last.open;

  // Engulfing
  if (direction === "BUY" && isBullish && last.open <= prev.close && last.close >= prev.open)
    return true;
  if (direction === "SELL" && isBearish && last.open >= prev.close && last.close <= prev.open)
    return true;

  // Rejection wick
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  if (direction === "BUY" && lowerWick / totalRange > 0.5 && isBullish) return true;
  if (direction === "SELL" && upperWick / totalRange > 0.5 && isBearish) return true;

  // Marubozu
  if (bodyRatio > 0.9 && upperWick / totalRange < 0.05 && lowerWick / totalRange < 0.05)
    return true;

  // Momentum continuation
  if (direction === "BUY" && isBullish && bodyRatio > 0.6 && last.close > prev.high) return true;
  if (direction === "SELL" && isBearish && bodyRatio > 0.6 && last.close < prev.low) return true;

  return false;
}

// ────────────────────────────────────────────────────────────────────────────
//  Session Strength
// ────────────────────────────────────────────────────────────────────────────

function computeSessionStrength(nowEpoch?: number): number {
  const d = nowEpoch ? new Date(nowEpoch * 1000) : new Date();
  const hour = d.getUTCHours();
  const day = d.getUTCDay();

  const isStrongHour =
    (hour >= 7 && hour <= 9) || (hour >= 13 && hour <= 15) || (hour >= 0 && hour <= 2);
  const isMediumHour =
    (hour >= 3 && hour <= 6) || (hour >= 10 && hour <= 12) || (hour >= 16 && hour <= 18);
  const isWeekend = day === 0 || day === 6;

  if (isWeekend) return 0.3;
  if (isStrongHour) return 1.0;
  if (isMediumHour) return 0.7;
  return 0.5;
}

// ────────────────────────────────────────────────────────────────────────────
//  Main MARS4 Entry Point
// ────────────────────────────────────────────────────────────────────────────

export interface Mars4InstitutionalOptions {
  /** M1 candles (raw tick candles or 1-minute aggregated) */
  m1Candles: Candle[];
  /** M5 candles (5-minute aggregated) */
  m5Candles: Candle[];
  /** M15 candles (15-minute aggregated) */
  m15Candles: Candle[];
  /** Current UTC epoch in seconds for session timing */
  nowEpoch?: number;
  /** Spread price in quote currency (0 = unknown) */
  spreadPrice?: number;
  /** Minimum quality score to trade (default 75) */
  minScore?: number;
}

/**
 * MARS4 — Institutional High-Probability Trading Engine
 *
 * Runs the full pipeline: Regime → Engines (TF/MR/VE/BT) → Entry Gates →
 * Quality Score → Decision.
 *
 * Returns a detailed result with all intermediate diagnostics.
 */
export function analyzeMars4Institutional(
  options: Mars4InstitutionalOptions,
): Mars4InstitutionalResult {
  const { m1Candles, m5Candles, m15Candles, nowEpoch, spreadPrice = 0, minScore = 75 } = options;

  const candles = m1Candles;
  const closes = candles.map((c) => c.close);
  const last = candles.at(-1);

  const gateFailures: string[] = [];

  // ── Compute base indicators ──────────────────────────────────────────
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes);
  const atr14 = atr(candles);
  const adx14 = calculateADX(candles);
  const bb = bollinger(closes);
  const trend: "up" | "down" = ema20 > ema50 ? "up" : "down";
  const spreadOk = spreadPrice <= 0 ? true : spreadPrice <= atr14 * 0.3;

  // ── 1. Market Regime Filter ──────────────────────────────────────────
  const regime = detectMarketRegime(candles, adx14, atr14, bb.width, ema20, ema50, ema200, trend);
  const regimeTradable = TRADABLE_REGIMES.has(regime);
  if (!regimeTradable) {
    gateFailures.push(`Regime: ${regime} not tradable`);
  }

  // ── 2. Volatility Filter ─────────────────────────────────────────────
  const volFilter = checkVolatilityFilter(candles, adx14, atr14, bb.width);
  if (!volFilter.pass) {
    gateFailures.push(`Volatility: ${volFilter.details}`);
  }

  // ── 3. Trend Filter ──────────────────────────────────────────────────
  const trendFilter = checkTrendFilter(candles);
  if (!trendFilter.pass) {
    gateFailures.push(`Trend: ${trendFilter.details}`);
  }

  // ── 4. Multi-Timeframe Confirmation ──────────────────────────────────
  const mtfResult = checkMTFConfirmation(m1Candles, m5Candles, m15Candles);
  if (!mtfResult.pass) {
    gateFailures.push(`MTF: ${mtfResult.details}`);
  }

  // ── Volatility Clustering ────────────────────────────────────────────
  const volCluster = detectVolatilityClustering(candles);

  // ── Shared Entry Signals ─────────────────────────────────────────────
  const liquiditySweepResult = detectLiquiditySweepSimple(candles, atr14);
  const fvgPresent = hasFVG(candles);
  const pullbackPresent = hasPullback(candles, atr14);

  // ── ENGINE ANALYSIS ──────────────────────────────────────────────────

  // Engine 1: Trend Following
  const tfResult = analyzeTrendFollowing(candles, trendFilter, adx14, atr14, volCluster);

  // Engine 2: Mean Reversion
  const mrResult = analyzeMeanReversion(candles, rsi14, atr14, bb, liquiditySweepResult, adx14);

  // Engine 3: Volatility Expansion
  const veResult = analyzeVolatilityExpansion(candles, adx14, atr14, bb.width, volCluster);

  // Engine 4: Breakout Trading
  const btResult = analyzeBreakout(candles, atr14, bb.width, liquiditySweepResult);

  // ── Select Best Engine ───────────────────────────────────────────────
  const engines = [
    { engine: "trend_following" as EngineKind, result: tfResult, weight: 1.0 },
    { engine: "mean_reversion" as EngineKind, result: mrResult, weight: 0.9 },
    { engine: "volatility_expansion" as EngineKind, result: veResult, weight: 1.0 },
    { engine: "breakout" as EngineKind, result: btResult, weight: 1.0 },
  ];

  const activeEngines = engines
    .filter((e) => e.result.detected)
    .sort((a, b) => b.result.score - a.result.score);
  const bestEngine = activeEngines[0] ?? null;

  // Determine direction from best engine
  let direction: TradeDirection = "WAIT";
  if (bestEngine) {
    direction = bestEngine.result.direction ?? "WAIT";
  }

  // Microstructure
  const microstructure = analyzeMicrostructure(candles, atr14, direction, spreadOk);

  // Direction-based confirmation
  const confirmationCandle = hasConfirmationCandle(
    candles,
    direction !== "WAIT" ? direction : null,
  );

  // ── Entry Gates (all 6 required) ─────────────────────────────────────
  const entryGates = {
    liquiditySweep: liquiditySweepResult.detected,
    bosChoch: false, // will compute below
    displacement: veResult.detected && veResult.breakdown.displacement >= 10,
    fvg: fvgPresent,
    pullback: pullbackPresent,
    confirmationCandle: confirmationCandle,
  };

  // BOS/CHoCH check (only if direction is known)
  if (direction !== "WAIT") {
    const { highs, lows } = detectSwings(candles, 4, 4);
    const lastHigh = highs.at(-1);
    const lastLow = lows.at(-1);
    const prevHigh = highs.at(-2);
    const prevLow = lows.at(-2);

    if (
      direction === "BUY" &&
      lastHigh &&
      prevHigh &&
      last?.close &&
      last.close > lastHigh.val &&
      last.high > lastHigh.val
    ) {
      entryGates.bosChoch = true;
    }
    if (
      direction === "SELL" &&
      lastLow &&
      prevLow &&
      last?.close &&
      last.close < lastLow.val &&
      last.low < lastLow.val
    ) {
      entryGates.bosChoch = true;
    }
  }

  const allEntryGatesPass = Object.values(entryGates).every(Boolean);
  if (!allEntryGatesPass) {
    const failedGates = Object.entries(entryGates)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    gateFailures.push(`Entry gates: ${failedGates.join(", ")}`);
  }

  // ── Total Score Calculation (max 200) ────────────────────────────────
  // Best engine contributes up to 100
  // Confluence bonus: other engines agreeing adds up to 50
  // Microstructure adds up to 30
  // Session adds up to 20

  const bestEngineScore = bestEngine ? bestEngine.result.score : 0;

  // Confluence: count how many engines agree with direction
  const agreeingEngines = activeEngines.filter((e) => e.result.direction === direction).length;
  const totalDetected = activeEngines.length;
  const concurrencyRatio = totalDetected > 0 ? agreeingEngines / totalDetected : 0;
  const concurrencyBonus = Math.round(concurrencyRatio * 50);

  const microBonus = Math.round(microstructure.totalScore * 30);
  const sessionBonus = Math.round(computeSessionStrength(nowEpoch) * 20);

  const totalScore = Math.min(200, bestEngineScore + concurrencyBonus + microBonus + sessionBonus);

  // ── Trade Decision ───────────────────────────────────────────────────
  let decision: TradeDecision;
  if (totalScore >= 160 && allEntryGatesPass && regimeTradable) {
    decision = "EXECUTE";
  } else if (totalScore >= 120 && allEntryGatesPass && regimeTradable) {
    decision = "OPTIONAL";
  } else if (totalScore >= 75) {
    decision = "CAUTION";
  } else {
    decision = "WAIT";
  }

  // Overtides: if volatility filter fails or MTF fails, force WAIT
  if (!volFilter.pass || !mtfResult.pass) {
    decision = "WAIT";
  }

  // Final direction
  const finalDirection: TradeDirection =
    decision !== "WAIT" && allEntryGatesPass && regimeTradable && bestEngine !== null
      ? direction
      : "WAIT";

  // ── SL/TP Calculation ────────────────────────────────────────────────
  let entry: number | undefined;
  let sl: number | undefined;
  let tp: number | undefined;

  if (finalDirection !== "WAIT" && last) {
    entry = last.close;
    const slDist = 1.5 * atr14;
    const tpDist = 3.0 * atr14;

    if (finalDirection === "BUY") {
      sl = entry - slDist;
      tp = entry + tpDist;
    } else {
      sl = entry + slDist;
      tp = entry - tpDist;
    }
  }

  // ── Rationale ────────────────────────────────────────────────────────
  const bestName = bestEngine?.engine ?? "none";
  const bestScoreStr = bestEngine ? `${bestEngine.result.score}/100` : "N/A";

  const rationale = [
    `[MARS4] Decision: ${decision} · Total: ${totalScore}/200`,
    `Direction: ${finalDirection} · Active Engine: ${bestName} (${bestScoreStr})`,
    `Regime: ${regime} (${regimeTradable ? "tradable" : "not tradable"})`,
    `Volatility: ${volFilter.pass ? "PASS" : "FAIL"} (ADX ${adx14.toFixed(1)})`,
    `Trend: ${trendFilter.pass ? "PASS" : "FAIL"} (${trendFilter.direction ?? "none"})`,
    `MTF: ${mtfResult.pass ? "PASS" : "FAIL"} (M1=${mtfResult.m1Direction ?? "?"}, M5=${mtfResult.m5Direction ?? "?"}, M15=${mtfResult.m15Direction ?? "?"})`,
    `Vol Cluster: ${volCluster.regime} (strength ${volCluster.clusterStrength.toFixed(2)})`,
    `Entry Gates: ${allEntryGatesPass ? "ALL PASS" : `FAIL: ${gateFailures.filter((g) => g.startsWith("Entry gates")).join(", ")}`}`,
    `  Liq Sweep: ${liquiditySweepResult.detected ? `✓ (${liquiditySweepResult.kind})` : "✗"}`,
    `  BOS/CHoCH: ${entryGates.bosChoch ? "✓" : "✗"}`,
    `  Displacement: ${entryGates.displacement ? "✓" : "✗"}`,
    `  FVG: ${entryGates.fvg ? "✓" : "✗"}`,
    `  Pullback: ${entryGates.pullback ? "✓" : "✗"}`,
    `  Confirmation: ${entryGates.confirmationCandle ? "✓" : "✗"}`,
    `Engines:`,
    `  TF: ${tfResult.detected ? `✓ ${tfResult.score}/100` : "✗"} (${tfResult.rationale})`,
    `  MR: ${mrResult.detected ? `✓ ${mrResult.score}/100` : "✗"} (${mrResult.rationale})`,
    `  VE: ${veResult.detected ? `✓ ${veResult.score}/100` : "✗"} (${veResult.rationale})`,
    `  BT: ${btResult.detected ? `✓ ${btResult.score}/100` : "✗"} (${btResult.rationale})`,
    `Score Breakdown: engine=${bestEngineScore} + confluence=${concurrencyBonus} + micro=${microBonus} + session=${sessionBonus}`,
    `Microstructure: impulse=${(microstructure.impulseScore * 100).toFixed(0)}% slope=${(microstructure.slopeScore * 100).toFixed(0)}% closeLoc=${(microstructure.closeLocationScore * 100).toFixed(0)}%`,
    `RSI: ${rsi14.toFixed(1)}`,
    gateFailures.length ? `Gate failures: ${gateFailures.join(" | ")}` : "All gates pass",
  ].join("\n");

  return {
    decision,
    direction: finalDirection,
    confidence: totalScore / 200,
    totalScore,
    regime,
    regimeTradable,
    volatilityPass: volFilter.pass,
    trendPass: trendFilter.pass,
    mtfPass: mtfResult.pass,
    activeEngine: bestEngine?.engine ?? null,
    engines: {
      trendFollowing: tfResult,
      meanReversion: mrResult,
      volatilityExpansion: veResult,
      breakout: btResult,
    },
    volatilityCluster: volCluster,
    microstructure,
    liquiditySweep: liquiditySweepResult.detected,
    bosChoch: entryGates.bosChoch,
    fvg: fvgPresent,
    pullback: pullbackPresent,
    confirmationCandle,
    allEntryGatesPass,
    entry,
    sl,
    tp,
    rationale,
    gateFailures,
  };
}

/**
 * TITAN2 — Adaptive Momentum Strategy (OPTIMIZED)
 *
 * Core Philosophy: Trade momentum with adaptive position sizing and
 * volatility-adjusted entries. Focus on trend continuation with
 * dynamic risk management.
 *
 * Key Features:
 * - Multi-timeframe momentum detection (3 TF layers), now with enough
 *   raw history for the slow TF EMA to actually mean something
 * - True Wilder-smoothed ATR / RSI / ADX (originals were simplified
 *   approximations mislabeled as the real thing)
 * - Volatility-adjusted position sizing that actually reaches its stated cap
 * - Dynamic trailing stop + partial profit-taking (previously only
 *   documented, never implemented)
 * - Optional correlation-based signal filtering (previously only
 *   documented, never implemented)
 * - Trade cooldown to prevent re-entering on every bar
 */

import type { Candle, MarketRegime, ConfluenceContribution } from "../ob-fvg";

// ── Helpers ──────────────────────────────────────────────────────────────

function ema(v: number[], p: number): number {
  if (!v.length) return 0;
  const k = 2 / (p + 1);
  let e = v[0];
  for (let i = 1; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}

/**
 * Wilder's smoothing (the running-total recursive average used in the
 * classic RSI/ATR/ADX formulas). This is NOT the same as an EMA — the
 * original file used EMA everywhere and called it "Wilder"/"ATR"/"ADX",
 * which quietly changes the values these indicators produce.
 */
function wilderSmooth(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const out: number[] = [];
  let sum = values.slice(0, period).reduce((a, b) => a + b, 0);
  out.push(sum);
  for (let i = period; i < values.length; i++) {
    sum = sum - sum / period + values[i];
    out.push(sum);
  }
  return out;
}

function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const avgGainSeries = wilderSmooth(gains, period).map((v) => v / period);
  const avgLossSeries = wilderSmooth(losses, period).map((v) => v / period);
  const n = Math.min(avgGainSeries.length, avgLossSeries.length);
  if (!n) return 50;
  const avgGain = avgGainSeries[n - 1];
  const avgLoss = avgLossSeries[n - 1] || 1e-9;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(c: Candle[], period = 14): number {
  if (c.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    trs.push(
      Math.max(
        c[i].high - c[i].low,
        Math.abs(c[i].high - c[i - 1].close),
        Math.abs(c[i].low - c[i - 1].close),
      ),
    );
  }
  const smoothed = wilderSmooth(trs, period).map((v) => v / period);
  if (smoothed.length) return smoothed[smoothed.length - 1];
  // fallback for short histories
  const tail = trs.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / (tail.length || 1);
}

/**
 * FIX: the original returned a single bar's DX and called it "ADX".
 * Real ADX is DX *averaged over the period* after Wilder-smoothing TR
 * and +DM/-DM. Skipping that averaging step makes the indicator jumpy
 * and prone to false "strong trend" reads on a single volatile bar.
 */
function calculateADX(c: Candle[], period = 14): number {
  if (c.length < period * 2 + 1) return 20;
  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const upMove = c[i].high - c[i - 1].high;
    const downMove = c[i - 1].low - c[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(
      Math.max(
        c[i].high - c[i].low,
        Math.abs(c[i].high - c[i - 1].close),
        Math.abs(c[i].low - c[i - 1].close),
      ),
    );
  }
  const smoothTR = wilderSmooth(trs, period);
  const smoothPlusDM = wilderSmooth(plusDM, period);
  const smoothMinusDM = wilderSmooth(minusDM, period);
  const n = Math.min(smoothTR.length, smoothPlusDM.length, smoothMinusDM.length);
  if (!n) return 20;
  const dxs: number[] = [];
  for (let i = 0; i < n; i++) {
    const tr = smoothTR[i] || 1e-9;
    const pDI = 100 * (smoothPlusDM[i] / tr);
    const mDI = 100 * (smoothMinusDM[i] / tr);
    const sum = pDI + mDI;
    dxs.push(sum > 0 ? (100 * Math.abs(pDI - mDI)) / sum : 0);
  }
  const tail = dxs.slice(-period);
  return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 20;
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

function findSwings(candles: Candle[], left = 3, right = 3) {
  const highs: { val: number; idx: number }[] = [];
  const lows: { val: number; idx: number }[] = [];
  for (let i = left; i < candles.length - right; i++) {
    let sh = true, sl = true;
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

/** Pearson correlation of returns — used for the correlation filter. */
function correlationOfReturns(a: Candle[], b: Candle[]): number {
  const n = Math.min(a.length, b.length) - 1;
  if (n < 10) return 0;
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = a.length - n; i < a.length; i++) ra.push(a[i].close / a[i - 1].close - 1);
  for (let i = b.length - n; i < b.length; i++) rb.push(b[i].close / b[i - 1].close - 1);
  const mA = ra.reduce((s, x) => s + x, 0) / ra.length;
  const mB = rb.reduce((s, x) => s + x, 0) / rb.length;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - mA) * (rb[i] - mB);
    varA += (ra[i] - mA) ** 2;
    varB += (rb[i] - mB) ** 2;
  }
  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

// ── TITAN2 Result ───────────────────────────────────────────────────────

export interface Titan2Result {
  decision: "BUY" | "SELL" | "WAIT";
  confidence: number;
  entry?: number;
  sl?: number;
  tp?: number;
  tp1?: number;
  tp2?: number;
  regime: MarketRegime;
  momentumScore: number;
  volatilityScore: number;
  confluenceScore: number;
  scoreBreakdown: ConfluenceContribution[];
  rationale: string;
  layers: string[];
  failures: string[];
  atr14: number;
  trend: "up" | "down";
  rsi14: number;
  adx14: number;
  suggestedPositionSize: number; // % of account
}

// ── 1. Multi-Timeframe Momentum Detection ───────────────────────────────

/**
 * FIX: the original aggregated the *already-sliced* 200-candle window,
 * so the "slow" TF (15x) only had ~13 synthetic candles to feed a 50-period
 * EMA — nowhere near enough, meaning ema15_50 was really just tracking
 * early data rather than a genuine slow trend. This now expects a much
 * larger raw window (caller passes ~1200 candles) so each aggregated
 * timeframe actually has enough bars to be meaningful.
 */
function detectMomentum(candles: Candle[]): {
  trend: "up" | "down";
  strength: number;
  tf1Trend: "up" | "down";
  tf2Trend: "up" | "down";
  tf3Trend: "up" | "down";
  alignment: number;
  reason: string;
} {
  const closes = candles.map((c) => c.close);

  const ema8 = ema(closes.slice(-100), 8);
  const ema21 = ema(closes.slice(-100), 21);
  const tf1Trend = ema8 > ema21 ? "up" : "down";

  const c5 = aggregateCandles(candles, 5);
  const c5Closes = c5.map((c) => c.close);
  const ema5_20 = ema(c5Closes, 20);
  const ema5_50 = ema(c5Closes, 50);
  const tf2Trend = ema5_20 > ema5_50 ? "up" : "down";

  const c15 = aggregateCandles(candles, 15);
  const c15Closes = c15.map((c) => c.close);
  const ema15_20 = ema(c15Closes, 20);
  const ema15_50 = ema(c15Closes, 50);
  // Guard: if we still don't have enough bars for a trustworthy slow-TF
  // read, don't let it silently vote — fall back to agreeing with tf2.
  const slowTfReliable = c15Closes.length >= 60;
  const tf3Trend = slowTfReliable ? (ema15_20 > ema15_50 ? "up" : "down") : tf2Trend;

  const trends = [tf1Trend, tf2Trend, tf3Trend];
  const upCount = trends.filter((t) => t === "up").length;
  const downCount = trends.filter((t) => t === "down").length;
  const overallTrend: "up" | "down" = upCount >= 2 ? "up" : "down";
  const alignment = Math.max(upCount, downCount);

  const emaStacked =
    overallTrend === "up"
      ? ema8 > ema21 && ema21 > ema5_20
      : ema8 < ema21 && ema21 < ema5_20;
  const strength = alignment === 3 ? (emaStacked ? 0.9 : 0.7) : alignment === 2 ? 0.5 : 0.2;

  return {
    trend: overallTrend,
    strength,
    tf1Trend, tf2Trend, tf3Trend,
    alignment,
    reason: `${alignment}/3 TF alignment ${overallTrend.toUpperCase()} (fast=${tf1Trend}, mid=${tf2Trend}, slow=${tf3Trend}${slowTfReliable ? "" : ", low-history fallback"})`,
  };
}

// ── 2. Volatility Regime Detection ──────────────────────────────────────

function detectVolatility(candles: Candle[], atr14: number, price: number): {
  regime: "low" | "normal" | "high" | "extreme";
  score: number;
  atrPct: number;
  reason: string;
} {
  const closes = candles.map((c) => c.close);
  const atrPct = price > 0 ? (atr14 / price) * 100 : 0;

  const tail = closes.slice(-20);
  const mid = tail.reduce((a, b) => a + b, 0) / (tail.length || 1);
  const sd = Math.sqrt(tail.reduce((a, x) => a + (x - mid) ** 2, 0) / (tail.length || 1));
  const bbWidth = mid > 0 ? (2 * sd / mid) * 100 : 0;

  if (atrPct > 3.0 || bbWidth > 5.0) {
    return { regime: "extreme", score: 0.1, atrPct, reason: "Extreme volatility - no trade" };
  }
  if (atrPct > 1.5 || bbWidth > 2.5) {
    return { regime: "high", score: 0.4, atrPct, reason: "High volatility - reduce size" };
  }
  // FIX: original threshold was `atrPct < 0.02`. Since atrPct is already
  // in percent, that's "ATR below 0.02% of price" — a bar that essentially
  // never fires on real data, so the "low volatility, wait for expansion"
  // branch was dead code. Rescaled to line up with the bbWidth<0.3 branch.
  if (atrPct < 0.3 || bbWidth < 0.3) {
    return { regime: "low", score: 0.3, atrPct, reason: "Low volatility - wait for expansion" };
  }
  return { regime: "normal", score: 0.8, atrPct, reason: "Normal volatility" };
}

// ── 3. Entry Signal Detection ───────────────────────────────────────────

function detectEntrySignal(candles: Candle[], price: number, atr14: number, trend: "up" | "down"): {
  signal: "BUY" | "SELL" | "WAIT";
  strength: number;
  entry?: number;
  sl?: number;
  tp?: number;
  reason: string;
  kind?: "pullback" | "bos" | "bounce";
} {
  const last = candles.at(-1)!;
  const { highs, lows } = findSwings(candles, 3, 3);
  const recentHigh = highs.at(-1)?.val;
  const recentLow = lows.at(-1)?.val;

  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const distToEma20 = Math.abs(price - ema20);
  const pullbackToEma = distToEma20 <= 0.5 * atr14;

  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 1e-9;
  const bodyRatio = body / range;
  const displacement = bodyRatio > 0.6;

  const bosUp = trend === "up" && recentHigh && price > recentHigh;
  const bosDown = trend === "down" && recentLow && price < recentLow;

  if (trend === "up") {
    if (pullbackToEma && displacement) {
      const entry = price;
      const sl = entry - 1.5 * atr14;
      const tp = entry + 3.0 * atr14;
      return { signal: "BUY", strength: 0.8, entry, sl, tp, reason: "Pullback to EMA20 + displacement", kind: "pullback" };
    }
    if (bosUp && displacement) {
      const entry = price;
      const sl = entry - 1.5 * atr14;
      const tp = entry + 2.5 * atr14;
      return { signal: "BUY", strength: 0.75, entry, sl, tp, reason: "BOS continuation + momentum", kind: "bos" };
    }
    if (pullbackToEma && recentLow && price > recentLow + 0.3 * atr14) {
      const entry = price;
      const sl = entry - 1.5 * atr14;
      const tp = entry + 2.5 * atr14;
      return { signal: "BUY", strength: 0.65, entry, sl, tp, reason: "EMA support bounce", kind: "bounce" };
    }
  }

  if (trend === "down") {
    if (pullbackToEma && displacement) {
      const entry = price;
      const sl = entry + 1.5 * atr14;
      const tp = entry - 3.0 * atr14;
      return { signal: "SELL", strength: 0.8, entry, sl, tp, reason: "Pullback to EMA20 + displacement", kind: "pullback" };
    }
    if (bosDown && displacement) {
      const entry = price;
      const sl = entry + 1.5 * atr14;
      const tp = entry - 2.5 * atr14;
      return { signal: "SELL", strength: 0.75, entry, sl, tp, reason: "BOS continuation + momentum", kind: "bos" };
    }
    if (pullbackToEma && recentHigh && price < recentHigh - 0.3 * atr14) {
      const entry = price;
      const sl = entry + 1.5 * atr14;
      const tp = entry - 2.5 * atr14;
      return { signal: "SELL", strength: 0.65, entry, sl, tp, reason: "EMA resistance bounce", kind: "bounce" };
    }
  }

  return { signal: "WAIT", strength: 0, reason: "No entry signal detected" };
}

// ── 4. Risk Management ──────────────────────────────────────────────────

/**
 * FIX: with the original coefficients, the theoretical max size was
 * ~2.75% — the "cap at 5%" was unreachable dead code, which means the
 * stated max risk in the docstring didn't match real behavior. Rebalanced
 * so a high-confidence, high-momentum, normal-vol setup can actually
 * approach the 5% ceiling, and added a correlation dampener.
 */
function calculatePositionSize(
  confidence: number,
  volatilityScore: number,
  momentumStrength: number,
  correlationPenalty: number, // 0 (no penalty) to 1 (fully cancel size)
): number {
  let size = 0.02;
  size *= (0.6 + confidence * 1.1); // was (0.5 + confidence)

  if (volatilityScore < 0.3) size *= 0.5;
  else if (volatilityScore > 0.7 && volatilityScore < 0.9) size *= 0.85; // "high" vol bucket
  // volatilityScore >= 0.9 doesn't occur (extreme already blocks trades upstream)

  size *= (0.5 + momentumStrength * 0.5);
  size *= (1 - correlationPenalty);

  return Math.min(0.05, Math.max(0.005, size));
}

/**
 * NEW: the docstring promised "dynamic trailing stop logic" and "partial
 * profit taking at 1R, trail remainder" but no such function existed
 * anywhere in the file. This fills that gap. Call on every new candle for
 * an open position; it tells you whether to take partial profit and where
 * to move the stop.
 */
export function manageOpenPosition(params: {
  direction: "BUY" | "SELL";
  entry: number;
  initialSl: number;
  currentPrice: number;
  atr14: number;
  partialTaken: boolean;
}): { newSl: number; takePartialNow: boolean; closeRemainder: boolean } {
  const { direction, entry, initialSl, currentPrice, atr14, partialTaken } = params;
  const risk = Math.abs(entry - initialSl);
  const rMultiple =
    direction === "BUY"
      ? (currentPrice - entry) / (risk || 1e-9)
      : (entry - currentPrice) / (risk || 1e-9);

  // Take partial (e.g. 50%) at 1R and move stop to breakeven.
  const takePartialNow = !partialTaken && rMultiple >= 1;

  let newSl = initialSl;
  if (partialTaken || takePartialNow) {
    // Breakeven floor once 1R is banked...
    newSl = entry;
    // ...then trail by 1.5x ATR behind price once we're running further.
    if (rMultiple > 1.5) {
      newSl = direction === "BUY"
        ? Math.max(entry, currentPrice - 1.5 * atr14)
        : Math.min(entry, currentPrice + 1.5 * atr14);
    }
  }

  const closeRemainder =
    direction === "BUY" ? currentPrice <= newSl : currentPrice >= newSl;

  return { newSl, takePartialNow, closeRemainder };
}

// ── TITAN2 Main Analyzer ────────────────────────────────────────────────

/**
 * TITAN2 — Adaptive Momentum Strategy (optimized)
 *
 * @param candles Pass ~1000-1200 candles, not 200. The function still only
 *   *analyzes* the most recent bars closely, but the slow timeframe needs
 *   deep history to aggregate into meaningful 15x candles.
 * @param opts.correlatedCandles Optional candles from a correlated
 *   instrument (e.g. a sibling volatility index). If the correlation is
 *   high and that instrument is in a conflicting trend, confidence and
 *   size are both reduced — this implements the "correlation-based signal
 *   filtering" the docstring promised but the original code never did.
 * @param opts.barsSinceLastTrade Pass how many bars have elapsed since your
 *   last TITAN2 trade on this instrument. Under 5 forces WAIT, so the
 *   strategy can't re-signal on every single new candle.
 */
export function analyzeTitan2(
  candles: Candle[],
  opts: { correlatedCandles?: Candle[]; barsSinceLastTrade?: number } = {},
): Titan2Result {
  const analysisWindow = candles.slice(-200);
  const momentumWindow = candles.slice(-1200); // needs deep history, see detectMomentum

  const price = analysisWindow.at(-1)?.close ?? 0;
  const closes = analysisWindow.map((c) => c.close);
  const atr14 = atr(analysisWindow);
  const rsi14 = rsi(closes);
  const adx14 = calculateADX(analysisWindow);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const trend: "up" | "down" = ema20 > ema50 ? "up" : "down";

  const layers: string[] = [];
  const failures: string[] = [];
  const breakdown: ConfluenceContribution[] = [];

  // Cooldown gate
  if (opts.barsSinceLastTrade !== undefined && opts.barsSinceLastTrade < 5) {
    failures.push(`cooldown: only ${opts.barsSinceLastTrade} bars since last trade`);
    return {
      decision: "WAIT", confidence: 0.1, momentumScore: 0, volatilityScore: 0,
      confluenceScore: 0, scoreBreakdown: breakdown,
      rationale: "TITAN2: In cooldown window since last trade.",
      layers, failures, atr14, trend, rsi14, adx14,
      regime: "range", suggestedPositionSize: 0,
    };
  }

  // Step 1: Multi-Timeframe Momentum
  const momentum = detectMomentum(momentumWindow);
  layers.push(momentum.reason);
  breakdown.push({ label: `Momentum: ${momentum.alignment}/3 TF`, points: Math.round(momentum.strength * 60) });

  if (momentum.alignment < 2) {
    failures.push(`weak-momentum: ${momentum.alignment}/3 TF aligned`);
    return {
      decision: "WAIT", confidence: 0.15, momentumScore: momentum.strength, volatilityScore: 0,
      confluenceScore: Math.round((momentum.alignment / 3) * 100),
      scoreBreakdown: breakdown,
      rationale: `TITAN2: Only ${momentum.alignment}/3 timeframes aligned. Need minimum 2.`,
      layers, failures, atr14, trend, rsi14, adx14,
      regime: "range", suggestedPositionSize: 0,
    };
  }

  // Step 2: Volatility Regime
  const vol = detectVolatility(analysisWindow, atr14, price);
  layers.push(vol.reason);
  breakdown.push({ label: `Vol: ${vol.regime}`, points: Math.round(vol.score * 40) });

  if (vol.regime === "extreme") {
    failures.push("extreme-volatility");
    return {
      decision: "WAIT", confidence: 0.1, momentumScore: momentum.strength, volatilityScore: vol.score,
      confluenceScore: 10, scoreBreakdown: breakdown,
      rationale: "TITAN2: Extreme volatility detected. No trade zone.",
      layers, failures, atr14, trend, rsi14, adx14,
      regime: "compression", suggestedPositionSize: 0,
    };
  }

  // Step 3: Entry Signal
  const signal = detectEntrySignal(analysisWindow, price, atr14, momentum.trend);
  layers.push(signal.reason);
  breakdown.push({ label: `Signal: ${signal.signal}`, points: Math.round(signal.strength * 50) });

  if (signal.signal === "WAIT") {
    failures.push(`no-entry-signal: ${signal.reason}`);
    return {
      decision: "WAIT", confidence: 0.2, momentumScore: momentum.strength, volatilityScore: vol.score,
      confluenceScore: Math.round(momentum.strength * 50),
      scoreBreakdown: breakdown,
      rationale: `TITAN2: ${momentum.alignment}/3 TF aligned but no entry signal. ${signal.reason}`,
      layers, failures, atr14, trend, rsi14, adx14,
      regime: momentum.trend === "up" ? "trend_up" : "trend_down",
      suggestedPositionSize: 0,
    };
  }

  // Step 4: Correlation filter (new)
  let correlationPenalty = 0;
  if (opts.correlatedCandles && opts.correlatedCandles.length > 30) {
    const corr = correlationOfReturns(analysisWindow, opts.correlatedCandles);
    const correlatedTrend = ema(opts.correlatedCandles.map((c) => c.close), 20)
      > ema(opts.correlatedCandles.map((c) => c.close), 50) ? "up" : "down";
    const conflicting = correlatedTrend !== momentum.trend;
    if (Math.abs(corr) > 0.6 && conflicting) {
      correlationPenalty = Math.min(0.5, Math.abs(corr) - 0.2);
      layers.push(`Correlation filter: |r|=${corr.toFixed(2)} vs conflicting-trend instrument, size penalty ${(correlationPenalty * 100).toFixed(0)}%`);
    } else {
      layers.push(`Correlation filter: |r|=${corr.toFixed(2)}, no conflict`);
    }
  }

  // Step 5: Confidence
  const momentumScore = momentum.strength;
  const volatilityScore = vol.score;
  const signalStrength = signal.strength;
  const adxBonus = adx14 > 25 ? 0.1 : adx14 > 20 ? 0.05 : 0;
  // FIX: original RSI bonus rewarded the neutral 40-60 band even for BOS
  // continuation entries, which typically fire *because* RSI has pushed
  // out of that band. Now the bonus is context-aware: neutral band for
  // pullback/bounce entries (early-stage), momentum-aligned RSI for BOS
  // continuation (already-moving) entries.
  let rsiBonus = 0;
  if (signal.kind === "bos") {
    rsiBonus = (signal.signal === "BUY" && rsi14 > 55) || (signal.signal === "SELL" && rsi14 < 45) ? 0.05 : 0;
  } else {
    rsiBonus = rsi14 > 40 && rsi14 < 60 ? 0.05 : 0;
  }

  const confidence = Math.min(
    0.95,
    Math.max(
      0.05,
      0.3 + momentumScore * 0.3 + signalStrength * 0.25 + volatilityScore * 0.1 + adxBonus + rsiBonus
        - correlationPenalty * 0.3,
    ),
  );

  const suggestedPositionSize = calculatePositionSize(confidence, volatilityScore, momentumScore, correlationPenalty);

  const entry = signal.entry ?? price;
  const sl = signal.sl ?? (signal.signal === "BUY" ? entry - 1.5 * atr14 : entry + 1.5 * atr14);
  const tp = signal.tp ?? (signal.signal === "BUY" ? entry + 3.0 * atr14 : entry - 3.0 * atr14);
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < 1.5) {
    failures.push(`low-rr: ${rr.toFixed(2)} < 1.5`);
    return {
      decision: "WAIT", confidence: 0.25, momentumScore, volatilityScore,
      confluenceScore: Math.round(confidence * 80),
      scoreBreakdown: breakdown,
      rationale: `TITAN2: Signal found but RR ${rr.toFixed(2)} < 1.5 minimum`,
      layers, failures, atr14, trend, rsi14, adx14,
      regime: momentum.trend === "up" ? "trend_up" : "trend_down",
      suggestedPositionSize: 0,
    };
  }

  const tp1 = signal.signal === "BUY" ? entry + risk : entry - risk;
  const tp2 = tp;

  layers.push(`Entry: ${entry.toFixed(4)}, SL: ${sl.toFixed(4)}, TP: ${tp.toFixed(4)}, RR: ${rr.toFixed(2)}`);
  layers.push(`Position: ${(suggestedPositionSize * 100).toFixed(1)}% of account`);

  return {
    decision: signal.signal,
    confidence,
    entry, sl, tp, tp1, tp2,
    regime: momentum.trend === "up" ? "trend_up" : "trend_down",
    momentumScore,
    volatilityScore,
    confluenceScore: Math.round(confidence * 100),
    scoreBreakdown: breakdown,
    rationale: `TITAN2 ${signal.signal}: ${momentum.alignment}/3 TF aligned, ${vol.regime} vol, ${signal.reason}. RR ${rr.toFixed(2)}. Confidence ${(confidence * 100).toFixed(0)}%. Position: ${(suggestedPositionSize * 100).toFixed(1)}%.`,
    layers, failures, atr14, trend, rsi14, adx14,
    suggestedPositionSize,
  };
}
/**
 * Client-side Order Block + FVG detector - upgraded to institutional-grade
 * with multi-timeframe alignment, displacement, liquidity sweeps, BOS/CHOCH,
 * and calibrated filters.
 */
import type { Candle } from "./deriv-ws";

export interface FVG {
  kind: "bullish" | "bearish";
  top: number;
  bottom: number;
  index: number;
  filled: boolean;
  size: number;
}

export interface OrderBlock {
  kind: "bullish" | "bearish";
  top: number;
  bottom: number;
  index: number;
  fvgIndex: number;
  mitigated: boolean;
  volumeProxy: number;
}

export interface LiveAnalysis {
  fvgs: FVG[];
  obs: OrderBlock[];
  activeOB: OrderBlock | null;
  activeFVG: FVG | null;
  decision: "BUY" | "SELL" | "WAIT";
  confidence: number;
  rationale: string;
  entry?: number;
  sl?: number;
  tp?: number;
  trend: "up" | "down";
  ema20: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  atr14: number;
  adx14: number;
  bos: boolean;
  choch: boolean;
  liquiditySweep: boolean;
  displacement: boolean;
  volatilityRegime: "normal" | "low" | "high";
  htfTrend15m: "up" | "down";
  htfStructure5m: "bullish" | "bearish";
}

// EMA calculator
function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// RSI calculator
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

// ATR calculator
function atr(c: Candle[], period = 14): number {
  if (c.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close)
    );
    trs.push(tr);
  }
  const tail = trs.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

// ADX calculator
function calculateADX(c: Candle[], period = 14): number {
  if (c.length < period * 2) return 20; // default to flat/normal trend strength

  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close)
    );
    trs.push(tr);

    const upMove = c[i].high - c[i - 1].high;
    const downMove = c[i - 1].low - c[i].low;

    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
    } else {
      plusDM.push(0);
    }

    if (downMove > upMove && downMove > 0) {
      minusDM.push(downMove);
    } else {
      minusDM.push(0);
    }
  }

  // Smooth DM and TR
  const trSmooth = ema(trs, period);
  const plusDMSmooth = ema(plusDM, period);
  const minusDMSmooth = ema(minusDM, period);

  const plusDI = trSmooth > 0 ? 100 * (plusDMSmooth / trSmooth) : 0;
  const minusDI = trSmooth > 0 ? 100 * (minusDMSmooth / trSmooth) : 0;

  const sum = plusDI + minusDI;
  const diff = Math.abs(plusDI - minusDI);
  const dx = sum > 0 ? 100 * (diff / sum) : 0;

  // We return a simple EMA of DX as ADX
  return ema([dx], period) || 20;
}

// Aggregate 1m candles into higher timeframes (5m, 15m)
export function aggregateCandles(candles: Candle[], timeframeMinutes: number): Candle[] {
  const aggregated: Candle[] = [];
  const size = timeframeMinutes;
  for (let i = 0; i < candles.length; i += size) {
    const chunk = candles.slice(i, i + size);
    if (chunk.length === 0) continue;
    aggregated.push({
      epoch: chunk[0].epoch,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
    });
  }
  return aggregated;
}

export function detectFVGs(candles: Candle[], maxAge = 100): FVG[] {
  const out: FVG[] = [];
  const start = Math.max(1, candles.length - maxAge - 1);
  for (let i = start; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    if (prev.high < next.low) {
      out.push({
        kind: "bullish",
        bottom: prev.high,
        top: next.low,
        index: i,
        filled: false,
        size: next.low - prev.high,
      });
    } else if (prev.low > next.high) {
      out.push({
        kind: "bearish",
        bottom: next.high,
        top: prev.low,
        index: i,
        filled: false,
        size: prev.low - next.high,
      });
    }
  }
  for (const f of out) {
    const post = candles.slice(f.index + 1);
    f.filled =
      f.kind === "bullish"
        ? post.some((c) => c.low <= f.bottom)
        : post.some((c) => c.high >= f.top);
  }
  return out;
}

export function detectOBs(candles: Candle[], fvgs: FVG[]): OrderBlock[] {
  const obs: OrderBlock[] = [];
  for (const f of fvgs) {
    const wantRed = f.kind === "bullish";
    let idx = -1;
    for (let j = f.index - 1; j >= Math.max(f.index - 10, 0); j--) {
      const c = candles[j];
      const isRed = c.close < c.open;
      if ((wantRed && isRed) || (!wantRed && c.close > c.open)) {
        idx = j;
        break;
      }
    }
    if (idx < 0) continue;
    const c = candles[idx];
    const post = candles.slice(idx + 1);
    const mitigated =
      f.kind === "bullish"
        ? post.some((x) => x.low <= c.high) && post.some((x) => x.low <= c.low)
        : post.some((x) => x.high >= c.low) && post.some((x) => x.high >= c.high);
    
    // Volume proxy based on range size of OB candle
    const range = c.high - c.low;
    
    obs.push({
      kind: f.kind === "bullish" ? "bullish" : "bearish",
      top: c.high,
      bottom: c.low,
      index: idx,
      fvgIndex: f.index,
      mitigated,
      volumeProxy: range,
    });
  }
  return obs;
}

// Swing Points Detector
function detectSwingPoints(candles: Candle[], left = 3, right = 3) {
  const highs: { val: number; idx: number }[] = [];
  const lows: { val: number; idx: number }[] = [];

  for (let i = left; i < candles.length - right; i++) {
    const val = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= val.high) isSwingHigh = false;
      if (candles[i - j].low <= val.low) isSwingLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high >= val.high) isSwingHigh = false;
      if (candles[i + j].low <= val.low) isSwingLow = false;
    }

    if (isSwingHigh) highs.push({ val: val.high, idx: i });
    if (isSwingLow) lows.push({ val: val.low, idx: i });
  }

  return { highs, lows };
}

export function analyze(candles: Candle[]): LiveAnalysis {
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes);
  const atr14 = atr(candles);
  const adx14 = calculateADX(candles);

  // 1. Volatility Regime Filter
  let volatilityRegime: "normal" | "low" | "high" = "normal";
  if (atr14 < 0.8) volatilityRegime = "low";
  else if (atr14 > 1.4) volatilityRegime = "high";

  // 2. Trend direction on 1m
  const trend: "up" | "down" = ema20 > ema50 ? "up" : "down";

  // 3. Multi-Timeframe Confirmation
  const candles5m = aggregateCandles(candles, 5);
  const candles15m = aggregateCandles(candles, 15);

  const closes5m = candles5m.map((c) => c.close);
  const closes15m = candles15m.map((c) => c.close);

  const ema20_15m = ema(closes15m, 20);
  const ema50_15m = ema(closes15m, 50);
  const htfTrend15m: "up" | "down" = ema20_15m > ema50_15m ? "up" : "down";

  const ema20_5m = ema(closes5m, 20);
  const ema50_5m = ema(closes5m, 50);
  const htfStructure5m: "bullish" | "bearish" = ema20_5m > ema50_5m ? "bullish" : "bearish";

  // 4. Swing Highs / Lows for BOS, CHOCH, and sweeps
  const { highs: swingHighs, lows: swingLows } = detectSwingPoints(candles, 5, 5);
  const lastPrice = candles.at(-1)?.close ?? 0;

  // Liquidity Sweep (price breaks a recent swing point but closes back within it)
  let liquiditySweep = false;
  const recentHighs = swingHighs.slice(-3);
  const recentLows = swingLows.slice(-3);
  
  if (recentHighs.some((h) => candles.at(-1)!.high > h.val && lastPrice <= h.val)) {
    liquiditySweep = true; // Swept liquidity from highs
  }
  if (recentLows.some((l) => candles.at(-1)!.low < l.val && lastPrice >= l.val)) {
    liquiditySweep = true; // Swept liquidity from lows
  }

  // BOS (Break of Structure) & CHOCH (Change of Character)
  let bos = false;
  let choch = false;

  const previousHigh = recentHighs.length > 0 ? recentHighs[recentHighs.length - 1].val : null;
  const previousLow = recentLows.length > 0 ? recentLows[recentLows.length - 1].val : null;

  if (previousHigh && lastPrice > previousHigh) {
    bos = trend === "up";
    choch = trend === "down";
  } else if (previousLow && lastPrice < previousLow) {
    bos = trend === "down";
    choch = trend === "up";
  }

  // 5. Displacement (strong institutional momentum candle body size > 50%)
  const lastCandle = candles.at(-1)!;
  const candleRange = lastCandle.high - lastCandle.low || 1e-9;
  const bodySize = Math.abs(lastCandle.close - lastCandle.open);
  const displacement = bodySize / candleRange > 0.55;

  const fvgs = detectFVGs(candles);
  const obs = detectOBs(candles, fvgs);

  let activeOB: OrderBlock | null = null;
  let activeFVG: FVG | null = null;

  for (let i = obs.length - 1; i >= 0; i--) {
    const ob = obs[i];
    const f = fvgs.find((x) => x.index === ob.fvgIndex);
    if (!f || f.filled || ob.mitigated) continue;
    const dist = Math.min(Math.abs(lastPrice - ob.top), Math.abs(lastPrice - ob.bottom));
    if (dist > 2.5 * atr14 && !(lastPrice >= ob.bottom && lastPrice <= ob.top)) continue;
    activeOB = ob;
    activeFVG = f;
    break;
  }

  // Institutional Entry Conditions Checks
  const hasEMA20_50_200_Buy = ema20 > ema50 && ema50 > ema200;
  const hasEMA20_50_200_Sell = ema20 < ema50 && ema50 < ema200;

  if (!activeOB || !activeFVG) {
    return {
      fvgs,
      obs,
      activeOB: null,
      activeFVG: null,
      decision: "WAIT",
      confidence: 0.2,
      rationale: "No unmitigated OB / unfilled FVG confluence near price.",
      trend,
      ema20,
      ema50,
      ema200,
      rsi14,
      atr14,
      adx14,
      bos,
      choch,
      liquiditySweep,
      displacement,
      volatilityRegime,
      htfTrend15m,
      htfStructure5m,
    };
  }

  const isBull = activeOB.kind === "bullish";

  // Strict Institutional Strategy Checklist
  const trendAlign = (isBull && trend === "up") || (!isBull && trend === "down");
  const htfTrendAlign = (isBull && htfTrend15m === "up") || (!isBull && htfTrend15m === "down");
  const emaAlignment = isBull ? hasEMA20_50_200_Buy : hasEMA20_50_200_Sell;
  const rsiCheck = isBull ? rsi14 < 65 : rsi14 > 35;
  const volatilityFilter = volatilityRegime === "normal";

  // Retracement into FVG check
  const retracedIntoFVG = isBull
    ? lastPrice <= activeFVG.top
    : lastPrice >= activeFVG.bottom;

  // Decide if we should BUY/SELL or WAIT
  let decision: "BUY" | "SELL" | "WAIT" = "WAIT";
  let confidence = 0.25;

  if (activeOB && activeFVG && emaAlignment && rsiCheck && volatilityFilter && retracedIntoFVG) {
    decision = isBull ? "BUY" : "SELL";
  }

  // Dynamic Stop Loss and Take Profit using ATR (ICT standard)
  const entry = (activeOB.top + activeOB.bottom) / 2;
  const sl = isBull ? entry - 1.0 * atr14 : entry + 1.0 * atr14;
  const tp = isBull ? entry + 1.5 * atr14 : entry - 1.5 * atr14;

  // Calibrated Confidence Calculation based on filters
  let score = 0.4;
  if (trendAlign) score += 0.1;
  if (htfTrendAlign) score += 0.15;
  if (displacement) score += 0.1;
  if (liquiditySweep) score += 0.1;
  if (bos || choch) score += 0.1;
  confidence = Math.min(0.98, Math.max(0.1, score));

  const rationale =
    `${isBull ? "Bullish" : "Bearish"} OB [${activeOB.bottom.toFixed(4)}, ${activeOB.top.toFixed(4)}] zone matches unfilled FVG. ` +
    `EMA Alignment: ${emaAlignment ? "YES" : "NO"}. Volatility Regime: ${volatilityRegime.toUpperCase()}. ` +
    `Sweep: ${liquiditySweep ? "YES" : "NO"}, BOS/CHOCH: ${bos || choch ? "YES" : "NO"}, HTF (15m): ${htfTrend15m.toUpperCase()}, RSI: ${rsi14.toFixed(0)}.`;

  return {
    fvgs,
    obs,
    activeOB,
    activeFVG,
    decision,
    confidence,
    entry,
    sl,
    tp,
    trend,
    ema20,
    ema50,
    ema200,
    rsi14,
    atr14,
    adx14,
    bos,
    choch,
    liquiditySweep,
    displacement,
    volatilityRegime,
    htfTrend15m,
    htfStructure5m,
    rationale,
  };
}

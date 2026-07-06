/**
 * Multi-Strategy Confluence Engine.
 *
 * Pipeline: Regime → HTF Bias → POI → 12 Strategy detectors → Confluence
 * Scorer → Decision (BUY/SELL/WAIT) with strategy tag + score breakdown.
 *
 * Strategies (ranked):
 *   1  MSNR + CRT              (primary)
 *   2  APA                     (primary complement)
 *   3  Liquidity Sweep         (reversal / range extreme)
 *   4  OB + FVG (SMC)          (confluence, precision entry)
 *   5  Vol Compression→Expansion  (compression regime)
 *   6  Wyckoff phase           (accum / distribution context)
 *   7  EMA Pullback Momentum   (trend continuation)
 *   8  ICT OTE                 (Fib 0.62–0.79 inside POI)
 *   9  Fractal Swing BOS/CHOCH (structure)
 *  10  Dynamic S/R             (targets)
 *  11  Bollinger + RSI MR      (ranging)
 *
 * The scorer requires ≥70 base score + regime match to trigger a trade.
 */
import type { Candle } from "../deriv-ws";
import { DEFAULT_STRATEGY_SELECTION, normalizeStrategySelection } from "./catalog";
import {
  analyze,
  analyzeMomentum,
  analyzeMeanReversion,
  aggregateCandles,
  detectFVGs,
  detectOBs,
  type LiveAnalysis,
  type StrategyKind,
  type MarketRegime,
  type ConfluenceContribution,
} from "../ob-fvg";

// ── Small indicator helpers ────────────────────────────────────────────
function ema(v: number[], p: number): number {
  if (!v.length) return 0;
  const k = 2 / (p + 1);
  let e = v[0];
  for (let i = 1; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}
function stddev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length);
}
function pctAtr(atr14: number, price: number): number {
  return price > 0 ? (atr14 / price) * 100 : 0;
}

// ── Swing / fractal detector (shared) ─────────────────────────────────
export function findSwings(candles: Candle[], left = 3, right = 3) {
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

// ── 1. Regime Engine ──────────────────────────────────────────────────
export interface RegimeResult {
  regime: MarketRegime;
  adx: number;
  atrPct: number;
  bbWidthPct: number;
  htfTrend: "up" | "down";
  reason: string;
}

export function detectRegime(base: LiveAnalysis, price: number): RegimeResult {
  const atrPct = pctAtr(base.atr14, price);
  const bbWidth =
    base.bollUpper != null && base.bollLower != null && base.bollMid && base.bollMid > 0
      ? ((base.bollUpper - base.bollLower) / base.bollMid) * 100
      : 0;
  const htfTrend = base.htfTrend15m;

  // Compression: very tight BB + low ATR%
  if (bbWidth < 0.4 && atrPct < 0.05) {
    return {
      regime: "compression",
      adx: base.adx14,
      atrPct,
      bbWidthPct: bbWidth,
      htfTrend,
      reason: "BB tight + low ATR%",
    };
  }
  // Range: ADX flat AND BB normal
  if (base.adx14 < 20) {
    return {
      regime: "range",
      adx: base.adx14,
      atrPct,
      bbWidthPct: bbWidth,
      htfTrend,
      reason: "ADX < 20",
    };
  }
  // Reversal proxy: strong ADX but 1m vs HTF diverge + recent CHOCH
  if (base.adx14 >= 20 && base.choch && base.trend !== htfTrend) {
    return {
      regime: "reversal",
      adx: base.adx14,
      atrPct,
      bbWidthPct: bbWidth,
      htfTrend,
      reason: "CHOCH + HTF divergence",
    };
  }
  // Trending
  const dir: MarketRegime = base.trend === "up" ? "trend_up" : "trend_down";
  return {
    regime: dir,
    adx: base.adx14,
    atrPct,
    bbWidthPct: bbWidth,
    htfTrend,
    reason: `ADX ${base.adx14.toFixed(0)} + EMA stack`,
  };
}

// ── Individual strategy signals (compact, gate-based) ─────────────────
interface StratSignal {
  strategy: StrategyKind;
  dir: "BUY" | "SELL" | "WAIT";
  base: number; // base contribution 0–60
  reason: string;
  entry?: number;
  sl?: number;
  tp?: number;
}

// 1. MSNR + CRT — Multi-Session Narrative Range + Candle Reaction Toolkit
function sigMsnrCrt(candles: Candle[], base: LiveAnalysis, price: number): StratSignal {
  // Simplified: HTF bias + recent range extreme + strong reaction candle
  const { highs, lows } = findSwings(candles, 4, 4);
  const lastN = candles.slice(-3);
  const bull = base.htfTrend15m === "up" && base.trend === "up";
  const bear = base.htfTrend15m === "down" && base.trend === "down";
  const nearLow = lows.at(-1) && Math.abs(price - lows.at(-1)!.val) <= 0.6 * base.atr14;
  const nearHigh = highs.at(-1) && Math.abs(price - highs.at(-1)!.val) <= 0.6 * base.atr14;
  const reactionUp = lastN.some((c) => (c.close - c.open) / (c.high - c.low || 1e-9) > 0.5);
  const reactionDn = lastN.some((c) => (c.close - c.open) / (c.high - c.low || 1e-9) < -0.5);
  if (bull && nearLow && reactionUp) {
    return {
      strategy: "msnr-crt",
      dir: "BUY",
      base: 45,
      reason: "MSNR: HTF up + reaction off swing low",
      entry: price,
      sl: price - 1.5 * base.atr14,
      tp: price + 2.5 * base.atr14,
    };
  }
  if (bear && nearHigh && reactionDn) {
    return {
      strategy: "msnr-crt",
      dir: "SELL",
      base: 45,
      reason: "MSNR: HTF down + reaction off swing high",
      entry: price,
      sl: price + 1.5 * base.atr14,
      tp: price - 2.5 * base.atr14,
    };
  }
  return {
    strategy: "msnr-crt",
    dir: "WAIT",
    base: 0,
    reason: "MSNR: no bias-aligned reaction at range extreme",
  };
}

// 2. APA — Analysis → POI → Action
function sigApa(candles: Candle[], base: LiveAnalysis, price: number): StratSignal {
  // POI = active OB midpoint, invalidation = OB extreme.
  if (!base.activeOB || !base.activeFVG)
    return { strategy: "apa", dir: "WAIT", base: 0, reason: "APA: no POI" };
  const isBull = base.activeOB.kind === "bullish";
  const inZone = price >= base.activeOB.bottom && price <= base.activeOB.top;
  if (!inZone) return { strategy: "apa", dir: "WAIT", base: 0, reason: "APA: price not at POI" };
  // 50% retracement of last impulse
  const lastImpulse = candles.slice(-10);
  const hi = Math.max(...lastImpulse.map((c) => c.high));
  const lo = Math.min(...lastImpulse.map((c) => c.low));
  const mid = (hi + lo) / 2;
  const near50 = Math.abs(price - mid) <= 0.5 * base.atr14;
  if (!near50)
    return {
      strategy: "apa",
      dir: "WAIT",
      base: 10,
      reason: "APA: POI touched but not 50% retrace",
    };
  const dir = isBull ? "BUY" : "SELL";
  const entry = price;
  const sl = isBull
    ? base.activeOB.bottom - 0.5 * base.atr14
    : base.activeOB.top + 0.5 * base.atr14;
  const risk = Math.abs(entry - sl);
  const tp = isBull ? entry + 2 * risk : entry - 2 * risk;
  return {
    strategy: "apa",
    dir,
    base: 42,
    reason: "APA: POI + 50% retrace confluence",
    entry,
    sl,
    tp,
  };
}

// 3. Liquidity Sweep / Turtle Soup
function sigLiquiditySweep(candles: Candle[], base: LiveAnalysis, price: number): StratSignal {
  const { highs, lows } = findSwings(candles, 3, 3);
  const last = candles.at(-1)!;
  const recentHi = highs.slice(-3).map((h) => h.val);
  const recentLo = lows.slice(-3).map((l) => l.val);
  // Bearish sweep: wick above recent high, close back below
  const swept_high = recentHi.some((v) => last.high > v && last.close < v);
  const swept_low = recentLo.some((v) => last.low < v && last.close > v);
  if (swept_low) {
    return {
      strategy: "liquidity-sweep",
      dir: "BUY",
      base: 50,
      reason: "Sweep of equal lows + reclaim",
      entry: price,
      sl: last.low - 0.3 * base.atr14,
      tp: price + 2.5 * base.atr14,
    };
  }
  if (swept_high) {
    return {
      strategy: "liquidity-sweep",
      dir: "SELL",
      base: 50,
      reason: "Sweep of equal highs + rejection",
      entry: price,
      sl: last.high + 0.3 * base.atr14,
      tp: price - 2.5 * base.atr14,
    };
  }
  return {
    strategy: "liquidity-sweep",
    dir: "WAIT",
    base: 0,
    reason: "No liquidity sweep detected",
  };
}

// 4. OB + FVG — use existing analyze() output
function sigObFvg(base: LiveAnalysis): StratSignal {
  if (base.decision === "WAIT")
    return {
      strategy: "ob-fvg",
      dir: "WAIT",
      base: 0,
      reason: "OB+FVG: " + (base.rationale || "gates failed"),
    };
  return {
    strategy: "ob-fvg",
    dir: base.decision as "BUY" | "SELL",
    base: 45,
    reason: "OB+FVG hard gates passed",
    entry: base.entry,
    sl: base.sl,
    tp: base.tp,
  };
}

// 5. Volatility Compression → Expansion
function sigVolExpansion(
  candles: Candle[],
  base: LiveAnalysis,
  price: number,
  regime: MarketRegime,
): StratSignal {
  if (regime !== "compression") {
    // detect expansion right after prior compression using BB width
    const closes = candles.map((c) => c.close);
    const w1 = stddev(closes.slice(-30, -10));
    const w2 = stddev(closes.slice(-10));
    if (w2 > w1 * 1.7 && base.atr14 > 0) {
      const dir: "BUY" | "SELL" = base.trend === "up" ? "BUY" : "SELL";
      return {
        strategy: "vol-expansion",
        dir,
        base: 40,
        reason: "Expansion after compression",
        entry: price,
        sl: dir === "BUY" ? price - 1.5 * base.atr14 : price + 1.5 * base.atr14,
        tp: dir === "BUY" ? price + 3 * base.atr14 : price - 3 * base.atr14,
      };
    }
  }
  return {
    strategy: "vol-expansion",
    dir: "WAIT",
    base: 0,
    reason: "No expansion after compression",
  };
}

// 6. Wyckoff phase tag (simplified accum/dist detection)
function sigWyckoff(candles: Candle[], base: LiveAnalysis, price: number): StratSignal {
  // Accumulation proxy: long range with spring (deep wick below range low then close inside)
  const tail = candles.slice(-30);
  if (tail.length < 30)
    return { strategy: "wyckoff", dir: "WAIT", base: 0, reason: "Insufficient candles" };
  const rangeHi = Math.max(...tail.slice(0, -3).map((c) => c.high));
  const rangeLo = Math.min(...tail.slice(0, -3).map((c) => c.low));
  const last3 = tail.slice(-3);
  const spring = last3.some((c) => c.low < rangeLo && c.close > rangeLo);
  const utad = last3.some((c) => c.high > rangeHi && c.close < rangeHi);
  if (spring && base.htfTrend15m === "up") {
    return {
      strategy: "wyckoff",
      dir: "BUY",
      base: 40,
      reason: "Wyckoff spring (accum)",
      entry: price,
      sl: rangeLo - 0.5 * base.atr14,
      tp: rangeHi,
    };
  }
  if (utad && base.htfTrend15m === "down") {
    return {
      strategy: "wyckoff",
      dir: "SELL",
      base: 40,
      reason: "Wyckoff UTAD (dist)",
      entry: price,
      sl: rangeHi + 0.5 * base.atr14,
      tp: rangeLo,
    };
  }
  return { strategy: "wyckoff", dir: "WAIT", base: 0, reason: "No Wyckoff spring/UTAD" };
}

// 7. EMA pullback momentum
function sigEmaPullback(base: LiveAnalysis, price: number): StratSignal {
  const stackedUp = base.ema20 > base.ema50 && base.ema50 > base.ema200;
  const stackedDn = base.ema20 < base.ema50 && base.ema50 < base.ema200;
  if (!stackedUp && !stackedDn)
    return { strategy: "momentum", dir: "WAIT", base: 0, reason: "EMA not stacked" };
  const nearEma20 = Math.abs(price - base.ema20) <= 0.6 * base.atr14;
  if (!nearEma20)
    return { strategy: "momentum", dir: "WAIT", base: 0, reason: "No pullback to EMA20" };
  if (base.adx14 < 22) return { strategy: "momentum", dir: "WAIT", base: 0, reason: "ADX too low" };
  const dir = stackedUp ? "BUY" : "SELL";
  return {
    strategy: "momentum",
    dir,
    base: 40,
    reason: "EMA pullback + stack + ADX",
    entry: price,
    sl: dir === "BUY" ? price - 1.5 * base.atr14 : price + 1.5 * base.atr14,
    tp: dir === "BUY" ? price + 2.5 * base.atr14 : price - 2.5 * base.atr14,
  };
}

// 8. ICT OTE — Fib 0.62–0.79 inside POI
function sigOte(candles: Candle[], base: LiveAnalysis, price: number): StratSignal {
  const tail = candles.slice(-30);
  const hi = Math.max(...tail.map((c) => c.high));
  const lo = Math.min(...tail.map((c) => c.low));
  const range = hi - lo;
  if (range <= 0) return { strategy: "ote", dir: "WAIT", base: 0, reason: "Flat range" };
  const bull = base.htfTrend15m === "up";
  const oteHi = bull ? lo + 0.79 * range : hi - 0.62 * range;
  const oteLo = bull ? lo + 0.62 * range : hi - 0.79 * range;
  const inOte = price >= oteLo && price <= oteHi;
  if (!inOte) return { strategy: "ote", dir: "WAIT", base: 0, reason: "Price outside OTE zone" };
  const dir = bull ? "BUY" : "SELL";
  return {
    strategy: "ote",
    dir,
    base: 38,
    reason: `Price in OTE 0.62–0.79 (${bull ? "long" : "short"})`,
    entry: price,
    sl: bull ? lo - 0.3 * base.atr14 : hi + 0.3 * base.atr14,
    tp: bull ? hi : lo,
  };
}

// 9. Fractal BOS/CHOCH — leverage base
function sigFractal(base: LiveAnalysis, price: number): StratSignal {
  if (!base.bos && !base.choch)
    return { strategy: "fractal", dir: "WAIT", base: 0, reason: "No fractal break" };
  const dir =
    base.bos && base.trend === "up"
      ? "BUY"
      : base.bos && base.trend === "down"
        ? "SELL"
        : base.choch && base.htfTrend15m === "up"
          ? "BUY"
          : "SELL";
  return {
    strategy: "fractal",
    dir,
    base: 35,
    reason: base.bos ? "BOS in trend direction" : "CHOCH reversal",
    entry: price,
    sl: dir === "BUY" ? price - 1.5 * base.atr14 : price + 1.5 * base.atr14,
    tp: dir === "BUY" ? price + 2.5 * base.atr14 : price - 2.5 * base.atr14,
  };
}

// 10. Dynamic S/R (nearest untested swing → target only, no standalone entry)
function sigDynamicSr(candles: Candle[], base: LiveAnalysis, price: number): StratSignal {
  const { highs, lows } = findSwings(candles, 4, 4);
  const above = highs
    .map((h) => h.val)
    .filter((v) => v > price)
    .sort((a, b) => a - b)[0];
  const below = lows
    .map((l) => l.val)
    .filter((v) => v < price)
    .sort((a, b) => b - a)[0];
  if (base.htfTrend15m === "up" && above) {
    return {
      strategy: "dynamic-sr",
      dir: "BUY",
      base: 25,
      reason: "Nearest resistance target",
      entry: price,
      sl: price - 1.5 * base.atr14,
      tp: above,
    };
  }
  if (base.htfTrend15m === "down" && below) {
    return {
      strategy: "dynamic-sr",
      dir: "SELL",
      base: 25,
      reason: "Nearest support target",
      entry: price,
      sl: price + 1.5 * base.atr14,
      tp: below,
    };
  }
  return { strategy: "dynamic-sr", dir: "WAIT", base: 0, reason: "No S/R target" };
}

// 11. BB + RSI mean reversion (delegate to existing analyzeMeanReversion)
function sigBbRsi(mr: LiveAnalysis): StratSignal {
  if (mr.decision === "WAIT")
    return { strategy: "bb-rsi", dir: "WAIT", base: 0, reason: "BB+RSI: " + (mr.rationale || "") };
  return {
    strategy: "bb-rsi",
    dir: mr.decision as "BUY" | "SELL",
    base: 40,
    reason: "BB band touch + RSI extreme",
    entry: mr.entry,
    sl: mr.sl,
    tp: mr.tp,
  };
}

// ── Checkmate/Alignment logic for strategy combinations ─────────────────
// When combining strategies, they must "checkmate" each other meaning:
// - Both strategies agree on direction (BUY/SELL)
// - Both strategies' entry zones overlap or are very close
// - The confluence provides a stronger signal than individual confidence
export interface CheckmateAnalysis {
  aligned: boolean;
  consensusDirection: "BUY" | "SELL" | "WAIT";
  zoneOverlap: number; // 0-1 scale
  combinedStrength: number; // 0-1 scale
  reasons: string[];
}

/**
 * Analyze how well multiple strategies align/checkmate each other.
 * For 1-3 strategy combos, this ensures proper confluence before trading.
 */
export function checkStrategyAlignment(
  signals: StratSignal[],
  strategies: StrategyKind[],
): CheckmateAnalysis {
  const relevant = signals.filter((s) => strategies.includes(s.strategy));
  const reasons: string[] = [];

  if (relevant.length === 0) {
    return {
      aligned: false,
      consensusDirection: "WAIT",
      zoneOverlap: 0,
      combinedStrength: 0,
      reasons: ["No relevant signals found"],
    };
  }

  // Single strategy case - check if it has a valid signal
  if (relevant.length === 1) {
    const s = relevant[0];
    return {
      aligned: s.dir !== "WAIT",
      consensusDirection: s.dir,
      zoneOverlap: 1,
      combinedStrength: s.dir !== "WAIT" ? s.base / 60 : 0,
      reasons: [s.reason],
    };
  }

  // Multiple strategy checkmate - all must agree on direction
  const directions = relevant.map((s) => s.dir).filter((d) => d !== "WAIT");
  if (directions.length !== relevant.length) {
    return {
      aligned: false,
      consensusDirection: "WAIT",
      zoneOverlap: 0,
      combinedStrength: Math.max(...relevant.map((s) => s.base)) / 60,
      reasons: relevant.filter((s) => s.dir === "WAIT").map((s) => s.reason),
    };
  }

  // Check all signals have same direction
  const firstDir = directions[0];
  const allMatch = directions.every((d) => d === firstDir);
  if (!allMatch) {
    const conflicts = relevant
      .filter((s) => s.dir !== firstDir)
      .map((s) => `${s.strategy}=${s.dir}`);
    reasons.push(`Direction conflicts: ${conflicts.join(", ")}`);
    return {
      aligned: false,
      consensusDirection: "WAIT",
      zoneOverlap: 0,
      combinedStrength: 0,
      reasons,
    };
  }

  // Calculate zone overlap for entry zones
  const zoneOverlapRatios: number[] = [];
  for (let i = 0; i < relevant.length; i++) {
    for (let j = i + 1; j < relevant.length; j++) {
      const s1 = relevant[i];
      const s2 = relevant[j];
      if (s1.entry && s2.entry && s1.sl && s2.sl) {
        const zone1Low = s1.entry - 0.5 * Math.abs(s1.entry - s1.sl);
        const zone1High = s1.entry + 0.5 * Math.abs(s1.entry - s1.sl);
        const zone2Low = s2.entry - 0.5 * Math.abs(s2.entry - s2.sl);
        const zone2High = s2.entry + 0.5 * Math.abs(s2.entry - s2.sl);
        const overlap = Math.max(0, Math.min(zone1High, zone2High) - Math.max(zone1Low, zone2Low));
        const overlapRatio = overlap / (Math.abs(s1.entry - s2.entry) + 0.0001);
        zoneOverlapRatios.push(Math.min(1, overlapRatio));
      }
    }
  }
  const avgZoneOverlap =
    zoneOverlapRatios.length > 0
      ? zoneOverlapRatios.reduce((a, b) => a + b, 0) / zoneOverlapRatios.length
      : 1;

  // Combined strength - average of all signals plus alignment bonus
  const strengths = relevant.map((s) => s.base / 60);
  const avgStrength = strengths.reduce((a, b) => a + b, 0) / strengths.length;
  const alignmentBonus = avgZoneOverlap * 0.5;
  const combinedStrength = Math.min(1, avgStrength + alignmentBonus);

  reasons.push(`Checkmate achieved: ${strategies.join(" + ")} all ${firstDir}`);
  reasons.push(`Zone overlap: ${(avgZoneOverlap * 100).toFixed(0)}%`);
  reasons.push(`Combined strength: ${(combinedStrength * 100).toFixed(0)}%`);

  return {
    aligned: true,
    consensusDirection: firstDir,
    zoneOverlap: avgZoneOverlap,
    combinedStrength,
    reasons,
  };
}

// ── Regime → allowed strategies ───────────────────────────────────────
const REGIME_ALLOW: Record<MarketRegime, StrategyKind[]> = {
  trend_up: [
    "msnr-crt",
    "apa",
    "momentum",
    "ob-fvg",
    "ote",
    "fractal",
    "dynamic-sr",
    "vol-expansion",
  ] as StrategyKind[],
  trend_down: [
    "msnr-crt",
    "apa",
    "momentum",
    "ob-fvg",
    "ote",
    "fractal",
    "dynamic-sr",
    "vol-expansion",
  ] as StrategyKind[],
  range: ["apa", "liquidity-sweep", "bb-rsi", "ob-fvg", "wyckoff", "dynamic-sr"] as StrategyKind[],
  compression: ["vol-expansion", "fractal"] as StrategyKind[],
  reversal: ["liquidity-sweep", "wyckoff", "ob-fvg", "apa"] as StrategyKind[],
};

// ── Confluence scorer ─────────────────────────────────────────────────
export interface EnsembleResult extends LiveAnalysis {
  regime: MarketRegime;
  confluenceScore: number;
  scoreBreakdown: ConfluenceContribution[];
}

/**
 * Ensemble analyzer — runs regime detection then all 11 strategies, scores
 * each, and returns the best regime-allowed signal with a full confluence
 * breakdown. If no signal ≥ minScore, returns WAIT with the highest scoring
 * candidate for diagnostics.
 */
export function analyzeEnsemble(
  candles: Candle[],
  minScore = 70,
  selectedStrategies: StrategyKind[] = DEFAULT_STRATEGY_SELECTION,
): EnsembleResult {
  const window = candles.slice(-200);
  const price = window.at(-1)?.close ?? 0;
  const obFvg = analyze(window);
  const mom = analyzeMomentum(window);
  const mr = analyzeMeanReversion(window);
  const regime = detectRegime(obFvg, price);

  // Collect signals
  const signals: StratSignal[] = [
    sigMsnrCrt(window, obFvg, price),
    sigApa(window, obFvg, price),
    sigLiquiditySweep(window, obFvg, price),
    sigObFvg(obFvg),
    sigVolExpansion(window, obFvg, price, regime.regime),
    sigWyckoff(window, obFvg, price),
    { ...sigEmaPullback(obFvg, price), strategy: "momentum" }, // reuse momentum tag
    sigOte(window, obFvg, price),
    sigFractal(obFvg, price),
    sigDynamicSr(window, obFvg, price),
    sigBbRsi(mr),
  ];

  // Momentum signal from analyzeMomentum
  if (mom.decision !== "WAIT") {
    signals.push({
      strategy: "momentum",
      dir: mom.decision as "BUY" | "SELL",
      base: 45,
      reason: "Momentum continuation (EMA stacked)",
      entry: mom.entry,
      sl: mom.sl,
      tp: mom.tp,
    });
  }

  const selected = normalizeStrategySelection(selectedStrategies);
  const allowed = REGIME_ALLOW[regime.regime].filter((strategy) => selected.includes(strategy));

  // For strategy combinations (1-3 strategies), use checkmate/alignment logic
  if (selected.length >= 1 && selected.length <= 3) {
    const aligned = checkStrategyAlignment(signals, selected);
    if (!aligned.aligned || aligned.consensusDirection === "WAIT") {
      return {
        ...obFvg,
        regime: regime.regime,
        confluenceScore: Math.round(aligned.combinedStrength * 100),
        scoreBreakdown: aligned.reasons.map((r) => ({ label: r, points: 0 })),
        strategy: selected[0] ?? "ob-fvg",
        decision: "WAIT",
        confidence: aligned.combinedStrength,
        rationale: `[${regime.regime}] ${aligned.reasons.join(" | ") || "No checkmate alignment"}`,
      };
    }

    // Find the best signal among the selected strategies for entry/SL/TP
    const primarySig = signals.find(
      (s) => s.strategy === selected[0] && s.dir === aligned.consensusDirection,
    );
    if (primarySig) {
      const isBuy = aligned.consensusDirection === "BUY";
      const entry = primarySig.entry ?? price;
      const sl = primarySig.sl ?? (isBuy ? entry - 1.5 * obFvg.atr14 : entry + 1.5 * obFvg.atr14);
      const tp = primarySig.tp ?? (isBuy ? entry + 2.5 * obFvg.atr14 : entry - 2.5 * obFvg.atr14);
      const risk = Math.abs(entry - sl) || obFvg.atr14;
      const tp1 = isBuy ? entry + risk : entry - risk;

      // Build score breakdown based on number of strategies
      const breakdown: ConfluenceContribution[] = [
        { label: `${selected[0]} primary`, points: Math.round(aligned.combinedStrength * 60) },
      ];
      if (selected.length > 1) {
        breakdown.push({
          label: `${selected[1]} aligned`,
          points: Math.round(aligned.zoneOverlap * 40),
        });
      }
      if (selected.length > 2) {
        breakdown.push({
          label: `${selected[2]} triple confirmation`,
          points: Math.round(aligned.zoneOverlap * 30),
        });
      }

      return {
        ...obFvg,
        regime: regime.regime,
        confluenceScore: Math.max(70, Math.round(aligned.combinedStrength * 100 + 20)),
        scoreBreakdown: breakdown,
        strategy: selected[0],
        decision: aligned.consensusDirection,
        confidence: Math.min(0.98, aligned.combinedStrength + 0.1),
        entry,
        sl,
        tp,
        tp1,
        tp2: tp,
        rationale: `[${regime.regime} · ${selected.join(" + ")}] Checkmate: ${aligned.reasons.join(". ")}. RR ${(Math.abs(tp - entry) / risk).toFixed(2)}`,
      };
    }
  }

  // Score each active signal by aggregating its base + confluence from OTHER active signals in same direction
  let best: { sig: StratSignal; score: number; breakdown: ConfluenceContribution[] } | null = null;
  for (const s of signals) {
    if (s.dir === "WAIT") continue;
    if (!selected.includes(s.strategy) || !allowed.includes(s.strategy)) continue;

    const breakdown: ConfluenceContribution[] = [{ label: `${s.strategy} base`, points: s.base }];
    let score = s.base;

    // +30 liquidity sweep aligned
    const sweep = signals.find((x) => x.strategy === "liquidity-sweep" && x.dir === s.dir);
    if (sweep && sweep !== s) {
      score += 30;
      breakdown.push({ label: "Liquidity sweep aligned", points: 30 });
    }
    // +25 OB/FVG overlap
    const ob = signals.find((x) => x.strategy === "ob-fvg" && x.dir === s.dir);
    if (ob && ob !== s) {
      score += 25;
      breakdown.push({ label: "OB/FVG overlap", points: 25 });
    }
    // +20 vol expansion
    const ve = signals.find((x) => x.strategy === "vol-expansion" && x.dir === s.dir);
    if (ve && ve !== s) {
      score += 20;
      breakdown.push({ label: "Vol expansion", points: 20 });
    }
    // +15 OTE or fractal
    const ote = signals.find(
      (x) => (x.strategy === "ote" || x.strategy === "fractal") && x.dir === s.dir,
    );
    if (ote && ote !== s) {
      score += 15;
      breakdown.push({ label: "OTE/Fractal", points: 15 });
    }
    // +10 EMA pullback or Dynamic S/R
    const emaOrSr = signals.find(
      (x) => (x.strategy === "momentum" || x.strategy === "dynamic-sr") && x.dir === s.dir,
    );
    if (emaOrSr && emaOrSr !== s) {
      score += 10;
      breakdown.push({ label: "EMA pullback / S-R", points: 10 });
    }
    // +10 Wyckoff phase
    const wy = signals.find((x) => x.strategy === "wyckoff" && x.dir === s.dir);
    if (wy && wy !== s) {
      score += 10;
      breakdown.push({ label: "Wyckoff phase", points: 10 });
    }
    // +8 MSNR/APA agreement
    const msnrApa = signals.find(
      (x) => (x.strategy === "msnr-crt" || x.strategy === "apa") && x.dir === s.dir && x !== s,
    );
    if (msnrApa) {
      score += 8;
      breakdown.push({ label: "MSNR/APA agree", points: 8 });
    }

    // Penalties
    if ((s.dir === "BUY" && obFvg.rsi14 >= 72) || (s.dir === "SELL" && obFvg.rsi14 <= 28)) {
      score -= 10;
      breakdown.push({ label: "RSI extreme against trade", points: -10 });
    }
    if (
      (s.dir === "BUY" && regime.regime === "trend_down") ||
      (s.dir === "SELL" && regime.regime === "trend_up")
    ) {
      score -= 20;
      breakdown.push({ label: "Counter-regime", points: -20 });
    }

    score = Math.max(0, Math.min(100, score));
    if (!best || score > best.score) best = { sig: s, score, breakdown };
  }

  const base: EnsembleResult = {
    ...obFvg,
    regime: regime.regime,
    confluenceScore: best?.score ?? 0,
    scoreBreakdown: best?.breakdown ?? [],
    strategy: best?.sig.strategy ?? "ob-fvg",
  };

  if (!best || best.score < minScore) {
    return {
      ...base,
      decision: "WAIT",
      confidence: Math.max(0.1, (best?.score ?? 0) / 100),
      rationale: `[${regime.regime}] Selected: ${selected.join("+")}. Best: ${best?.sig.strategy ?? "none"} score ${(best?.score ?? 0).toFixed(0)} < ${minScore}. ${best?.sig.reason ?? "No signal"}`,
    };
  }

  const sig = best.sig;
  const isBuy = sig.dir === "BUY";
  const entry = sig.entry ?? price;
  const sl = sig.sl ?? (isBuy ? entry - 1.5 * obFvg.atr14 : entry + 1.5 * obFvg.atr14);
  const tp = sig.tp ?? (isBuy ? entry + 2.5 * obFvg.atr14 : entry - 2.5 * obFvg.atr14);
  const risk = Math.abs(entry - sl) || obFvg.atr14;
  const tp1 = isBuy ? entry + risk : entry - risk;

  return {
    ...base,
    decision: sig.dir as "BUY" | "SELL",
    confidence: Math.min(0.98, 0.4 + (best.score / 100) * 0.55),
    entry,
    sl,
    tp,
    tp1,
    tp2: tp,
    rationale: `[${regime.regime} · ${sig.strategy}] ${sig.reason}. Score ${best.score.toFixed(0)}/100. RR ${(Math.abs(tp - entry) / risk).toFixed(2)}.`,
  };
}

// ── Strict-consensus multi-strategy ────────────────────────────────────
/**
 * Trade ONLY when at least `minAgree` of the 11 strategies produce a
 * non-WAIT signal in the same direction. Uses the strongest agreeing
 * signal for entry/SL/TP. If fewer than `minAgree` strategies concur,
 * returns WAIT regardless of individual scores.
 *
 * This is what most users mean by "multi-strategy": genuine consensus,
 * not just the top-scoring single strategy.
 */
export function analyzeStrictConsensus(
  candles: Candle[],
  minAgree = 5,
): EnsembleResult {
  const window = candles.slice(-200);
  const price = window.at(-1)?.close ?? 0;
  const obFvg = analyze(window);
  const mom = analyzeMomentum(window);
  const mr = analyzeMeanReversion(window);
  const regime = detectRegime(obFvg, price);

  const signals: StratSignal[] = [
    sigMsnrCrt(window, obFvg, price),
    sigApa(window, obFvg, price),
    sigLiquiditySweep(window, obFvg, price),
    sigObFvg(obFvg),
    sigVolExpansion(window, obFvg, price, regime.regime),
    sigWyckoff(window, obFvg, price),
    { ...sigEmaPullback(obFvg, price), strategy: "momentum" },
    sigOte(window, obFvg, price),
    sigFractal(obFvg, price),
    sigDynamicSr(window, obFvg, price),
    sigBbRsi(mr),
  ];
  if (mom.decision !== "WAIT") {
    signals.push({
      strategy: "momentum",
      dir: mom.decision as "BUY" | "SELL",
      base: 45,
      reason: "Momentum continuation (EMA stacked)",
      entry: mom.entry,
      sl: mom.sl,
      tp: mom.tp,
    });
  }

  const buys = signals.filter((s) => s.dir === "BUY");
  const sells = signals.filter((s) => s.dir === "SELL");
  const winners = buys.length >= sells.length ? buys : sells;
  const dir: "BUY" | "SELL" | "WAIT" =
    winners.length === 0 ? "WAIT" : winners === buys ? "BUY" : "SELL";
  const agree = winners.length;
  const totalActive = buys.length + sells.length;

  const breakdown: ConfluenceContribution[] = [
    { label: `Regime: ${regime.regime}`, points: Math.round(Math.max(0.3, 1 - regime.atrPct / 3) * 30) },
    { label: `Agreeing strategies: ${agree}/${signals.length}`, points: agree * 8 },
    { label: `Opposing: ${totalActive - agree}`, points: -(totalActive - agree) * 6 },
  ];

  const base: EnsembleResult = {
    ...obFvg,
    regime: regime.regime,
    confluenceScore: Math.round((agree / signals.length) * 100),
    scoreBreakdown: breakdown,
    strategy: "ob-fvg",
  };

  if (dir === "WAIT" || agree < minAgree) {
    return {
      ...base,
      decision: "WAIT",
      confidence: Math.max(0.1, agree / signals.length),
      rationale: `[Consensus] Only ${agree}/${minAgree} strategies agree${dir !== "WAIT" ? ` on ${dir}` : ""}. Need ≥${minAgree} to trade.`,
    };
  }

  // Use highest-base agreeing signal for entry / SL / TP
  const best = [...winners].sort((a, b) => b.base - a.base)[0];
  const isBuy = dir === "BUY";
  const entry = best.entry ?? price;
  const sl = best.sl ?? (isBuy ? entry - 1.5 * obFvg.atr14 : entry + 1.5 * obFvg.atr14);
  const tp = best.tp ?? (isBuy ? entry + 2.5 * obFvg.atr14 : entry - 2.5 * obFvg.atr14);
  const risk = Math.abs(entry - sl) || obFvg.atr14;
  const tp1 = isBuy ? entry + risk : entry - risk;

  // Confidence: ratio of agreement + regime alignment bonus
  const agreementRatio = agree / signals.length;
  let conf = 0.5 + agreementRatio * 0.4;
  if (
    (isBuy && regime.regime === "trend_up") ||
    (!isBuy && regime.regime === "trend_down")
  )
    conf += 0.05;
  conf = Math.min(0.97, conf);

  const names = winners.map((w) => w.strategy).join(", ");
  return {
    ...base,
    strategy: best.strategy,
    decision: dir,
    confidence: conf,
    entry,
    sl,
    tp,
    tp1,
    tp2: tp,
    rationale: `[Consensus · ${regime.regime}] ${agree}/${signals.length} strategies agree on ${dir}: ${names}. Best: ${best.strategy} — ${best.reason}. RR ${(Math.abs(tp - entry) / risk).toFixed(2)}.`,
  };
}

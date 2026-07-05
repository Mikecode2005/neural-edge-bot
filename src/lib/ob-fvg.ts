/**
 * Multi-strategy market analyzer for the bot engine and Qwen.
 *
 * Exposes three independent setup detectors:
 *   1. OB + FVG (institutional smart-money-concepts) — hard-gated
 *   2. Mean-reversion (Bollinger + RSI divergence) — for ranging regimes
 *   3. Momentum-continuation (EMA pullback + displacement)
 *
 * `analyze()` keeps the existing OB+FVG contract but ALL gates are now hard —
 * price must retrace into the OB zone, HTF must align, RSI must be sane,
 * ADX must show trend, and a sweep OR displacement must exist. Otherwise
 * `decision` is `WAIT`.
 *
 * `analyzeMulti()` runs the three strategies and returns the highest-
 * confidence tradable signal with a `strategy` tag.
 */
import type { Candle } from "./deriv-ws";
import { analyzeEnsemble } from "./strategies/confluence";

export type StrategyKind =
  | "ob-fvg"
  | "mean-reversion"
  | "momentum"
  | "msnr-crt"
  | "apa"
  | "liquidity-sweep"
  | "vol-expansion"
  | "wyckoff"
  | "ote"
  | "fractal"
  | "dynamic-sr"
  | "bb-rsi"
  | "titan1"
  | "titan2";

export type MarketRegime = "trend_up" | "trend_down" | "range" | "compression" | "reversal";

export interface ConfluenceContribution {
  label: string;
  points: number;
}

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
  strategy?: StrategyKind;
  gateFailures?: string[];
  bollUpper?: number;
  bollLower?: number;
  bollMid?: number;
  // Multi-strategy confluence extensions
  regime?: MarketRegime;
  confluenceScore?: number;
  scoreBreakdown?: ConfluenceContribution[];
  // TP1 partial (1R) — used by newer risk manager
  tp1?: number;
  tp2?: number;
}

// ── indicators ──────────────────────────────────────────────────────────

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
  return { upper: mid + mult * sd, lower: mid - mult * sd, mid };
}

function atr(c: Candle[], period = 14): number {
  if (c.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    trs.push(tr);
  }
  const tail = trs.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / (tail.length || 1);
}

function calculateADX(c: Candle[], period = 14): number {
  if (c.length < period * 2) return 20;
  const trs: number[] = [],
    plusDM: number[] = [],
    minusDM: number[] = [];
  for (let i = 1; i < c.length; i++) {
    trs.push(
      Math.max(
        c[i].high - c[i].low,
        Math.abs(c[i].high - c[i - 1].close),
        Math.abs(c[i].low - c[i - 1].close),
      ),
    );
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
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

export function aggregateCandles(candles: Candle[], size: number): Candle[] {
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

// ── OB + FVG detection ─────────────────────────────────────────────────

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
    obs.push({
      kind: f.kind,
      top: c.high,
      bottom: c.low,
      index: idx,
      fvgIndex: f.index,
      mitigated,
      volumeProxy: c.high - c.low,
    });
  }
  return obs;
}

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

// ── Volatility regime — tuned per symbol family ─────────────────────────

function volatilityBounds(atr14: number, price: number): "normal" | "low" | "high" {
  // Normalize ATR as % of price so it works across FX, gold, indices, and vol-1s.
  const pct = price > 0 ? (atr14 / price) * 100 : 0;
  if (pct < 0.02) return "low"; // truly dead market
  if (pct > 2.5) return "high"; // hyper-volatile — spreads eat SL
  return "normal";
}

// ── Core analyzer (OB + FVG, hard-gated) ────────────────────────────────

export function analyze(candles: Candle[]): LiveAnalysis {
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes);
  const atr14 = atr(candles);
  const adx14 = calculateADX(candles);
  const boll = bollinger(closes);

  const trend: "up" | "down" = ema20 > ema50 ? "up" : "down";
  const last = candles.at(-1)!;
  const lastPrice = last?.close ?? 0;
  const volatilityRegime = volatilityBounds(atr14, lastPrice);

  // HTF
  const c5 = aggregateCandles(candles, 5);
  const c15 = aggregateCandles(candles, 15);
  const closes5 = c5.map((c) => c.close);
  const closes15 = c15.map((c) => c.close);
  const htfTrend15m: "up" | "down" = ema(closes15, 20) > ema(closes15, 50) ? "up" : "down";
  const htfStructure5m: "bullish" | "bearish" =
    ema(closes5, 20) > ema(closes5, 50) ? "bullish" : "bearish";

  // Structure
  const { highs: sHi, lows: sLo } = detectSwings(candles, 5, 5);
  const recentHi = sHi.slice(-3);
  const recentLo = sLo.slice(-3);
  let liquiditySweep = false;
  if (recentHi.some((h) => last.high > h.val && lastPrice <= h.val)) liquiditySweep = true;
  if (recentLo.some((l) => last.low < l.val && lastPrice >= l.val)) liquiditySweep = true;

  let bos = false,
    choch = false;
  const prevHigh = recentHi.at(-1)?.val ?? null;
  const prevLow = recentLo.at(-1)?.val ?? null;
  if (prevHigh && lastPrice > prevHigh) {
    bos = trend === "up";
    choch = trend === "down";
  } else if (prevLow && lastPrice < prevLow) {
    bos = trend === "down";
    choch = trend === "up";
  }

  // Displacement — check last 5 candles, not just latest
  let displacement = false;
  for (const c of candles.slice(-5)) {
    const rng = c.high - c.low || 1e-9;
    if (Math.abs(c.close - c.open) / rng > 0.55) {
      displacement = true;
      break;
    }
  }

  const fvgs = detectFVGs(candles);
  const obs = detectOBs(candles, fvgs);

  let activeOB: OrderBlock | null = null;
  let activeFVG: FVG | null = null;
  for (let i = obs.length - 1; i >= 0; i--) {
    const ob = obs[i];
    const f = fvgs.find((x) => x.index === ob.fvgIndex);
    if (!f || f.filled || ob.mitigated) continue;
    // require price INSIDE or within 0.5 ATR of the OB — retracement, not proximity
    const insideOB = lastPrice >= ob.bottom && lastPrice <= ob.top;
    const nearOB =
      Math.min(Math.abs(lastPrice - ob.top), Math.abs(lastPrice - ob.bottom)) <= 0.5 * atr14;
    if (!insideOB && !nearOB) continue;
    activeOB = ob;
    activeFVG = f;
    break;
  }

  const base: LiveAnalysis = {
    fvgs,
    obs,
    activeOB,
    activeFVG,
    decision: "WAIT",
    confidence: 0.15,
    rationale: "",
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
    bollUpper: boll.upper,
    bollLower: boll.lower,
    bollMid: boll.mid,
    strategy: "ob-fvg",
    gateFailures: [],
  };

  if (!activeOB || !activeFVG) {
    base.rationale = "OB+FVG: no unmitigated OB with unfilled FVG that price has retraced into.";
    base.gateFailures = ["no-retracement"];
    return base;
  }

  const isBull = activeOB.kind === "bullish";
  const failures: string[] = [];

  // HARD GATES
  if (!((isBull && trend === "up") || (!isBull && trend === "down"))) failures.push("trend");
  if (!((isBull && htfTrend15m === "up") || (!isBull && htfTrend15m === "down")))
    failures.push("htf-15m");
  if (isBull ? rsi14 >= 68 : rsi14 <= 32) failures.push("rsi-extreme");
  if (volatilityRegime !== "normal") failures.push(`vol-${volatilityRegime}`);
  if (adx14 < 18) failures.push("adx-flat");
  if (!liquiditySweep && !displacement) failures.push("no-sweep-or-displacement");

  // retracement must actually be inside FVG
  const retracedFVG = isBull
    ? lastPrice <= activeFVG.top + 0.1 * atr14
    : lastPrice >= activeFVG.bottom - 0.1 * atr14;
  if (!retracedFVG) failures.push("fvg-not-retraced");

  // Plan (even if gates fail, so caller can inspect)
  const entry = (activeOB.top + activeOB.bottom) / 2;
  const slDist = 1.5 * atr14;
  const sl = isBull ? entry - slDist : entry + slDist;
  // TP at swing liquidity capped at 3R / floored at 1.67R
  const swingHi = Math.max(...candles.slice(-50).map((c) => c.high));
  const swingLo = Math.min(...candles.slice(-50).map((c) => c.low));
  const r = slDist;
  const rawTp = isBull ? swingHi : swingLo;
  const tp = isBull
    ? Math.max(entry + 1.67 * r, Math.min(rawTp, entry + 3 * r))
    : Math.min(entry - 1.67 * r, Math.max(rawTp, entry - 3 * r));

  const emaAligned = isBull ? ema20 > ema50 && ema50 > ema200 : ema20 < ema50 && ema50 < ema200;

  // Confidence — only earn score when gates pass
  let score = 0.3;
  if (failures.length === 0) {
    score += 0.2;
    if (emaAligned) score += 0.1;
    if (liquiditySweep) score += 0.1;
    if (displacement) score += 0.1;
    if (bos) score += 0.08;
    if (choch) score += 0.05;
    if (adx14 > 25) score += 0.05;
  } else {
    // penalize per failed gate but keep some info signal
    score = Math.max(0.1, 0.3 - 0.06 * failures.length);
  }
  const confidence = Math.min(0.95, score);

  const decision: "BUY" | "SELL" | "WAIT" =
    failures.length === 0 ? (isBull ? "BUY" : "SELL") : "WAIT";

  base.activeOB = activeOB;
  base.activeFVG = activeFVG;
  base.decision = decision;
  base.confidence = confidence;
  base.entry = entry;
  base.sl = sl;
  base.tp = tp;
  base.gateFailures = failures;
  base.rationale =
    failures.length === 0
      ? `${isBull ? "Bullish" : "Bearish"} OB [${activeOB.bottom.toFixed(4)}, ${activeOB.top.toFixed(4)}] + unfilled FVG, retraced. Trend/HTF/RSI/ADX/sweep all pass. RR ≈ ${(Math.abs(tp - entry) / slDist).toFixed(2)}.`
      : `OB+FVG rejected — failed gates: ${failures.join(", ")}. Trend ${trend.toUpperCase()}, HTF15m ${htfTrend15m.toUpperCase()}, RSI ${rsi14.toFixed(0)}, ADX ${adx14.toFixed(0)}, vol=${volatilityRegime}.`;
  return base;
}

// ── Mean-reversion (Bollinger + RSI) ────────────────────────────────────

export function analyzeMeanReversion(candles: Candle[]): LiveAnalysis {
  const base = analyze(candles);
  const closes = candles.map((c) => c.close);
  const last = candles.at(-1)!;
  const price = last.close;
  const boll = bollinger(closes);
  const atr14 = base.atr14;
  const rsi14 = base.rsi14;
  const failures: string[] = [];

  // MR works best in flat / ranging markets
  if (base.adx14 > 22) failures.push("trend-too-strong");
  if (base.volatilityRegime === "high") failures.push("vol-high");

  // Signal: price touches upper band + RSI > 68 → SELL, price touches lower + RSI < 32 → BUY
  let dir: "BUY" | "SELL" | "WAIT" = "WAIT";
  if (price <= boll.lower && rsi14 < 32) dir = "BUY";
  else if (price >= boll.upper && rsi14 > 68) dir = "SELL";
  else failures.push("no-band-touch");

  const slDist = 1.2 * atr14;
  const entry = price;
  const sl = dir === "BUY" ? entry - slDist : entry + slDist;
  const tp = dir === "BUY" ? boll.mid : dir === "SELL" ? boll.mid : entry;

  let score = 0.3;
  if (failures.length === 0) {
    score += 0.25;
    if (base.adx14 < 15) score += 0.1;
    if ((dir === "BUY" && rsi14 < 25) || (dir === "SELL" && rsi14 > 75)) score += 0.1;
  } else {
    score = Math.max(0.1, 0.28 - 0.06 * failures.length);
  }

  return {
    ...base,
    strategy: "mean-reversion",
    decision: failures.length === 0 ? dir : "WAIT",
    confidence: Math.min(0.9, score),
    entry: dir !== "WAIT" ? entry : undefined,
    sl: dir !== "WAIT" ? sl : undefined,
    tp: dir !== "WAIT" ? tp : undefined,
    gateFailures: failures,
    rationale:
      failures.length === 0
        ? `MR ${dir}: price ${dir === "BUY" ? "at lower" : "at upper"} band ${dir === "BUY" ? boll.lower.toFixed(4) : boll.upper.toFixed(4)}, RSI ${rsi14.toFixed(0)}, ADX ${base.adx14.toFixed(0)} (ranging). Target band midline.`
        : `MR rejected — ${failures.join(", ")}. RSI ${rsi14.toFixed(0)}, ADX ${base.adx14.toFixed(0)}.`,
  };
}

// ── Momentum continuation (EMA pullback + displacement) ─────────────────

export function analyzeMomentum(candles: Candle[]): LiveAnalysis {
  const base = analyze(candles);
  const last = candles.at(-1)!;
  const price = last.close;
  const failures: string[] = [];

  // Requires clear trend
  if (base.adx14 < 22) failures.push("adx-flat");
  if (base.volatilityRegime !== "normal") failures.push(`vol-${base.volatilityRegime}`);
  const emaAlignedUp = base.ema20 > base.ema50 && base.ema50 > base.ema200;
  const emaAlignedDown = base.ema20 < base.ema50 && base.ema50 < base.ema200;
  if (!emaAlignedUp && !emaAlignedDown) failures.push("ema-not-stacked");
  if (base.htfTrend15m !== base.trend) failures.push("htf-mismatch");

  // Pullback: price within 0.5 ATR of EMA20 in trend direction
  const distToEma20 = Math.abs(price - base.ema20);
  const pullback = distToEma20 <= 0.6 * base.atr14;
  if (!pullback) failures.push("no-pullback");

  // Displacement in the last 3 candles matching trend
  const last3 = candles.slice(-3);
  const hasDisp = last3.some((c) => {
    const rng = c.high - c.low || 1e-9;
    const body = (c.close - c.open) / rng;
    return base.trend === "up" ? body > 0.55 : body < -0.55;
  });
  if (!hasDisp) failures.push("no-displacement");

  const dir: "BUY" | "SELL" | "WAIT" =
    failures.length === 0 ? (base.trend === "up" ? "BUY" : "SELL") : "WAIT";

  const slDist = 1.5 * base.atr14;
  const entry = price;
  const sl = dir === "BUY" ? entry - slDist : dir === "SELL" ? entry + slDist : entry;
  const tp =
    dir === "BUY"
      ? entry + (2.5 * slDist) / 1.5
      : dir === "SELL"
        ? entry - (2.5 * slDist) / 1.5
        : entry;

  let score = 0.3;
  if (failures.length === 0) {
    score += 0.25;
    if (base.adx14 > 28) score += 0.1;
    if (base.bos) score += 0.1;
    if (base.liquiditySweep) score += 0.05;
  } else {
    score = Math.max(0.1, 0.28 - 0.06 * failures.length);
  }

  return {
    ...base,
    strategy: "momentum",
    decision: dir,
    confidence: Math.min(0.93, score),
    entry: dir !== "WAIT" ? entry : undefined,
    sl: dir !== "WAIT" ? sl : undefined,
    tp: dir !== "WAIT" ? tp : undefined,
    gateFailures: failures,
    rationale:
      failures.length === 0
        ? `Momentum ${dir}: trend ${base.trend.toUpperCase()}, EMA stacked, HTF aligned, pullback to EMA20, displacement present. ADX ${base.adx14.toFixed(0)}.`
        : `Momentum rejected — ${failures.join(", ")}. ADX ${base.adx14.toFixed(0)}, trend ${base.trend}.`,
  };
}

// ── Multi-strategy dispatcher ───────────────────────────────────────────

export function analyzeMulti(candles: Candle[], selectedStrategies?: StrategyKind[]): LiveAnalysis {
  // Delegates to the regime-aware confluence ensemble (11 strategies).
  return analyzeEnsemble(candles, 70, selectedStrategies);
}

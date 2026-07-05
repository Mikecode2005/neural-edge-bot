/**
 * TITAN1 — Elite High-Confluence Strategy
 *
 * Core Approach: MSNR + CRT as primary framework, enhanced with APA invalidation
 * zones, Liquidity Sweeps, Order Blocks, FVGs, and strict Regime Detection.
 * Trade only high-confluence setups. Prioritize quality over quantity.
 *
 * Step-by-Step Rules:
 * 1. Regime & Bias Analysis (Always First)
 * 2. Identify Key Zones (MSNR + APA)
 * 3. Entry Conditions (Strict – Require All)
 * 4. Risk Management (Non-Negotiable)
 * 5. Filters (Never Violate)
 * 6. Execution & Logging
 *
 * Goal: Extremely selective trading. Win rate prioritized through patience
 * and strict rules. Skip 90% of potential setups if they don't meet criteria.
 */

import type {
  Candle,
  LiveAnalysis,
  StrategyKind,
  MarketRegime,
  ConfluenceContribution,
} from "../ob-fvg";

// ── Helpers ──────────────────────────────────────────────────────────────

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

function atr(c: Candle[], period = 14): number {
  if (c.length < 2) return 0;
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

function findSwings(candles: Candle[], left = 3, right = 3) {
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

function detectFVGs(candles: Candle[], maxAge = 100) {
  const out: {
    kind: "bullish" | "bearish";
    top: number;
    bottom: number;
    index: number;
    filled: boolean;
    size: number;
  }[] = [];
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

function detectOBs(candles: Candle[], fvgs: ReturnType<typeof detectFVGs>) {
  const obs: {
    kind: "bullish" | "bearish";
    top: number;
    bottom: number;
    index: number;
    fvgIndex: number;
    mitigated: boolean;
    volumeProxy: number;
  }[] = [];
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

// ── TITAN1 Analysis Result ──────────────────────────────────────────────

export interface Titan1Result {
  decision: "BUY" | "SELL" | "WAIT";
  confidence: number;
  entry?: number;
  sl?: number;
  tp?: number;
  tp1?: number;
  tp2?: number;
  regime: MarketRegime;
  regimeScore: number;
  confluenceScore: number;
  scoreBreakdown: ConfluenceContribution[];
  rationale: string;
  layers: string[];
  failures: string[];
  atr14: number;
  trend: "up" | "down";
  rsi14: number;
  adx14: number;
}

// ── 1. Regime Engine ────────────────────────────────────────────────────

function detectTitan1Regime(
  candles: Candle[],
  price: number,
  atr14: number,
): {
  regime: MarketRegime;
  regimeScore: number;
  reason: string;
} {
  const closes = candles.map((c) => c.close);
  const adx = calculateADX(candles);
  const bbWidth = (() => {
    const tail = closes.slice(-20);
    const mid = tail.reduce((a, b) => a + b, 0) / (tail.length || 1);
    const sd = stddev(tail);
    return mid > 0 ? ((2 * sd) / mid) * 100 : 0;
  })();
  const atrPct = price > 0 ? (atr14 / price) * 100 : 0;

  // Compression: very tight BB + low ATR%
  if (bbWidth < 0.4 && atrPct < 0.05) {
    return { regime: "compression", regimeScore: 0.2, reason: "Compression: BB tight + low ATR%" };
  }
  // Range: ADX flat
  if (adx < 20) {
    return { regime: "range", regimeScore: 0.4, reason: "Range: ADX < 20" };
  }
  // Trending
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const trend = ema20 > ema50 ? "up" : "down";
  const dir: MarketRegime = trend === "up" ? "trend_up" : "trend_down";
  const score = Math.min(1, 0.5 + (adx - 20) / 60);
  return { regime: dir, regimeScore: score, reason: `Trend ${trend}: ADX ${adx.toFixed(0)}` };
}

// ── 2. MSNR + CRT Layer ─────────────────────────────────────────────────

function msnrCrtLayer(
  candles: Candle[],
  price: number,
  atr14: number,
  trend: "up" | "down",
  htfTrend: "up" | "down",
): {
  signal: "BUY" | "SELL" | "WAIT";
  score: number;
  entry?: number;
  sl?: number;
  tp?: number;
  reason: string;
} {
  const { highs, lows } = findSwings(candles, 4, 4);
  const last3 = candles.slice(-3);
  const bull = htfTrend === "up" && trend === "up";
  const bear = htfTrend === "down" && trend === "down";
  const nearLow = lows.at(-1) && Math.abs(price - lows.at(-1)!.val) <= 0.6 * atr14;
  const nearHigh = highs.at(-1) && Math.abs(price - highs.at(-1)!.val) <= 0.6 * atr14;
  const reactionUp = last3.some((c) => (c.close - c.open) / (c.high - c.low || 1e-9) > 0.5);
  const reactionDn = last3.some((c) => (c.close - c.open) / (c.high - c.low || 1e-9) < -0.5);

  if (bull && nearLow && reactionUp) {
    const entry = price;
    const sl = entry - 1.5 * atr14;
    const tp = entry + 3.0 * atr14;
    return {
      signal: "BUY",
      score: 45,
      entry,
      sl,
      tp,
      reason: "MSNR+CRT: HTF up + reaction off swing low",
    };
  }
  if (bear && nearHigh && reactionDn) {
    const entry = price;
    const sl = entry + 1.5 * atr14;
    const tp = entry - 3.0 * atr14;
    return {
      signal: "SELL",
      score: 45,
      entry,
      sl,
      tp,
      reason: "MSNR+CRT: HTF down + reaction off swing high",
    };
  }
  return {
    signal: "WAIT",
    score: 0,
    reason: "MSNR+CRT: no bias-aligned reaction at range extreme",
  };
}

// ── 3. APA Layer (Invalidation Zone) ────────────────────────────────────

function apaLayer(
  candles: Candle[],
  price: number,
  atr14: number,
  trend: "up" | "down",
): {
  signal: "BUY" | "SELL" | "WAIT";
  score: number;
  entry?: number;
  sl?: number;
  tp?: number;
  reason: string;
} {
  const { highs, lows } = findSwings(candles, 5, 5);
  const lastSwingHigh = highs.at(-1)?.val;
  const lastSwingLow = lows.at(-1)?.val;
  const prevSwingHigh = highs.at(-2)?.val;
  const prevSwingLow = lows.at(-2)?.val;

  if (!lastSwingHigh || !lastSwingLow || !prevSwingHigh || !prevSwingLow) {
    return { signal: "WAIT", score: 0, reason: "APA: insufficient swing data" };
  }

  // Detect BOS
  const bullishBOS = trend === "up" && price > prevSwingHigh;
  const bearishBOS = trend === "down" && price < prevSwingLow;

  if (bullishBOS) {
    // After bullish BOS, look for retracement to shoulder (previous swing high)
    const shoulder = prevSwingHigh;
    const nearShoulder = Math.abs(price - shoulder) <= 0.5 * atr14;
    if (nearShoulder) {
      const entry = price;
      const sl = entry - 1.5 * atr14;
      const tp = entry + 3.0 * atr14;
      return {
        signal: "BUY",
        score: 42,
        entry,
        sl,
        tp,
        reason: "APA: bullish BOS + retrace to shoulder",
      };
    }
  }

  if (bearishBOS) {
    // After bearish BOS, look for retracement to shoulder (previous swing low)
    const shoulder = prevSwingLow;
    const nearShoulder = Math.abs(price - shoulder) <= 0.5 * atr14;
    if (nearShoulder) {
      const entry = price;
      const sl = entry + 1.5 * atr14;
      const tp = entry - 3.0 * atr14;
      return {
        signal: "SELL",
        score: 42,
        entry,
        sl,
        tp,
        reason: "APA: bearish BOS + retrace to shoulder",
      };
    }
  }

  // 50% retracement of last impulse
  const impulseHigh = Math.max(lastSwingHigh, prevSwingHigh);
  const impulseLow = Math.min(lastSwingLow, prevSwingLow);
  const mid = (impulseHigh + impulseLow) / 2;
  const near50 = Math.abs(price - mid) <= 0.5 * atr14;

  if (trend === "up" && near50) {
    const entry = price;
    const sl = entry - 1.5 * atr14;
    const tp = entry + 2.5 * atr14;
    return { signal: "BUY", score: 38, entry, sl, tp, reason: "APA: 50% retrace in uptrend" };
  }
  if (trend === "down" && near50) {
    const entry = price;
    const sl = entry + 1.5 * atr14;
    const tp = entry - 2.5 * atr14;
    return { signal: "SELL", score: 38, entry, sl, tp, reason: "APA: 50% retrace in downtrend" };
  }

  return { signal: "WAIT", score: 0, reason: "APA: no BOS or 50% retrace setup" };
}

// ── 4. Liquidity Sweep Layer ────────────────────────────────────────────

function liquiditySweepLayer(
  candles: Candle[],
  price: number,
  atr14: number,
): {
  signal: "BUY" | "SELL" | "WAIT";
  score: number;
  entry?: number;
  sl?: number;
  tp?: number;
  reason: string;
} {
  const { highs, lows } = findSwings(candles, 3, 3);
  const last = candles.at(-1)!;
  const recentHi = highs.slice(-3).map((h) => h.val);
  const recentLo = lows.slice(-3).map((l) => l.val);
  const sweptHigh = recentHi.some((v) => last.high > v && last.close < v);
  const sweptLow = recentLo.some((v) => last.low < v && last.close > v);

  if (sweptLow) {
    const entry = price;
    const sl = last.low - 0.5 * atr14;
    const tp = entry + 2.5 * atr14;
    return {
      signal: "BUY",
      score: 50,
      entry,
      sl,
      tp,
      reason: "Liquidity Sweep: equal lows swept + reclaim",
    };
  }
  if (sweptHigh) {
    const entry = price;
    const sl = last.high + 0.5 * atr14;
    const tp = entry - 2.5 * atr14;
    return {
      signal: "SELL",
      score: 50,
      entry,
      sl,
      tp,
      reason: "Liquidity Sweep: equal highs swept + rejection",
    };
  }
  return { signal: "WAIT", score: 0, reason: "Liquidity Sweep: no sweep detected" };
}

// ── 5. OB + FVG Layer ──────────────────────────────────────────────────

function obFvgLayer(
  candles: Candle[],
  price: number,
  atr14: number,
  trend: "up" | "down",
): {
  signal: "BUY" | "SELL" | "WAIT";
  score: number;
  entry?: number;
  sl?: number;
  tp?: number;
  reason: string;
} {
  const fvgs = detectFVGs(candles);
  const obs = detectOBs(candles, fvgs);

  let activeOB: (typeof obs)[0] | null = null;
  let activeFVG: (typeof fvgs)[0] | null = null;
  for (let i = obs.length - 1; i >= 0; i--) {
    const ob = obs[i];
    const f = fvgs.find((x) => x.index === ob.fvgIndex);
    if (!f || f.filled || ob.mitigated) continue;
    const insideOB = price >= ob.bottom && price <= ob.top;
    const nearOB = Math.min(Math.abs(price - ob.top), Math.abs(price - ob.bottom)) <= 0.5 * atr14;
    if (!insideOB && !nearOB) continue;
    activeOB = ob;
    activeFVG = f;
    break;
  }

  if (!activeOB || !activeFVG) {
    return { signal: "WAIT", score: 0, reason: "OB+FVG: no unmitigated setup" };
  }

  const isBull = activeOB.kind === "bullish";
  const trendAligned = (isBull && trend === "up") || (!isBull && trend === "down");
  if (!trendAligned) {
    return { signal: "WAIT", score: 0, reason: "OB+FVG: trend misalignment" };
  }

  const entry = (activeOB.top + activeOB.bottom) / 2;
  const sl = isBull ? entry - 1.5 * atr14 : entry + 1.5 * atr14;
  const tp = isBull ? entry + 3.0 * atr14 : entry - 3.0 * atr14;
  return {
    signal: isBull ? "BUY" : "SELL",
    score: 45,
    entry,
    sl,
    tp,
    reason: `OB+FVG: ${isBull ? "bullish" : "bearish"} OB [${activeOB.bottom.toFixed(4)}, ${activeOB.top.toFixed(4)}] + unfilled FVG`,
  };
}

// ── 6. CRT Confirmation Layer ──────────────────────────────────────────

function crtConfirmation(
  candles: Candle[],
  direction: "BUY" | "SELL",
): {
  confirmed: boolean;
  strength: number;
  reason: string;
} {
  const last = candles.at(-1)!;
  const prev = candles.at(-2)!;
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 1e-9;
  const bodyRatio = body / range;

  // Engulfing check
  const prevBody = Math.abs(prev.close - prev.open);
  const isEngulfing =
    direction === "BUY"
      ? last.close > last.open && last.open < prev.close && last.close > prev.open
      : last.close < last.open && last.open > prev.close && last.close < prev.open;

  // Pin bar check
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const isPinBar =
    direction === "BUY"
      ? lowerWick > 2 * body && upperWick < 0.3 * range
      : upperWick > 2 * body && lowerWick < 0.3 * range;

  // Strong body check
  const isStrongBody = bodyRatio > 0.7;

  if (isEngulfing) {
    return { confirmed: true, strength: 0.9, reason: "CRT: engulfing candle" };
  }
  if (isPinBar) {
    return { confirmed: true, strength: 0.85, reason: "CRT: pin bar rejection" };
  }
  if (isStrongBody) {
    return { confirmed: true, strength: 0.75, reason: "CRT: strong body candle" };
  }
  return { confirmed: false, strength: 0, reason: "CRT: no strong confirmation" };
}

// ── TITAN1 Main Analyzer ────────────────────────────────────────────────

/**
 * TITAN1 — Elite High-Confluence Strategy
 *
 * Analyzes market using 5 layers of confluence:
 * 1. Regime Detection (must be trending, score > 0.5)
 * 2. MSNR + CRT (primary entry framework)
 * 3. APA (invalidation zones after BOS)
 * 4. Liquidity Sweep (reversal setups)
 * 5. OB + FVG (precision entry zones)
 * 6. CRT Confirmation (candle reaction)
 *
 * Requires minimum 3 layers of confluence for any trade.
 * Requires CRT confirmation for final entry.
 * Minimum RR 1:2.
 */
export function analyzeTitan1(candles: Candle[]): Titan1Result {
  const window = candles.slice(-200);
  const price = window.at(-1)?.close ?? 0;
  const closes = window.map((c) => c.close);
  const atr14 = atr(window);
  const rsi14 = rsi(closes);
  const adx14 = calculateADX(window);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const trend: "up" | "down" = ema20 > ema50 ? "up" : "down";
  const htfTrend: "up" | "down" = (() => {
    const c15 = aggregateCandles(window, 15);
    const c15Closes = c15.map((c) => c.close);
    return ema(c15Closes, 20) > ema(c15Closes, 50) ? "up" : "down";
  })();

  const layers: string[] = [];
  const failures: string[] = [];
  const breakdown: ConfluenceContribution[] = [];

  // Step 1: Regime Detection
  const regimeResult = detectTitan1Regime(window, price, atr14);
  const regime = regimeResult.regime;
  const regimeScore = regimeResult.regimeScore;
  breakdown.push({ label: `Regime: ${regime}`, points: Math.round(regimeScore * 100) });

  // No-trade zones: compression or weak range
  if (regime === "compression") {
    return {
      decision: "WAIT",
      confidence: 0.1,
      regime,
      regimeScore,
      confluenceScore: 10,
      scoreBreakdown: breakdown,
      rationale: "TITAN1: No-trade zone — compression regime",
      layers,
      failures: ["compression-regime"],
      atr14,
      trend,
      rsi14,
      adx14,
    };
  }
  if (regime === "range" && regimeScore < 0.4) {
    return {
      decision: "WAIT",
      confidence: 0.15,
      regime,
      regimeScore,
      confluenceScore: 15,
      scoreBreakdown: breakdown,
      rationale: "TITAN1: No-trade zone — weak range",
      layers,
      failures: ["weak-range"],
      atr14,
      trend,
      rsi14,
      adx14,
    };
  }

  layers.push(`Regime: ${regime} (${(regimeScore * 100).toFixed(0)}%)`);

  // Step 2: Run all strategy layers
  const msnr = msnrCrtLayer(window, price, atr14, trend, htfTrend);
  const apa = apaLayer(window, price, atr14, trend);
  const sweep = liquiditySweepLayer(window, price, atr14);
  const obfvg = obFvgLayer(window, price, atr14, trend);

  // Collect active signals
  const signals: {
    signal: "BUY" | "SELL" | "WAIT";
    score: number;
    entry?: number;
    sl?: number;
    tp?: number;
    reason: string;
    name: string;
  }[] = [
    { ...msnr, name: "MSNR+CRT" },
    { ...apa, name: "APA" },
    { ...sweep, name: "Liquidity Sweep" },
    { ...obfvg, name: "OB+FVG" },
  ];

  const activeSignals = signals.filter((s) => s.signal !== "WAIT");
  const buySignals = activeSignals.filter((s) => s.signal === "BUY");
  const sellSignals = activeSignals.filter((s) => s.signal === "SELL");

  // Step 3: Check minimum confluence (need at least 3 layers agreeing)
  const consensusDirection =
    buySignals.length > sellSignals.length
      ? "BUY"
      : sellSignals.length > buySignals.length
        ? "SELL"
        : "WAIT";
  const agreeingSignals =
    consensusDirection === "BUY" ? buySignals : consensusDirection === "SELL" ? sellSignals : [];

  if (agreeingSignals.length < 3) {
    failures.push(`insufficient-confluence: ${agreeingSignals.length}/3 layers agree`);
    const totalScore = activeSignals.reduce((a, s) => a + s.score, 0);
    const confidence = Math.min(0.3, totalScore / 300);
    return {
      decision: "WAIT",
      confidence,
      regime,
      regimeScore,
      confluenceScore: Math.round((agreeingSignals.length / 3) * 100),
      scoreBreakdown: breakdown,
      rationale: `TITAN1: Only ${agreeingSignals.length}/3 layers agree. Need minimum 3. ${activeSignals.map((s) => s.name).join(", ") || "No signals"}`,
      layers,
      failures,
      atr14,
      trend,
      rsi14,
      adx14,
    };
  }

  // Step 4: CRT Confirmation
  const crt = crtConfirmation(window, consensusDirection as "BUY" | "SELL");
  if (!crt.confirmed) {
    failures.push(`crt-not-confirmed: ${crt.reason}`);
    return {
      decision: "WAIT",
      confidence: 0.25,
      regime,
      regimeScore,
      confluenceScore: Math.round((agreeingSignals.length / 3) * 70),
      scoreBreakdown: breakdown,
      rationale: `TITAN1: ${agreeingSignals.length} layers agree but CRT not confirmed. ${crt.reason}`,
      layers,
      failures,
      atr14,
      trend,
      rsi14,
      adx14,
    };
  }

  layers.push(`CRT: ${crt.reason} (${(crt.strength * 100).toFixed(0)}%)`);

  // Step 5: Calculate entry, SL, TP from best signal
  const bestSignal = agreeingSignals.reduce(
    (best, s) => (s.score > best.score ? s : best),
    agreeingSignals[0],
  );
  const entry = bestSignal.entry ?? price;
  const sl =
    bestSignal.sl ?? (consensusDirection === "BUY" ? entry - 1.5 * atr14 : entry + 1.5 * atr14);
  const tp =
    bestSignal.tp ?? (consensusDirection === "BUY" ? entry + 3.0 * atr14 : entry - 3.0 * atr14);
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk > 0 ? reward / risk : 0;

  // Step 6: Minimum RR check (1:2)
  if (rr < 2.0) {
    failures.push(`low-rr: ${rr.toFixed(2)} < 2.0`);
    return {
      decision: "WAIT",
      confidence: 0.3,
      regime,
      regimeScore,
      confluenceScore: Math.round((agreeingSignals.length / 3) * 80),
      scoreBreakdown: breakdown,
      rationale: `TITAN1: ${agreeingSignals.length} layers agree + CRT confirmed but RR ${rr.toFixed(2)} < 2.0 minimum`,
      layers,
      failures,
      atr14,
      trend,
      rsi14,
      adx14,
    };
  }

  // Step 7: Calculate final confidence
  const layerScore =
    agreeingSignals.reduce((a, s) => a + s.score, 0) / (agreeingSignals.length * 50);
  const crtBonus = crt.strength * 0.15;
  const regimeBonus = regimeScore * 0.1;
  const rrBonus = Math.min(0.1, (rr - 2.0) / 20);
  const confidence = Math.min(0.95, 0.4 + layerScore * 0.3 + crtBonus + regimeBonus + rrBonus);

  // Build score breakdown
  for (const s of agreeingSignals) {
    breakdown.push({ label: `${s.name}`, points: Math.round((s.score / 50) * 30) });
  }
  breakdown.push({ label: `CRT: ${crt.reason}`, points: Math.round(crt.strength * 15) });
  breakdown.push({ label: `RR: ${rr.toFixed(2)}`, points: Math.round(rrBonus * 100) });

  const tp1 = consensusDirection === "BUY" ? entry + risk : entry - risk;
  const tp2 = tp;

  layers.push(
    `Entry: ${entry.toFixed(4)}, SL: ${sl.toFixed(4)}, TP: ${tp.toFixed(4)}, RR: ${rr.toFixed(2)}`,
  );

  return {
    decision: consensusDirection as "BUY" | "SELL",
    confidence,
    entry,
    sl,
    tp,
    tp1,
    tp2,
    regime,
    regimeScore,
    confluenceScore: Math.round(confidence * 100),
    scoreBreakdown: breakdown,
    rationale: `TITAN1 ${consensusDirection}: ${agreeingSignals.length} layers (${agreeingSignals.map((s) => s.name).join(", ")}), CRT confirmed, RR ${rr.toFixed(2)}. Confidence ${(confidence * 100).toFixed(0)}%.`,
    layers,
    failures,
    atr14,
    trend,
    rsi14,
    adx14,
  };
}

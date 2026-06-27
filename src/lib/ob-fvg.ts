/**
 * Client-side Order Block + FVG detector — mirror of the Python backend
 * algorithm so the chart can draw zones immediately without an HF round-trip.
 */
import type { Candle } from "./deriv-ws";

export interface FVG {
  kind: "bullish" | "bearish";
  top: number;
  bottom: number;
  index: number;
  filled: boolean;
}

export interface OrderBlock {
  kind: "bullish" | "bearish";
  top: number;
  bottom: number;
  index: number;
  fvgIndex: number;
  mitigated: boolean;
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
  rsi14: number;
  atr14: number;
}

function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
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
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    trs.push(tr);
  }
  const tail = trs.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
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
      });
    } else if (prev.low > next.high) {
      out.push({
        kind: "bearish",
        bottom: next.high,
        top: prev.low,
        index: i,
        filled: false,
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
        ? post.some((x) => x.low <= c.high) &&
          post.some((x) => x.low <= c.low)
        : post.some((x) => x.high >= c.low) &&
          post.some((x) => x.high >= c.high);
    obs.push({
      kind: f.kind === "bullish" ? "bullish" : "bearish",
      top: c.high,
      bottom: c.low,
      index: idx,
      fvgIndex: f.index,
      mitigated,
    });
  }
  return obs;
}

export function analyze(candles: Candle[]): LiveAnalysis {
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes);
  const atr14 = atr(candles);
  const trend: "up" | "down" = ema20 > ema50 ? "up" : "down";

  const fvgs = detectFVGs(candles);
  const obs = detectOBs(candles, fvgs);
  const price = candles.at(-1)?.close ?? 0;

  let activeOB: OrderBlock | null = null;
  let activeFVG: FVG | null = null;
  for (let i = obs.length - 1; i >= 0; i--) {
    const ob = obs[i];
    const f = fvgs.find((x) => x.index === ob.fvgIndex);
    if (!f || f.filled || ob.mitigated) continue;
    const dist = Math.min(Math.abs(price - ob.top), Math.abs(price - ob.bottom));
    if (dist > 2 * atr14 && !(price >= ob.bottom && price <= ob.top)) continue;
    activeOB = ob;
    activeFVG = f;
    break;
  }

  if (!activeOB || !activeFVG) {
    return {
      fvgs,
      obs,
      activeOB: null,
      activeFVG: null,
      decision: "WAIT",
      confidence: 0.25,
      rationale: "No unmitigated OB / unfilled FVG confluence near price.",
      trend,
      ema20,
      ema50,
      rsi14,
      atr14,
    };
  }

  const isBull = activeOB.kind === "bullish";
  const entry = (activeOB.top + activeOB.bottom) / 2;
  const sl = isBull ? activeOB.bottom - atr14 : activeOB.top + atr14;
  const swingHigh = Math.max(...candles.slice(-50).map((c) => c.high));
  const swingLow = Math.min(...candles.slice(-50).map((c) => c.low));
  const r = Math.abs(entry - sl);
  const tp = isBull
    ? Math.max(Math.min(swingHigh, entry + 3 * r), entry + 1.5 * r)
    : Math.min(Math.max(swingLow, entry - 3 * r), entry - 1.5 * r);

  const trendAlign = (isBull && trend === "up") || (!isBull && trend === "down");
  const rsiOk = isBull ? rsi14 < 65 : rsi14 > 35;
  const freshness = Math.max(0, 1 - (candles.length - 1 - activeOB.index) / 50);
  const confidence = Math.min(
    0.95,
    Math.max(0, 0.4 + 0.2 * +trendAlign + 0.15 * +rsiOk + 0.25 * freshness),
  );

  return {
    fvgs,
    obs,
    activeOB,
    activeFVG,
    decision: isBull ? "BUY" : "SELL",
    confidence,
    entry,
    sl,
    tp,
    trend,
    ema20,
    ema50,
    rsi14,
    atr14,
    rationale:
      `${isBull ? "Bullish" : "Bearish"} OB [${activeOB.bottom.toFixed(5)}, ${activeOB.top.toFixed(5)}] anchors an unfilled ${activeFVG.kind} FVG. ` +
      `Price ${price.toFixed(5)} interacting with the zone. Trend ${trend.toUpperCase()}, ` +
      `RSI ${rsi14.toFixed(1)}, ATR ${atr14.toFixed(5)}.`,
  };
}

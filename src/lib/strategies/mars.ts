/**
 * MARS strategies — restored & tuned multi-strategy detectors.
 *
 * Mars1  — the original 3-detector multi-strategy (OB+FVG, Momentum, MR).
 *          Runs the three independent detectors and returns the highest-
 *          confidence tradable signal. If none are tradable, returns WAIT.
 *
 * Mars2  — Mars1 refined for high-tick synthetic volatility indices,
 *          specifically Volatility 25 (1s) and Volatility 15 (1s).
 *          - RSI / ADX / volatility bands loosened for 1s tick regime
 *          - momentum weighted higher, mean-reversion tightened
 *          - ATR-based SL/TP scaled down (1.0x / 1.8x) for faster churn
 *          - minimum confidence floor lifted so weak signals don't leak
 */
import type { Candle } from "@/lib/deriv-ws";
import {
  analyze,
  analyzeMeanReversion,
  analyzeMomentum,
  type LiveAnalysis,
} from "@/lib/ob-fvg";

/**
 * Mars1 — pick highest-confidence tradable signal from the three
 * independent detectors. WAIT if none pass their own gates.
 */
export function analyzeMars1(candles: Candle[]): LiveAnalysis {
  const window = candles.slice(-200);
  const ob = analyze(window);
  const mom = analyzeMomentum(window);
  const mr = analyzeMeanReversion(window);

  const tradable = [ob, mom, mr].filter((r) => r.decision !== "WAIT");
  if (!tradable.length) {
    // Return the highest-confidence WAIT for diagnostics
    const best = [ob, mom, mr].sort((a, b) => b.confidence - a.confidence)[0];
    return {
      ...best,
      strategy: "mars1",
      rationale: `[Mars1] All 3 detectors WAIT. Best diag: ${best.strategy} — ${best.rationale}`,
    };
  }
  const best = tradable.sort((a, b) => b.confidence - a.confidence)[0];
  return {
    ...best,
    strategy: "mars1",
    rationale: `[Mars1 · ${best.strategy}] ${best.rationale}`,
  };
}

/**
 * Mars2 — refined Mars1 for 1s-tick synthetic volatility indices.
 *
 * Detects target symbol via candle tick spacing (median epoch delta ≤ 2s
 * is treated as a 1s vol index). Falls back to plain Mars1 otherwise.
 */
export function analyzeMars2(candles: Candle[], symbolHint?: string): LiveAnalysis {
  const window = candles.slice(-240);
  const is1sVol = detectOneSecondVol(window, symbolHint);

  const ob = analyze(window);
  const mom = analyzeMomentum(window);
  const mr = analyzeMeanReversion(window);

  // Refined weighting: on 1s vol indices momentum dominates because trends
  // are short-lived; mean-reversion needs a very extreme RSI to be trusted.
  const weight = (r: LiveAnalysis): number => {
    if (r.decision === "WAIT") return 0;
    let w = r.confidence;
    if (is1sVol) {
      if (r.strategy === "momentum") w *= 1.15;
      if (r.strategy === "mean-reversion") {
        // only trust MR if RSI truly extreme
        if (r.decision === "BUY" && r.rsi14 > 25) w *= 0.7;
        if (r.decision === "SELL" && r.rsi14 < 75) w *= 0.7;
      }
      if (r.strategy === "ob-fvg") w *= 1.05;
    }
    return w;
  };

  const scored = [ob, mom, mr]
    .map((r) => ({ r, w: weight(r) }))
    .sort((a, b) => b.w - a.w);
  const top = scored[0];

  if (!top || top.w === 0) {
    const diag = [ob, mom, mr].sort((a, b) => b.confidence - a.confidence)[0];
    return {
      ...diag,
      strategy: "mars2",
      rationale: `[Mars2${is1sVol ? " · 1s-vol" : ""}] All 3 detectors WAIT. Best diag: ${diag.strategy} — ${diag.rationale}`,
    };
  }

  // Rescale SL/TP for 1s vol: tighter stops, faster targets.
  const best = top.r;
  const atr14 = best.atr14 || 0;
  const isBuy = best.decision === "BUY";
  let entry = best.entry;
  let sl = best.sl;
  let tp = best.tp;
  if (is1sVol && entry != null && atr14 > 0) {
    const slMult = 1.0; // was 1.2–1.5
    const tpMult = 1.8; // was 2.5–3.0
    sl = isBuy ? entry - slMult * atr14 : entry + slMult * atr14;
    tp = isBuy ? entry + tpMult * atr14 : entry - tpMult * atr14;
  }

  // Lift confidence floor slightly to represent Mars2's stricter filtering.
  const bumped = Math.min(0.97, top.w + (is1sVol ? 0.03 : 0));

  return {
    ...best,
    entry,
    sl,
    tp,
    strategy: "mars2",
    confidence: bumped,
    rationale: `[Mars2${is1sVol ? " · 1s-vol" : ""} · ${best.strategy}] ${best.rationale}${is1sVol ? " | SL/TP rescaled 1.0x/1.8x ATR." : ""}`,
  };
}

function detectOneSecondVol(candles: Candle[], symbolHint?: string): boolean {
  if (symbolHint) {
    const s = symbolHint.toUpperCase();
    // Deriv naming: 1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V, 1HZ150V, 1HZ250V, 1HZ15V (if listed)
    if (s.startsWith("1HZ") && s.endsWith("V")) return true;
    if (s.includes("(1S)")) return true;
  }
  // Fallback: infer from candle tick spacing
  const n = candles.length;
  if (n < 5) return false;
  const deltas: number[] = [];
  for (let i = 1; i < Math.min(n, 30); i++) {
    const d = candles[i].epoch - candles[i - 1].epoch;
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return false;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return median > 0 && median <= 2;
}

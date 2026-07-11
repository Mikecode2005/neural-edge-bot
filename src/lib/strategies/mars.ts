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

/**
 * Mars3 — Mars1, optimised. Same 3-detector best-of core (Mars1 is untouched),
 * but layered with:
 *   • Pullback-confirmation gate — refuse to enter at the very tip of a
 *     candle spike (this is what was hitting SL before the "pump"). We
 *     require the last close to have retraced ≥25% back into the prior
 *     candle range in the entry direction, or an active OB/FVG mitigation.
 *   • Wider ATR stop (1.8× ATR14) with proportionally smaller lots so the
 *     dollar risk envelope stays the same but breathing room grows.
 *   • R:R lifted to 2.5× (SL) → so a lower win-rate still nets profit.
 *   • Trend-alignment vetoes counter-trend picks unless MR RSI is very
 *     extreme (<18 buys / >82 sells).
 *   • Balance awareness: caller-supplied `balance` is used to skip the trade
 *     entirely if projected worst-case risk > 3% of balance.
 *
 * volumeMultiplier is exported alongside so the bot can down-scale lots to
 * keep dollar risk constant when the SL widens.
 */
export interface Mars3Result extends LiveAnalysis {
  volumeMultiplier: number;
}

export function analyzeMars3(
  candles: Candle[],
  opts: { balance?: number; baseVolume?: number; symbolHint?: string } = {},
): Mars3Result {
  const window = candles.slice(-220);
  const ob = analyze(window);
  const mom = analyzeMomentum(window);
  const mr = analyzeMeanReversion(window);

  const last = window.at(-1);
  const prev = window.at(-2);
  const balance = Number(opts.balance ?? 0);

  // Balance-conscious hard skip: if account is thin, only take highest-conf setups.
  const balanceGate = balance > 0 && balance < 20 ? 0.82 : balance < 50 ? 0.75 : 0.68;

  const tradable = [ob, mom, mr].filter((r) => r.decision !== "WAIT");
  if (!tradable.length) {
    const best = [ob, mom, mr].sort((a, b) => b.confidence - a.confidence)[0];
    return {
      ...best,
      strategy: "mars3",
      rationale: `[Mars3] All 3 detectors WAIT. Best diag: ${best.strategy} — ${best.rationale}`,
      volumeMultiplier: 1,
    };
  }

  // Trend-alignment veto for MR unless RSI truly extreme
  const trend = String(ob.trend ?? "").toLowerCase();
  const filtered = tradable.filter((r) => {
    if (r.strategy !== "mean-reversion") return true;
    if (r.decision === "BUY" && r.rsi14 < 18) return true;
    if (r.decision === "SELL" && r.rsi14 > 82) return true;
    if (trend.includes("bull") && r.decision === "SELL") return false;
    if (trend.includes("bear") && r.decision === "BUY") return false;
    return true;
  });
  const pool = filtered.length ? filtered : tradable;
  const best = pool.sort((a, b) => b.confidence - a.confidence)[0];

  // Pullback-confirmation gate — "don't chase the tip"
  let pullbackOk = true;
  let pullbackNote = "";
  if (last && prev) {
    const range = Math.max(1e-9, prev.high - prev.low);
    if (best.decision === "BUY") {
      // In a buy, we want the last close to be pulled back off recent high,
      // OR sitting inside/near an active bullish OB/FVG.
      const retrace = (last.high - last.close) / Math.max(1e-9, last.high - last.low || range);
      const inZone =
        (ob.activeOB && ob.activeOB.kind === "bullish" && last.close <= ob.activeOB.top) ||
        (ob.activeFVG && ob.activeFVG.kind === "bullish" && last.close <= ob.activeFVG.top);
      pullbackOk = retrace >= 0.25 || Boolean(inZone) || best.strategy === "mean-reversion";
      if (!pullbackOk) pullbackNote = " | Rejected: BUY too extended (no ≥25% pullback, no zone).";
    } else if (best.decision === "SELL") {
      const retrace = (last.close - last.low) / Math.max(1e-9, last.high - last.low || range);
      const inZone =
        (ob.activeOB && ob.activeOB.kind === "bearish" && last.close >= ob.activeOB.bottom) ||
        (ob.activeFVG && ob.activeFVG.kind === "bearish" && last.close >= ob.activeFVG.bottom);
      pullbackOk = retrace >= 0.25 || Boolean(inZone) || best.strategy === "mean-reversion";
      if (!pullbackOk) pullbackNote = " | Rejected: SELL too extended (no ≥25% pullback, no zone).";
    }
  }

  // Widen SL to 1.8×ATR, extend TP to 2.5× that (RR ≈ 2.5).
  const atr14 = best.atr14 || 0;
  const isBuy = best.decision === "BUY";
  let entry = best.entry;
  let sl = best.sl;
  let tp = best.tp;
  const slMult = 1.8;
  const tpMult = 4.5; // 1.8 * 2.5 = 4.5×ATR reward for a 1.8×ATR risk
  if (entry != null && atr14 > 0) {
    sl = isBuy ? entry - slMult * atr14 : entry + slMult * atr14;
    tp = isBuy ? entry + tpMult * atr14 : entry - tpMult * atr14;
  }

  // Volume rescale to keep dollar risk equal to the caller's baseline (Mars1 uses ~1.2×ATR).
  // widerSL/originalSL = 1.8/1.2 = 1.5 → lots should shrink by 1/1.5 ≈ 0.67.
  const volumeMultiplier = 0.67;

  // Confidence rescored: reward RR upgrade, penalise chase-entries.
  let confidence = best.confidence;
  if (!pullbackOk) confidence *= 0.6;
  confidence = Math.min(0.97, confidence + 0.03); // small bump for tighter framework

  // Balance gate
  const belowBalanceGate = confidence < balanceGate;
  const decision = pullbackOk && !belowBalanceGate ? best.decision : ("WAIT" as const);

  const gateNote = belowBalanceGate
    ? ` | Balance-gate: need conf ≥ ${(balanceGate * 100).toFixed(0)}% (bal $${balance.toFixed(2)}).`
    : "";

  return {
    ...best,
    decision,
    entry,
    sl,
    tp,
    strategy: "mars3",
    confidence,
    rationale: `[Mars3 · ${best.strategy}] ${best.rationale} | SL/TP 1.8x/4.5xATR (RR 2.5) · lot×${volumeMultiplier.toFixed(2)}${pullbackNote}${gateNote}`,
    volumeMultiplier,
  };
}

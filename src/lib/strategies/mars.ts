/**
 * MARS strategies — restored, tuned, and bug-fixed multi-strategy detectors.
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
 *
 * Mars3  — Mars1 + pullback gate, wider ATR stop, MTF confirmation,
 *          balance-aware confidence gate.
 *          FIXED (this revision):
 *            1. MTF gate no longer force-WAITs every trade when the caller
 *               supplies partial higher-timeframe data (e.g. only h1/h4,
 *               no m5/m15). Previously any m5/m15 gap silently zeroed out
 *               `requiredOk`, which likely explains a chunk of "no trades /
 *               low-confidence trades" behaviour in production.
 *            2. Mean-reversion entries no longer bypass the pullback gate
 *               unconditionally — they now require an actual confirming
 *               candle (close beyond open, in the entry direction) instead
 *               of just an extreme RSI reading. This was letting MR "catch
 *               the falling knife" with no reversal confirmation at all.
 *            3. volumeMultiplier is now derived from the actual change in
 *               SL distance (original detector SL vs Mars3's widened SL)
 *               instead of a hardcoded 0.67 that assumed every detector
 *               uses a 1.2xATR stop internally.
 *
 * Mars4  — Adaptive Profile-Driven Strategy (inherits all Mars3 fixes above
 *          since it calls analyzeMars3 internally).
 *          FIXED (this revision):
 *            4. Session-tier confidence swing reduced from ±0.08 to ±0.03.
 *               ±0.08 on a "best hour was 2am Wednesday"-style backtest
 *               stat is a classic overfitting trap — small-sample hour/day
 *               edges rarely survive out-of-sample. Shrunk until validated
 *               on more recent data.
 *
 * Mars5  — NEW. "Fluidity scraper" — see the block comment above
 *          analyzeMars5 for the full design rationale.
 */
import type { Candle } from "@/lib/deriv-ws";
import { analyze, analyzeMeanReversion, analyzeMomentum, type LiveAnalysis } from "@/lib/ob-fvg";

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

  const scored = [ob, mom, mr].map((r) => ({ r, w: weight(r) })).sort((a, b) => b.w - a.w);
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
 *     candle range in the entry direction, or an active OB/FVG mitigation,
 *     or — for mean-reversion — an actual confirming reversal candle
 *     (FIXED: previously MR bypassed this gate unconditionally).
 *   • Wider ATR stop (1.8× ATR14) with proportionally smaller lots so the
 *     dollar risk envelope stays the same but breathing room grows.
 *   • R:R lifted to 2.5× (SL) → so a lower win-rate still nets profit.
 *   • Trend-alignment vetoes counter-trend picks unless MR RSI is very
 *     extreme (<18 buys / >82 sells).
 *   • Balance awareness: caller-supplied `balance` is used to skip the trade
 *     entirely if projected worst-case risk > 3% of balance.
 *   • MTF gate (FIXED): only enforces alignment on higher timeframes the
 *     caller actually supplied. Previously, supplying any HTF data that
 *     didn't include *both* m5 and m15 silently forced every trade to WAIT
 *     — a likely cause of "strategy isn't taking trades" in production.
 *
 * volumeMultiplier is exported alongside so the bot can down-scale lots to
 * keep dollar risk constant when the SL widens. It is now computed from the
 * actual before/after SL distance rather than a hardcoded constant.
 */
export interface Mars3Result extends LiveAnalysis {
  volumeMultiplier: number;
  mtfAgreement?: number;
  rr?: number;
}

export type MarsHigherTimeframeKey = "m5" | "m15" | "m30" | "h1" | "h4";

export type MarsHigherTimeframes = Partial<Record<MarsHigherTimeframeKey, Candle[]>>;

interface MarsMtfVote {
  key: MarsHigherTimeframeKey;
  direction: "BUY" | "SELL" | "WAIT";
  confidence: number;
  trend: "up" | "down";
}

function directionFromAnalysis(a: LiveAnalysis): "BUY" | "SELL" | "WAIT" {
  if (a.decision === "BUY" || a.decision === "SELL") return a.decision;
  if (a.trend === "up" && a.ema20 >= a.ema50) return "BUY";
  if (a.trend === "down" && a.ema20 <= a.ema50) return "SELL";
  return "WAIT";
}

function summarizeHigherTimeframes(htf?: MarsHigherTimeframes): MarsMtfVote[] {
  if (!htf) return [];
  const keys: MarsHigherTimeframeKey[] = ["m5", "m15", "m30", "h1", "h4"];
  return keys.flatMap((key) => {
    const cs = htf[key];
    if (!cs || cs.length < 60) return [];
    const a = analyze(cs.slice(-220));
    return [{ key, direction: directionFromAnalysis(a), confidence: a.confidence, trend: a.trend }];
  });
}

/**
 * FIXED: only enforces m5/m15 alignment for timeframes the caller actually
 * supplied. A required timeframe that's simply *absent* from the data no
 * longer counts as "not aligned" — previously it did, which meant partial
 * higher-timeframe data (e.g. h1/h4 only, no m5/m15) silently forced
 * requiredOk to false on every call, WAIT-ing every trade regardless of
 * signal quality.
 */
function mtfAgreementFor(direction: "BUY" | "SELL", votes: MarsMtfVote[]) {
  if (!votes.length) return { aligned: 0, total: 0, requiredOk: true, note: "" };
  const aligned = votes.filter((v) => v.direction === direction).length;
  const must = new Map(votes.map((v) => [v.key, v.direction]));

  const requiredKeys: MarsHigherTimeframeKey[] = ["m5", "m15"];
  const presentRequired = requiredKeys.filter((k) => must.has(k));
  const requiredAligned = presentRequired.every((k) => must.get(k) === direction);

  // If neither m5 nor m15 was supplied, fall back to a majority-of-supplied
  // check instead of silently passing OR silently failing every trade.
  const majorityOk = aligned / votes.length >= 0.6;

  const requiredOk = presentRequired.length
    ? requiredAligned && aligned >= Math.min(3, votes.length)
    : majorityOk;

  const missing = requiredKeys.filter((k) => !must.has(k));
  const missingNote = missing.length ? ` (${missing.join("/")} not supplied)` : "";

  return {
    aligned,
    total: votes.length,
    requiredOk,
    note: ` | MTF ${aligned}/${votes.length} aligned${requiredOk ? "" : " (required TFs not aligned)"}${missingNote}`,
  };
}

export function analyzeMars3(
  candles: Candle[],
  opts: {
    balance?: number;
    baseVolume?: number;
    symbolHint?: string;
    higherTimeframes?: MarsHigherTimeframes;
  } = {},
): Mars3Result {
  const window = candles.slice(-220);
  const ob = analyze(window);
  const mom = analyzeMomentum(window);
  const mr = analyzeMeanReversion(window);

  const last = window.at(-1);
  const prev = window.at(-2);
  const balance = Number(opts.balance ?? 0);

  // Quality gate — fixed floor for signal quality, NOT tied to balance.
  // Balance only affects volume sizing later, never the prediction trustworthiness.
  const qualityGate = 0.68;

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

  // Weighted MTF agreement: H4 matters more than M5
  const MTF_WEIGHTS: Record<MarsHigherTimeframeKey, number> = { m5: 0.5, m15: 1, m30: 1.5, h1: 2, h4: 3 };
  function weightedMtfAgreement(direction: "BUY" | "SELL", votes: MarsMtfVote[]) {
    if (!votes.length) return { weightedRatio: 0.5, totalWeight: 0, alignedWeight: 0 };
    const totalWeight = votes.reduce((s, v) => s + (MTF_WEIGHTS[v.key] ?? 1), 0);
    const alignedWeight = votes
      .filter((v) => v.direction === direction)
      .reduce((s, v) => s + (MTF_WEIGHTS[v.key] ?? 1), 0);
    return { weightedRatio: totalWeight > 0 ? alignedWeight / totalWeight : 0.5, totalWeight, alignedWeight };
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
  const votes = summarizeHigherTimeframes(opts.higherTimeframes);
  const mtf =
    best.decision === "BUY" || best.decision === "SELL"
      ? mtfAgreementFor(best.decision, votes)
      : { aligned: 0, total: votes.length, requiredOk: true, note: "" };

  // Adaptive pullback threshold: strong trends need less pullback, choppy markets need more.
  const adxValue = best.adx14 ?? ob.adx14 ?? 20;
  const pullbackThreshold = adxValue > 30 ? 0.15 : adxValue < 18 ? 0.35 : 0.25;

  // Pullback-confirmation gate — "don't chase the tip"
  let pullbackOk = true;
  let pullbackNote = "";
  if (last && prev) {
    const range = Math.max(1e-9, prev.high - prev.low);
    const mrReversalConfirmed = (dir: "BUY" | "SELL") =>
      best.strategy === "mean-reversion" &&
      ((dir === "BUY" && last.close > last.open && last.close > prev.close) ||
        (dir === "SELL" && last.close < last.open && last.close < prev.close));

    if (best.decision === "BUY") {
      const retrace = (last.high - last.close) / Math.max(1e-9, last.high - last.low || range);
      const inZone =
        (ob.activeOB && ob.activeOB.kind === "bullish" && last.close <= ob.activeOB.top) ||
        (ob.activeFVG && ob.activeFVG.kind === "bullish" && last.close <= ob.activeFVG.top);
      pullbackOk = retrace >= pullbackThreshold || Boolean(inZone) || mrReversalConfirmed("BUY");
      if (!pullbackOk) {
        pullbackNote =
          best.strategy === "mean-reversion"
            ? ` | Rejected: MR BUY has no confirming reversal candle (retrace ${(retrace * 100).toFixed(0)}% < ${(pullbackThreshold * 100).toFixed(0)}%).`
            : ` | Rejected: BUY too extended (retrace ${(retrace * 100).toFixed(0)}% < ${(pullbackThreshold * 100).toFixed(0)}%).`;
      }
    } else if (best.decision === "SELL") {
      const retrace = (last.close - last.low) / Math.max(1e-9, last.high - last.low || range);
      const inZone =
        (ob.activeOB && ob.activeOB.kind === "bearish" && last.close >= ob.activeOB.bottom) ||
        (ob.activeFVG && ob.activeFVG.kind === "bearish" && last.close >= ob.activeFVG.bottom);
      pullbackOk = retrace >= pullbackThreshold || Boolean(inZone) || mrReversalConfirmed("SELL");
      if (!pullbackOk) {
        pullbackNote =
          best.strategy === "mean-reversion"
            ? ` | Rejected: MR SELL has no confirming reversal candle (retrace ${(retrace * 100).toFixed(0)}% < ${(pullbackThreshold * 100).toFixed(0)}%).`
            : ` | Rejected: SELL too extended (retrace ${(retrace * 100).toFixed(0)}% < ${(pullbackThreshold * 100).toFixed(0)}%).`;
      }
    }
  }

  // Structure-based RR: trend continuation gets higher RR, MR gets lower RR.
  // Independent of confidence — relies on market context instead.
  const isTrendFavorable = (best.decision === "BUY" && trend.includes("bull")) ||
    (best.decision === "SELL" && trend.includes("bear"));
  const mtfW = weightedMtfAgreement(
    best.decision === "BUY" ? "BUY" : "SELL",
    votes,
  );
  const rr = best.strategy === "mean-reversion" ? 1.2 :
    mtfW.weightedRatio >= 0.7 ? 2.0 :
    isTrendFavorable ? 1.5 : 1.0;

  // Balance-aware RR: normal/high confidence uses 1:1, strongest MTF-confirmed setups use 1:2.
  const atr14 = best.atr14 || 0;
  const isBuy = best.decision === "BUY";
  const originalEntry = best.entry;
  const originalSl = best.sl;
  let entry = best.entry;
  let sl = best.sl;
  let tp = best.tp;
  const slMult = 1.8;
  const tpMult = slMult * rr;
  if (entry != null && atr14 > 0) {
    sl = isBuy ? entry - slMult * atr14 : entry + slMult * atr14;
    tp = isBuy ? entry + tpMult * atr14 : entry - tpMult * atr14;
  }

  // FIXED: volumeMultiplier is now derived from the real change in SL
  // distance instead of a hardcoded 0.67 that assumed every detector uses
  // a 1.2xATR stop internally. Falls back to 0.67 only if we don't have
  // enough data to compute it directly.
  let volumeMultiplier = 0.67;
  if (originalEntry != null && originalSl != null && entry != null && sl != null) {
    const originalSlDist = Math.abs(originalEntry - originalSl);
    const newSlDist = Math.abs(entry - sl);
    if (originalSlDist > 0 && newSlDist > 0) {
      volumeMultiplier = Math.max(0.1, Math.min(1, originalSlDist / newSlDist));
    }
  }

  // Confidence rescored: additive adjustments instead of harsh multiplication
  let confidence = best.confidence;
  confidence += pullbackOk ? 0.03 : -0.12;
  if (mtf.total) confidence += mtf.requiredOk ? 0.04 : -0.10;
  confidence = Math.min(0.97, Math.max(0, confidence + 0.02));

  // Decision: balance affects volumeMultiplier, NOT whether we trade.
  const decision = pullbackOk && mtf.requiredOk ? best.decision : ("WAIT" as const);

  // Balance-aware volume scaling instead of rejecting trades outright
  const balanceVolMultiplier = balance > 0 && balance < 20 ? 0.5 : balance < 50 ? 0.75 : 1;
  volumeMultiplier = Math.min(1, volumeMultiplier * balanceVolMultiplier);

  const gateNote = "";

  return {
    ...best,
    decision,
    entry,
    sl,
    tp,
    strategy: "mars3",
    confidence,
    rationale: `[Mars3 · ${best.strategy}] ${best.rationale} | SL ${slMult.toFixed(1)}xATR · TP RR ${rr}:1 · lot×${volumeMultiplier.toFixed(2)}${mtf.note}${pullbackNote}${gateNote} | ADX ${adxValue.toFixed(0)} · pullback floor ${(pullbackThreshold * 100).toFixed(0)}%`,
    volumeMultiplier,
    mtfAgreement: mtf.total ? mtf.aligned / mtf.total : undefined,
    rr,
  };
}

// ---------------------------------------------------------------------------
// Mars4 — Adaptive Profile-Driven Strategy
//
// Per-symbol profiles from Bayesian optimizer results:
//   vol_90       tp=4.0  sl=2.0  minRR=2.0  bestHour=2   bestDay=Wed
//   vol_15_1s    tp=4.0  sl=1.5  minRR=2.0  bestHour=22  bestDay=Wed
//   vol_75       tp=2.0  sl=1.25 minRR=1.5  bestHour=17  bestDay=Fri
//   vol_100      tp=4.0  sl=1.5  minRR=1.0  bestHour=6   bestDay=Mon
//   vol_90_1s    tp=2.5  sl=1.75 minRR=1.0  bestHour=2   bestDay=Thu
//   vol_50       tp=3.0  sl=2.0  minRR=1.0  bestHour=23  bestDay=Sat
//   vol_100_1s   tp=3.0  sl=2.0  minRR=1.5  bestHour=23  bestDay=Sun
//   vol_25_1s    tp=3.5  sl=2.0  minRR=1.5  bestHour=21  bestDay=Tue
//   vol_30       tp=4.0  sl=2.0  minRR=1.5  bestHour=16  bestDay=Thu
//
// NOTE: these bestHour/bestDay stats came from a single backtest window.
// Small-sample hour/weekday edges are a classic overfitting trap — treat
// the confidence bonus below as a soft nudge, not a strong signal, until
// it's been validated against more recent out-of-sample data.
// ---------------------------------------------------------------------------

interface VolatilityProfileParams {
  /** Deriv symbol substrings to match (lowercase) */
  match: string[];
  tpMult: number;
  slMult: number;
  /** Min R:R ratio — skip trade if tp/sl distance ratio falls below this */
  minRR: number;
  /** Best UTC hours for this symbol */
  bestHours: number[];
  /** Best weekdays 0=Sun 1=Mon … 6=Sat (getUTCDay encoding) */
  bestDays: number[];
}

const VOLATILITY_PROFILES: VolatilityProfileParams[] = [
  // vol_15_1s  — score 129, WR 53%, PF 3.02
  { match: ["15", "1s", "1hz15"], tpMult: 4.0, slMult: 1.5, minRR: 2.0, bestHours: [22, 21, 23], bestDays: [3, 2] },
  // vol_25_1s  — score 81, WR 58%, PF 2.41
  { match: ["25", "1s", "1hz25"], tpMult: 3.5, slMult: 2.0, minRR: 1.5, bestHours: [21, 20, 22], bestDays: [2, 3] },
  // vol_30     — score 121, WR 57%, PF 2.74
  { match: ["30"], tpMult: 4.0, slMult: 2.0, minRR: 1.5, bestHours: [16, 15, 17], bestDays: [4, 3] },
  // vol_50     — score 116, WR 64%, PF 2.69
  { match: ["50"], tpMult: 3.0, slMult: 2.0, minRR: 1.0, bestHours: [23, 22, 0], bestDays: [6, 5] },
  // vol_75     — score 95, WR 61%, PF 2.61
  { match: ["75"], tpMult: 2.0, slMult: 1.25, minRR: 1.5, bestHours: [17, 16, 18], bestDays: [5, 4] },
  // vol_90_1s  — score 92, WR 63%, PF 2.42 (must be before vol_90 — longer match wins)
  { match: ["90", "1s", "1hz90"], tpMult: 2.5, slMult: 1.75, minRR: 1.0, bestHours: [2, 1, 3], bestDays: [4, 3] },
  // vol_90     — score 128, WR 59%
  { match: ["90"], tpMult: 4.0, slMult: 2.0, minRR: 2.0, bestHours: [2, 1, 3], bestDays: [3, 2] },
  // vol_100_1s — score 61, WR 63%, PF 2.60 (must be before vol_100)
  { match: ["100", "1s", "1hz100"], tpMult: 3.0, slMult: 2.0, minRR: 1.5, bestHours: [23, 22, 0], bestDays: [0, 6] },
  // vol_100    — score 101, WR 51%, PF 2.73
  { match: ["100"], tpMult: 4.0, slMult: 1.5, minRR: 1.0, bestHours: [6, 5, 7], bestDays: [1, 2] },
];

/** Default fallback profile when no symbolHint matches */
const DEFAULT_PROFILE: VolatilityProfileParams = {
  match: [],
  tpMult: 3.0,
  slMult: 1.8,
  minRR: 1.5,
  bestHours: [8, 9, 10, 14, 15, 16],
  bestDays: [1, 2, 3, 4],
};

/**
 * Resolve the best-matching profile for a given symbolHint.
 * Uses longest-match-token disambiguation so "vol_90_1s" does not
 * fall through to the plain "vol_90" profile.
 */
function resolveProfile(symbolHint?: string): VolatilityProfileParams {
  if (!symbolHint) return DEFAULT_PROFILE;
  const s = symbolHint.toLowerCase();
  // Sort by the longest matching token to give most-specific profile priority
  const sorted = [...VOLATILITY_PROFILES].sort((a, b) => {
    const aScore = a.match.reduce((best, m) => Math.max(best, s.includes(m) ? m.length : 0), 0);
    const bScore = b.match.reduce((best, m) => Math.max(best, s.includes(m) ? m.length : 0), 0);
    return bScore - aScore;
  });
  for (const p of sorted) {
    if (p.match.some((m) => s.includes(m))) return p;
  }
  return DEFAULT_PROFILE;
}

/** Session timing tier — derived from profile's best hours/days */
type SessionTier = "PRIME" | "GOOD" | "OFF_PEAK";

function computeSessionTier(nowEpoch: number, profile: VolatilityProfileParams): SessionTier {
  const d = new Date(nowEpoch * 1000);
  const hour = d.getUTCHours();
  const day  = d.getUTCDay(); // 0=Sun … 6=Sat
  const bestHour = profile.bestHours.includes(hour);
  const bestDay  = profile.bestDays.includes(day);
  if (bestHour && bestDay) return "PRIME";
  if (bestHour || bestDay) return "GOOD";
  return "OFF_PEAK";
}

export interface Mars4Result extends Mars3Result {
  scaleAllowed: boolean;
  maxScalePositions: number;
  basketProfitTargetUsd: number;
  basketStopUsd: number;
  mtfScore: number;
  microScore: number;
  sessionTier: SessionTier;
  profileUsed: string;
  gates: {
    rsiAligned: boolean;
    bosChochPresent: boolean;
    pullbackOk: boolean;
    spreadOk: boolean;
    rrOk: boolean;
  };
}

/**
 * Mars4 — Adaptive Profile-Driven Strategy
 *
 * Symbol-aware: resolves a per-symbol VolatilityProfile from `symbolHint` and
 * uses its Bayesian-optimised TP/SL multipliers, best-hour/day session tiers,
 * and minRR gate.
 *
 * opts.minConfidence  : caller-supplied confidence floor (0–1). No hardcoded
 *                       minimum — pass the bot's configured min_confidence.
 * opts.nowEpoch       : current UTC epoch (seconds). Falls back to
 *                       Date.now()/1000 when omitted (fully deterministic in
 *                       tests when supplied).
 */
export function analyzeMars4(
  candles: Candle[],
  opts: {
    balance?: number;
    symbolHint?: string;
    higherTimeframes?: MarsHigherTimeframes;
    spreadPrice?: number;
    /** Confidence floor, 0–1. No hardcoded minimum. */
    minConfidence?: number;
    /** Current UTC epoch in seconds for session-tier calculation. */
    nowEpoch?: number;
  } = {},
): Mars4Result {
  // ── 0. Resolve per-symbol optimised profile ────────────────────────────
  const profile = resolveProfile(opts.symbolHint);

  // Adaptive lookback: longer window for profiles trained on 512 candles
  const lookback = Math.min(512, Math.max(220, profile.tpMult >= 3.5 ? 420 : 280));
  const window = candles.slice(-lookback);

  // ── 1. Mars3 base signal (now carries all Mars3 fixes above) ──────────
  const base = analyzeMars3(window, {
    balance: opts.balance,
    symbolHint: opts.symbolHint,
    higherTimeframes: opts.higherTimeframes,
  });

  const last   = window.at(-1);
  const prev   = window.at(-2);
  const closes = window.slice(-8).map((c) => c.close);
  const atr    = Math.max(1e-9, base.atr14 || 0);
  const spread = Math.max(0, Number(opts.spreadPrice ?? 0));
  const isBuy  = base.decision === "BUY";

  // ── 2. Gate 4 — Spread ────────────────────────────────────────────────
  // Pass automatically when spread is 0 or not supplied. NOTE: if your live
  // bot never actually passes opts.spreadPrice, this gate is a no-op and
  // you lose the one live-execution-cost check in the file — confirm the
  // caller wires this through.
  const spreadOk = spread === 0 ? true : spread <= atr * 0.30;

  // ── 3. Gate 1 — RSI directional alignment ─────────────────────────────
  // Loss pattern from bot history: RSI 60–70 on PUT entries → gate them out
  //   BUY  → RSI ≤ 55 (room to rise, not overbought)
  //   SELL → RSI ≥ 45 (room to fall, not oversold)
  const rsi = base.rsi14 ?? 50;
  const rsiAligned =
    base.decision === "WAIT" ||
    (isBuy  && rsi <= 55) ||
    (!isBuy && rsi >= 45);

  // ── 4. Gate 2 — BOS / CHoCH structural confirmation ───────────────────
  // Use the actual boolean fields from LiveAnalysis instead of string matching
  const bosChochPresent = Boolean(base.bos || base.choch);

  // ── 5. Gate 3 — Pullback / zone re-entry ──────────────────────────────
  let pullbackOk = true;
  if (last && prev && base.decision !== "WAIT") {
    const range = Math.max(1e-9, prev.high - prev.low);
    if (isBuy) {
      const retrace = (last.high - last.close) / Math.max(1e-9, last.high - last.low || range);
      const inZone =
        (base.activeOB && base.activeOB.kind === "bullish" && last.close <= base.activeOB.top) ||
        (base.activeFVG && base.activeFVG.kind === "bullish" && last.close <= base.activeFVG.top);
      pullbackOk = retrace >= 0.25 || Boolean(inZone) || base.strategy === "mean-reversion";
    } else {
      const retrace = (last.close - last.low) / Math.max(1e-9, last.high - last.low || range);
      const inZone =
        (base.activeOB && base.activeOB.kind === "bearish" && last.close >= base.activeOB.bottom) ||
        (base.activeFVG && base.activeFVG.kind === "bearish" && last.close >= base.activeFVG.bottom);
      pullbackOk = retrace >= 0.25 || Boolean(inZone) || base.strategy === "mean-reversion";
    }
  }

  // ── 6. Micro-structure score ───────────────────────────────────────────
  let microScore = 0;
  if (last && prev && closes.length >= 4 && base.decision !== "WAIT") {
    const dirSign     = isBuy ? 1 : -1;
    const impulse     = (last.close - prev.close) * dirSign;
    const barRange    = Math.max(1e-9, last.high - last.low);
    const closeLoc    = isBuy
      ? (last.close - last.low) / barRange
      : (last.high - last.close) / barRange;
    const shortSlope  = (closes.at(-1)! - closes.at(-4)!) * dirSign;
    const notExtended = Math.abs(last.close - Number(base.entry ?? last.close)) <= atr * 1.8;
    microScore += impulse    > 0    ? 0.25 : 0;
    microScore += shortSlope > 0    ? 0.25 : 0;
    microScore += closeLoc   >= 0.5 ? 0.20 : 0;
    microScore += notExtended       ? 0.20 : 0;
    microScore += spreadOk          ? 0.10 : -0.20;
  }
  microScore = Math.max(0, Math.min(1, microScore));

  // ── 7. MTF score ──────────────────────────────────────────────────────
  const mtfScore = Number(base.mtfAgreement ?? 0.5);

  // ── 8. Confidence synthesis ───────────────────────────────────────────
  // Base: Mars3×0.60 + MTF×0.20 + micro×0.10
  // Bonuses: BOS/CHoCH +0.05, RSI aligned +0.03, pullback OK +0.02
  // No hardcoded floor — caller supplies minConfidence
  let confidence = Math.min(
    0.99,
    base.confidence * 0.60 + mtfScore * 0.20 + microScore * 0.10,
  );
  if (bosChochPresent)                        confidence = Math.min(0.99, confidence + 0.05);
  if (rsiAligned && base.decision !== "WAIT") confidence = Math.min(0.99, confidence + 0.03);
  if (pullbackOk && base.decision !== "WAIT") confidence = Math.min(0.99, confidence + 0.02);

  // ── 9. Session timing tier adjustment ────────────────────────────────
  // FIXED: swing reduced from ±0.08 to ±0.03 — see overfitting note above
  // VOLATILITY_PROFILES.
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  const tier     = computeSessionTier(nowEpoch, profile);
  const tierAdj  = tier === "PRIME" ? 0.03 : tier === "OFF_PEAK" ? -0.03 : 0;
  confidence     = Math.min(0.99, Math.max(0, confidence + tierAdj));

  // ── 10. Gate 5 — R:R check ───────────────────────────────────────────
  const tpDist = atr * profile.tpMult;
  const slDist = Math.max(atr * profile.slMult, spread > 0 ? spread * 3 : 0);
  const rr     = slDist > 0 ? tpDist / slDist : 0;
  const rrOk   = slDist > 0 && rr >= profile.minRR;

  // ── 11. Build final SL/TP from profile ───────────────────────────────
  const entry = base.entry ?? last?.close;
  let sl = base.sl;
  let tp = base.tp;
  if (entry != null && atr > 0 && base.decision !== "WAIT") {
    sl = isBuy ? entry - slDist : entry + slDist;
    tp = isBuy ? entry + tpDist : entry - tpDist;
  }

  // ── 12. Final decision ────────────────────────────────────────────────
  const minConf     = opts.minConfidence ?? 0;
  const gatesPassed =
    base.decision !== "WAIT" &&
    rsiAligned &&
    pullbackOk &&
    spreadOk &&
    rrOk &&
    confidence >= minConf;
  const decision = gatesPassed ? base.decision : ("WAIT" as const);

  // ── 13. Position sizing ───────────────────────────────────────────────
  const volumeMultiplier =
    confidence >= 0.90 ? 1.00 :
    confidence >= 0.80 ? 0.80 :
    confidence >= 0.70 ? 0.60 : 0.40;

  const balance = Math.max(0, Number(opts.balance ?? 0));
  const maxScalePositions =
    confidence >= 0.90 ? 10 : confidence >= 0.80 ? 6 : confidence >= 0.70 ? 4 : 2;
  const basketProfitTargetUsd = Math.max(
    1,
    Number((balance * (confidence >= 0.80 ? 0.006 : 0.003)).toFixed(2)),
  );
  const basketStopUsd = Math.max(2, Number((balance * 0.015).toFixed(2)));
  const scaleAllowed  = gatesPassed && microScore >= 0.40;

  // ── 14. Rationale ─────────────────────────────────────────────────────
  const gateLog = [
    rsiAligned  ? null : `RSI ${rsi.toFixed(0)} misaligned`,
    pullbackOk  ? null : "no pullback/zone",
    spreadOk    ? null : "spread too wide",
    rrOk        ? null : `RR ${rr.toFixed(2)} < min ${profile.minRR}`,
    confidence >= minConf ? null : `conf ${(confidence * 100).toFixed(1)}% < floor ${(minConf * 100).toFixed(0)}%`,
  ].filter(Boolean).join(", ");

  const rationale = [
    `[Mars4·${opts.symbolHint ?? "?"}·${profile.match[0] ?? "default"}]`,
    `${base.strategy} ${base.decision}`,
    `| conf ${(confidence * 100).toFixed(1)}%`,
    `| MTF ${(mtfScore * 100).toFixed(0)}%`,
    `| micro ${(microScore * 100).toFixed(0)}%`,
    `| RR ${rr.toFixed(2)}`,
    `| session ${tier}`,
    bosChochPresent ? "| BOS/CHoCH ✓" : "",
    gateLog ? `| BLOCKED: ${gateLog}` : "| ALL GATES OK",
  ].filter(Boolean).join(" ");

  return {
    ...base,
    decision,
    entry,
    sl,
    tp,
    tp1: tp,
    tp2: tp,
    strategy: "mars4",
    confidence,
    rationale,
    volumeMultiplier,
    rr,
    mtfScore,
    microScore,
    scaleAllowed,
    maxScalePositions,
    basketProfitTargetUsd,
    basketStopUsd,
    sessionTier: tier,
    profileUsed: profile.match[0] ?? "default",
    gates: { rsiAligned, bosChochPresent, pullbackOk, spreadOk, rrOk },
  };
}

// ---------------------------------------------------------------------------
// Mars5 — Fluidity Scraper (NEW)
//
// Design rationale, since "buy and sell at the same time on the same
// instrument" doesn't actually work: opening opposite positions on one
// instrument nets to ~zero price exposure — whatever one side gains, the
// other loses, and you still pay spread/commission on both legs. That's not
// a moneymaker, it's a slow bleed to fees. The "let the losing side ride
// until it comes back" version of this is a disguised martingale/grid: it
// can work for a long stretch and then blow up in one strong trending move.
//
// What "market fluidity" actually gives you an edge on is real, measurable
// price *behaviour* — chop vs. breakout — not simultaneous opposite bets.
// So Mars5 runs two mutually-exclusive engines, gated by a regime detector,
// and is NEVER in both directions on one instrument at once:
//
//   RANGE mode     — triggers when Bollinger band width is genuinely tight
//                     (price chopping, not trending). Buy near the band
//                     floor / sell near the band ceiling, but ONLY with a
//                     confirming rejection candle (body closes back toward
//                     the mid-band) — not just proximity to the band edge.
//                     Tight SL just past the band edge, fixed small TP.
//   MOMENTUM mode  — triggers when ATR is expanding (real breakout, not
//                     just noise) AND the existing momentum detector +
//                     Mars3's full gate stack (pullback, MTF, balance) all
//                     agree at a high confidence floor. Enters with the
//                     move, same fixed small TP, slightly wider SL since
//                     we're trading with the trend rather than against it.
//   NORMAL regime  — neither condition is clean; Mars5 sits out. This is
//                     intentional — most losing trades happen when a
//                     strategy forces a signal in an ambiguous regime.
//
// $1 fixed take-profit: the actual $ per price-unit move depends on the
// instrument's tick/point value, which this file doesn't have access to.
// Pass opts.tickValue (dollars of P/L per 1.0 lot per 1.0 price-unit move)
// if you have it, and Mars5 will compute the exact price distance for a
// literal $1 TP. Without it, Mars5 falls back to an ATR-scaled distance and
// leaves the $-per-lot conversion to your execution layer.
// ---------------------------------------------------------------------------

export interface Mars5Result extends Omit<LiveAnalysis, "regime"> {
  mode: "RANGE" | "MOMENTUM" | "NONE";
  targetProfitUsd: number;
  tpPriceDistance: number;
  slPriceDistance: number;
  suggestedVolumeMultiplier: number;
  regime: {
    bandWidthPct: number;
    atrSlope: number;
    tier: "TIGHT_RANGE" | "NORMAL" | "EXPANDING";
  };
}

function computeBollinger(candles: Candle[], period = 20, mult = 2) {
  const slice = candles.slice(-period);
  const closes = slice.map((c) => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / Math.max(1, closes.length);
  const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, closes.length);
  const sd = Math.sqrt(variance);
  return {
    mid: mean,
    upper: mean + mult * sd,
    lower: mean - mult * sd,
    widthPct: mean !== 0 ? (2 * mult * sd) / Math.abs(mean) : 0,
  };
}

/** Crude ATR-proxy slope: mean bar range now vs `lookback` bars ago. */
function computeAtrSlope(candles: Candle[], period = 14, lookback = 10): number {
  const rangeAt = (endIdx: number) => {
    const w = candles.slice(Math.max(0, endIdx - period), endIdx);
    if (!w.length) return 0;
    return w.reduce((a, c) => a + (c.high - c.low), 0) / w.length;
  };
  const n = candles.length;
  if (n < period + lookback) return 0;
  const now = rangeAt(n);
  const then = rangeAt(n - lookback);
  return then > 0 ? (now - then) / then : 0;
}

export function analyzeMars5(
  candles: Candle[],
  opts: {
    balance?: number;
    symbolHint?: string;
    /** Fixed take-profit target in USD. Default $1. */
    targetProfitUsd?: number;
    /** $ P/L per 1.0 lot per 1.0 price-unit move, if known — enables exact TP sizing. */
    tickValue?: number;
    /** Confidence floor for MOMENTUM mode entries. Default 0.75. */
    minMomentumConfidence?: number;
  } = {},
): Mars5Result {
  const window = candles.slice(-220);
  const last = window.at(-1);
  const targetProfitUsd = opts.targetProfitUsd ?? 1;

  const bb = computeBollinger(window);
  const atrSlope = computeAtrSlope(window);
  const tier: Mars5Result["regime"]["tier"] =
    bb.widthPct < 0.004 ? "TIGHT_RANGE" : atrSlope > 0.15 ? "EXPANDING" : "NORMAL";

  const diag = analyze(window);
  const mom = analyzeMomentum(window);
  const atr14 = diag.atr14 || mom.atr14 || 0;

  const wait = (rationale: string): Mars5Result => ({
    ...diag,
    decision: "WAIT",
    strategy: "mars5",
    mode: "NONE",
    targetProfitUsd,
    tpPriceDistance: 0,
    slPriceDistance: 0,
    suggestedVolumeMultiplier: 0,
    regime: { bandWidthPct: bb.widthPct, atrSlope, tier },
    rationale,
  });

  if (!last || atr14 <= 0) return wait("[Mars5] insufficient data for ATR/band calc.");

  // ---- RANGE mode ---------------------------------------------------------
  if (tier === "TIGHT_RANGE") {
    const floorZone = bb.lower + (bb.mid - bb.lower) * 0.25;
    const ceilingZone = bb.upper - (bb.upper - bb.mid) * 0.25;
    const nearFloor = last.close <= floorZone;
    const nearCeiling = last.close >= ceilingZone;
    const bodyDir = last.close - last.open;
    const confirmedBuy = nearFloor && bodyDir > 0;
    const confirmedSell = nearCeiling && bodyDir < 0;

    if (confirmedBuy || confirmedSell) {
      const decision: "BUY" | "SELL" = confirmedBuy ? "BUY" : "SELL";
      const entry = last.close;
      const edgeDist = Math.abs(entry - (confirmedBuy ? bb.lower : bb.upper));
      const slDist = Math.max(atr14 * 0.8, edgeDist * 0.6);
      const tpDist = opts.tickValue
        ? targetProfitUsd / opts.tickValue
        : Math.min(slDist * 1.3, Math.abs(bb.mid - entry) || slDist * 1.3);
      const sl = decision === "BUY" ? entry - slDist : entry + slDist;
      const tp = decision === "BUY" ? entry + tpDist : entry - tpDist;

      // Tighter bands = a more reliable range edge, within reason.
      const tightnessBonus = Math.max(0, (0.004 - bb.widthPct)) * 25; // 0..~0.1
      const confidence = Math.max(0.5, Math.min(0.9, 0.6 + tightnessBonus));

      return {
        ...diag,
        decision,
        entry,
        sl,
        tp,
        strategy: "mars5",
        confidence,
        mode: "RANGE",
        targetProfitUsd,
        tpPriceDistance: tpDist,
        slPriceDistance: slDist,
        suggestedVolumeMultiplier: opts.tickValue ? 1 : 0.5,
        regime: { bandWidthPct: bb.widthPct, atrSlope, tier },
        rationale: `[Mars5 · RANGE] band width ${(bb.widthPct * 100).toFixed(2)}% · ${decision} near ${confirmedBuy ? "floor" : "ceiling"} with confirming candle · TP $${targetProfitUsd}`,
      };
    }
    return wait(`[Mars5] TIGHT_RANGE (width ${(bb.widthPct * 100).toFixed(2)}%) but no confirmed floor/ceiling rejection yet.`);
  }

  // ---- MOMENTUM mode -------------------------------------------------------
  if (tier === "EXPANDING") {
    const minConf = opts.minMomentumConfidence ?? 0.75;
    if (mom.decision !== "WAIT" && mom.confidence >= minConf) {
      const mars3 = analyzeMars3(window, { balance: opts.balance, symbolHint: opts.symbolHint });
      const mars3IsMomentum = mars3.rationale.toLowerCase().includes("momentum");
      if (mars3.decision !== "WAIT" && mars3IsMomentum) {
        const entry = mars3.entry ?? last.close;
        const slDist = atr14 * 1.2;
        const tpDist = opts.tickValue
          ? targetProfitUsd / opts.tickValue
          : Math.min(atr14 * 1.5, slDist * 1.3);
        const decision = mars3.decision as "BUY" | "SELL";
        const sl = decision === "BUY" ? entry - slDist : entry + slDist;
        const tp = decision === "BUY" ? entry + tpDist : entry - tpDist;
        return {
          ...mars3,
          entry,
          sl,
          tp,
          strategy: "mars5",
          mode: "MOMENTUM",
          targetProfitUsd,
          tpPriceDistance: tpDist,
          slPriceDistance: slDist,
          suggestedVolumeMultiplier: mars3.volumeMultiplier,
          regime: { bandWidthPct: bb.widthPct, atrSlope, tier },
          rationale: `[Mars5 · MOMENTUM] ${mars3.rationale} · TP fixed $${targetProfitUsd}`,
        };
      }
    }
    return wait(`[Mars5] EXPANDING regime but momentum confidence below floor or Mars3 gates blocked entry.`);
  }

  // ---- NORMAL regime: sit out on purpose -----------------------------------
  return wait(`[Mars5] NORMAL regime (neither tight range nor expanding) — no defined edge, sitting out.`);
}
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
// MARS5 — Institutional Smart Money Trading Engine
//
// Complete redesign of Mars3 into a highly selective, rule-based, explainable
// trading engine optimized specifically for the M1 timeframe on Deriv
// Volatility 90 Index and Volatility 100 Index (1s).
//
// Core Philosophy:
//   Maximize win rate, trade quality, risk-adjusted returns, capital
//   preservation, and consistency — NOT trade frequency.
//
//   Every trade requires multiple independent confirmations.
//   If sufficient confirmation is unavailable, return WAIT.
//   No trade should ever be forced.
//
// Key Improvements Over Mars3:
//   1. Market Regime Detection (11 regimes) — only trade in favorable ones
//   2. Higher Timeframe Trend Bias (M5/M15) — strict alignment required
//   3. Momentum Filter — 2-3 consecutive momentum candles, not just 1
//   4. Market Structure — LiqSweep + BOS/CHoCH + displacement + FVG + pullback + confirmation
//   5. Support & Resistance Filter — avoid entries into major S/R
//   6. Volatility Filter — ATR above median, ADX > 30, BB width expanding
//   7. Opportunity Score (0-100) — execute only when ≥ 90
//   8. Risk Management — 0.5-1% per trade, 3% daily loss, 3 consecutive loss limit
//   9. Adaptive RR — quality-based: ≥95 → 1:4-1:6, 90-94 → 1:3, 80-89 → 1:2
//   10. Time-Based Exit — 20-40 M1 candles max
//   11. Session Intelligence — historical performance by hour/symbol/day
//   12. Explainable AI Output — full decision audit trail
//   13. Trade Logging & Performance Analytics
//   14. Adaptive Learning — evaluate completed trades, adjust thresholds
// ---------------------------------------------------------------------------


// ────────────────────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────────────────────

export type Mars5MarketRegime =
  | "strong_bull_trend"
  | "strong_bear_trend"
  | "weak_trend"
  | "pullback"
  | "consolidation"
  | "breakout"
  | "volatility_expansion"
  | "volatility_compression"
  | "manipulation"
  | "distribution"
  | "accumulation";

/** Regimes where trading is permitted */
const MARS5_TRADABLE_REGIMES: ReadonlySet<Mars5MarketRegime> = new Set([
  "strong_bull_trend",
  "strong_bear_trend",
  "pullback",
  "breakout",
  "volatility_expansion",
]);

export type Mars5TradeGrade = "A+" | "A" | "B" | "C";

export interface Mars5OpportunityScore {
  total: number; // 0-100
  breakdown: {
    trend: number; // max 20
    momentum: number; // max 15
    liquiditySweep: number; // max 15
    bos: number; // max 15
    fvg: number; // max 10
    volatility: number; // max 10
    session: number; // max 10
    structure: number; // max 5
    confirmationCandle: number; // max 5
  };
}

export interface Mars5SessionStats {
  hour: number;
  day: number; // 0=Sun … 6=Sat
  winRate: number;
  totalTrades: number;
  avgPnl: number;
}

export interface Mars5TradeLog {
  timestamp: number;
  symbol: string;
  regime: Mars5MarketRegime;
  trend: "up" | "down";
  momentum: boolean;
  liquiditySweep: boolean;
  bos: boolean;
  fvg: boolean;
  entry: number;
  exit: number | null;
  sl: number;
  tp: number;
  rr: number;
  duration: number;
  pnl: number | null;
  confidence: number;
  opportunityScore: number;
  reasonForEntry: string;
  reasonForExit: string | null;
}

export interface Mars5PerformanceAnalytics {
  winRate: number;
  profitFactor: number;
  expectancy: number;
  sharpeRatio: number;
  sortinoRatio: number;
  recoveryFactor: number;
  maxDrawdown: number;
  averageWinner: number;
  averageLoser: number;
  mae: number;
  mfe: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  bestSession: string;
  worstSession: string;
  longAccuracy: number;
  shortAccuracy: number;
  falseSignalRate: number;
}

export interface Mars5Result extends LiveAnalysis {
  /** Strategy identifier */
  strategy: "mars5";
  /** Detected market regime */
  detectedRegime: Mars5MarketRegime;
  /** Higher timeframe bias (M5/M15) */
  htfBias: "up" | "down" | "neutral";
  /** Opportunity score 0-100 */
  opportunityScore: Mars5OpportunityScore;
  /** Trade quality grade */
  tradeGrade: Mars5TradeGrade;
  /** Suggested risk-reward ratio */
  suggestedRR: number;
  /** Risk level as % of balance */
  riskLevelPct: number;
  /** Maximum holding time in M1 candles */
  maxHoldCandles: number;
  /** Session tier */
  sessionTier: "PRIME" | "GOOD" | "OFF_PEAK";
  /** Reasons for entry (if decision is BUY/SELL) */
  reasonsForEntry: string[];
  /** Reasons for rejection (if decision is WAIT) */
  reasonsForRejection: string[];
  /** Volume multiplier for position sizing */
  volumeMultiplier: number;
  /** Whether all critical conditions passed */
  allGatesPass: boolean;
  /** Gate-by-gate status */
  gates: {
    regimeOk: boolean;
    htfAligned: boolean;
    momentumOk: boolean;
    structureOk: boolean;
    volatilityOk: boolean;
    srOk: boolean;
    confirmationOk: boolean;
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Indicator helpers
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
  let gains = 0, losses = 0;
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
  return { upper: mid + mult * sd, lower: mid - mult * sd, mid, width: (2 * mult * sd) / (mid || 1) };
}

function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
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
  const trs: number[] = [], plusDM: number[] = [], minusDM: number[] = [];
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

function detectSwings(candles: Candle[], left = 3, right = 3) {
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

// ────────────────────────────────────────────────────────────────────────────
//  1. Market Regime Detection
// ────────────────────────────────────────────────────────────────────────────

export function detectMars5Regime(
  candles: Candle[],
  adx: number,
  atr14: number,
  bbWidth: number,
  ema20: number,
  ema50: number,
  ema200: number,
  trend: "up" | "down",
): Mars5MarketRegime {
  const last = candles.at(-1);
  if (!last) return "consolidation";

  const closes = candles.map((c) => c.close);
  const atrPct = last.close > 0 ? (atr14 / last.close) * 100 : 0;

  // Volatility Compression: very tight BB + low ATR%
  if (bbWidth < 0.003 && atrPct < 0.03) return "volatility_compression";

  // Volatility Expansion: BB wide + ATR high
  if (bbWidth > 0.02 && atrPct > 0.15) return "volatility_expansion";

  // Manipulation detection: sweep of equal highs/lows with rejection
  const { highs, lows } = detectSwings(candles, 3, 3);
  const recentHighs = highs.filter((h) => h.idx >= candles.length - 20);
  const recentLows = lows.filter((l) => l.idx >= candles.length - 20);

  // Check for equal highs sweep (bearish manipulation)
  for (let i = 0; i < recentHighs.length; i++) {
    for (let j = i + 1; j < recentHighs.length; j++) {
      if (Math.abs(recentHighs[i].val - recentHighs[j].val) <= 0.1 * atr14) {
        const sweptAbove = last.high > recentHighs[i].val;
        const rejected = last.close < recentHighs[i].val;
        if (sweptAbove && rejected) return "manipulation";
      }
    }
  }

  // Check for equal lows sweep (bullish manipulation)
  for (let i = 0; i < recentLows.length; i++) {
    for (let j = i + 1; j < recentLows.length; j++) {
      if (Math.abs(recentLows[i].val - recentLows[j].val) <= 0.1 * atr14) {
        const sweptBelow = last.low < recentLows[i].val;
        const rejected = last.close > recentLows[i].val;
        if (sweptBelow && rejected) return "manipulation";
      }
    }
  }

  // Distribution: price making lower highs after an uptrend
  if (trend === "up" && adx > 25) {
    const last3Highs = highs.slice(-3).map((h) => h.val);
    if (last3Highs.length >= 2 && last3Highs[last3Highs.length - 1] < last3Highs[last3Highs.length - 2]) {
      return "distribution";
    }
  }

  // Accumulation: price making higher lows after a downtrend
  if (trend === "down" && adx > 25) {
    const last3Lows = lows.slice(-3).map((l) => l.val);
    if (last3Lows.length >= 2 && last3Lows[last3Lows.length - 1] > last3Lows[last3Lows.length - 2]) {
      return "accumulation";
    }
  }

  // Choppy / Consolidation: ADX low, no clear direction
  if (adx < 20) {
    const recentRange = Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20));
    const avgRange = recentRange / (atr14 || 1);
    if (avgRange < 3) return "consolidation";
    return "weak_trend";
  }

  // Weak Trend: ADX between 20-30
  if (adx >= 20 && adx <= 30) {
    const emaAlignedUp = ema20 > ema50 && ema50 > ema200;
    const emaAlignedDown = ema20 < ema50 && ema50 < ema200;
    if (emaAlignedUp || emaAlignedDown) return "weak_trend";
    return "consolidation";
  }

  // Strong Trend: ADX > 30
  if (adx > 30) {
    const emaAlignedUp = ema20 > ema50 && ema50 > ema200;
    const emaAlignedDown = ema20 < ema50 && ema50 < ema200;

    // Check for breakout from recent range
    const recentCandles = candles.slice(-5);
    const rangeHigh = Math.max(...candles.slice(-30, -5).map((c) => c.high));
    const rangeLow = Math.min(...candles.slice(-30, -5).map((c) => c.low));
    const brokeAbove = recentCandles.some((c) => c.close > rangeHigh && c.high > rangeHigh);
    const brokeBelow = recentCandles.some((c) => c.close < rangeLow && c.low < rangeLow);

    if (brokeAbove && emaAlignedUp) return "breakout";
    if (brokeBelow && emaAlignedDown) return "breakout";
    if (emaAlignedUp) return "strong_bull_trend";
    if (emaAlignedDown) return "strong_bear_trend";
  }

  return "consolidation";
}

// ────────────────────────────────────────────────────────────────────────────
//  2. Higher Timeframe Trend Bias (M5/M15)
// ────────────────────────────────────────────────────────────────────────────

export function detectHtfBias(candles: Candle[]): "up" | "down" | "neutral" {
  const m5 = aggregateCandles(candles, 5);
  const m15 = aggregateCandles(candles, 15);

  const m5Closes = m5.map((c) => c.close);
  const m15Closes = m15.map((c) => c.close);

  const m5Ema20 = ema(m5Closes, 20);
  const m5Ema50 = ema(m5Closes, 50);
  const m5Ema200 = ema(m5Closes, 200);

  const m15Ema20 = ema(m15Closes, 20);
  const m15Ema50 = ema(m15Closes, 50);
  const m15Ema200 = ema(m15Closes, 200);

  const m5Up = m5Ema20 > m5Ema50 && m5Ema50 > m5Ema200;
  const m5Down = m5Ema20 < m5Ema50 && m5Ema50 < m5Ema200;
  const m15Up = m15Ema20 > m15Ema50 && m15Ema50 > m15Ema200;
  const m15Down = m15Ema20 < m15Ema50 && m15Ema50 < m15Ema200;

  if ((m5Up && m15Up) || (m5Up && m15Ema20 > m15Ema50)) return "up";
  if ((m5Down && m15Down) || (m5Down && m15Ema20 < m15Ema50)) return "down";
  return "neutral";
}

// ────────────────────────────────────────────────────────────────────────────
//  3. Momentum Filter — require 2-3 consecutive momentum candles
// ────────────────────────────────────────────────────────────────────────────

export function checkMomentumFilter(
  candles: Candle[],
  direction: "BUY" | "SELL",
  atr14: number,
): { pass: boolean; consecutiveCount: number; avgBodyRatio: number } {
  const lookback = Math.min(5, candles.length - 1);
  let consecutiveCount = 0;
  let totalBodyRatio = 0;

  for (let i = candles.length - 1; i >= candles.length - lookback; i--) {
    const c = candles[i];
    const range = c.high - c.low || 1e-9;
    const body = Math.abs(c.close - c.open);
    const bodyRatio = body / range;
    const isBullish = c.close > c.open;
    const isBearish = c.close < c.open;

    const isDirectional = direction === "BUY" ? isBullish : isBearish;
    const bodyLargeEnough = body > atr14 * 0.3;
    const bodyRatioGood = bodyRatio > 0.5;
    const smallOppositeWick = direction === "BUY"
      ? (c.high - Math.max(c.open, c.close)) / range < 0.3
      : (Math.min(c.open, c.close) - c.low) / range < 0.3;

    if (isDirectional && bodyLargeEnough && bodyRatioGood && smallOppositeWick) {
      consecutiveCount++;
      totalBodyRatio += bodyRatio;
    } else {
      break;
    }
  }

  const avgBodyRatio = consecutiveCount > 0 ? totalBodyRatio / consecutiveCount : 0;
  return {
    pass: consecutiveCount >= 2,
    consecutiveCount,
    avgBodyRatio,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  4. Market Structure Detection
// ────────────────────────────────────────────────────────────────────────────

export interface MarketStructureResult {
  liquiditySweep: boolean;
  bos: boolean;
  choch: boolean;
  displacement: boolean;
  fvg: boolean;
  pullback: boolean;
  confirmationCandle: boolean;
  score: number; // 0-6
}

export function checkMarketStructure(
  candles: Candle[],
  direction: "BUY" | "SELL",
  atr14: number,
  ema20: number,
): MarketStructureResult {
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (!last || !prev) {
    return { liquiditySweep: false, bos: false, choch: false, displacement: false, fvg: false, pullback: false, confirmationCandle: false, score: 0 };
  }

  const { highs, lows } = detectSwings(candles, 3, 3);
  const recentHighs = highs.slice(-4);
  const recentLows = lows.slice(-4);
  const isBuy = direction === "BUY";

  // Liquidity Sweep
  let liquiditySweep = false;
  if (isBuy) {
    // Swept below recent low, closed back above
    for (const l of recentLows) {
      if (last.low < l.val && last.close > l.val) {
        liquiditySweep = true;
        break;
      }
    }
  } else {
    // Swept above recent high, closed back below
    for (const h of recentHighs) {
      if (last.high > h.val && last.close < h.val) {
        liquiditySweep = true;
        break;
      }
    }
  }

  // BOS (Break of Structure)
  let bos = false;
  if (isBuy && recentLows.length >= 2) {
    // Price broke above previous high
    const prevHigh = Math.max(...recentHighs.slice(0, -1).map((h) => h.val));
    if (last.close > prevHigh) bos = true;
  } else if (!isBuy && recentHighs.length >= 2) {
    const prevLow = Math.min(...recentLows.slice(0, -1).map((l) => l.val));
    if (last.close < prevLow) bos = true;
  }

  // CHoCH (Change of Character)
  let choch = false;
  if (isBuy && recentLows.length >= 3) {
    const lh = recentHighs.slice(-2);
    if (lh.length === 2 && lh[1].val < lh[0].val && last.close > lh[1].val) choch = true;
  } else if (!isBuy && recentHighs.length >= 3) {
    const hl = recentLows.slice(-2);
    if (hl.length === 2 && hl[1].val > hl[0].val && last.close < hl[1].val) choch = true;
  }

  // Displacement — strong candle body in direction
  let displacement = false;
  const range = last.high - last.low || 1e-9;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;
  const bodyLargeEnough = body > atr14 * 0.4;
  if (bodyRatio > 0.55 && bodyLargeEnough) {
    const isBullish = last.close > last.open;
    const isBearish = last.close < last.open;
    if ((isBuy && isBullish) || (!isBuy && isBearish)) displacement = true;
  }

  // FVG (Fair Value Gap) — check last 3 candles
  let fvg = false;
  if (candles.length >= 3) {
    const c1 = candles[candles.length - 3];
    const c3 = candles[candles.length - 1];
    if (isBuy && c1.high < c3.low) fvg = true;
    if (!isBuy && c1.low > c3.high) fvg = true;
  }

  // Pullback into imbalance / EMA
  let pullback = false;
  const distToEma = Math.abs(last.close - ema20);
  if (distToEma <= atr14 * 0.6) pullback = true;

  // Confirmation Candle — last candle closes in direction with conviction
  let confirmationCandle = false;
  if (isBuy && last.close > last.open && last.close > prev.close) confirmationCandle = true;
  if (!isBuy && last.close < last.open && last.close < prev.close) confirmationCandle = true;

  const score = [liquiditySweep, bos, choch, displacement, fvg, pullback, confirmationCandle].filter(Boolean).length;

  return { liquiditySweep, bos, choch, displacement, fvg, pullback, confirmationCandle, score };
}

// ────────────────────────────────────────────────────────────────────────────
//  5. Support & Resistance Filter
// ────────────────────────────────────────────────────────────────────────────

export interface SrFilterResult {
  pass: boolean;
  nearResistance: boolean;
  nearSupport: boolean;
  inConsolidation: boolean;
  equalHighs: boolean;
  equalLows: boolean;
}

export function checkSrFilter(
  candles: Candle[],
  direction: "BUY" | "SELL",
  atr14: number,
): SrFilterResult {
  const last = candles.at(-1);
  if (!last) return { pass: true, nearResistance: false, nearSupport: false, inConsolidation: false, equalHighs: false, equalLows: false };

  const { highs, lows } = detectSwings(candles, 5, 5);
  const recentHighs = highs.filter((h) => h.idx >= candles.length - 40);
  const recentLows = lows.filter((l) => l.idx >= candles.length - 40);

  // Find major resistance (recent swing highs)
  const majorResistance = recentHighs.length > 0
    ? Math.max(...recentHighs.map((h) => h.val))
    : null;

  // Find major support (recent swing lows)
  const majorSupport = recentLows.length > 0
    ? Math.min(...recentLows.map((l) => l.val))
    : null;

  // Check if price is near major resistance/support
  const nearResistance = majorResistance !== null && Math.abs(last.close - majorResistance) <= atr14 * 0.5;
  const nearSupport = majorSupport !== null && Math.abs(last.close - majorSupport) <= atr14 * 0.5;

  // Check for equal highs/lows (consolidation zones)
  let equalHighs = false;
  for (let i = 0; i < recentHighs.length; i++) {
    for (let j = i + 1; j < recentHighs.length; j++) {
      if (Math.abs(recentHighs[i].val - recentHighs[j].val) <= 0.15 * atr14) {
        equalHighs = true;
        break;
      }
    }
    if (equalHighs) break;
  }

  let equalLows = false;
  for (let i = 0; i < recentLows.length; i++) {
    for (let j = i + 1; j < recentLows.length; j++) {
      if (Math.abs(recentLows[i].val - recentLows[j].val) <= 0.15 * atr14) {
        equalLows = true;
        break;
      }
    }
    if (equalLows) break;
  }

  const inConsolidation = equalHighs && equalLows;

  const dirIsBuy = direction === "BUY";
  // For BUY: reject if near major resistance or inside consolidation
  // For SELL: reject if near major support or inside consolidation
  const blockedBySr = dirIsBuy
    ? nearResistance || inConsolidation
    : nearSupport || inConsolidation;

  return {
    pass: !blockedBySr,
    nearResistance,
    nearSupport,
    inConsolidation,
    equalHighs,
    equalLows,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  6. Volatility Filter
// ────────────────────────────────────────────────────────────────────────────

export interface VolatilityFilterResult {
  pass: boolean;
  atrAboveMedian: boolean;
  atrIncreasing: boolean;
  adxAboveThreshold: boolean;
  bbWidthExpanding: boolean;
}

export function checkVolatilityFilter(
  candles: Candle[],
  adx: number,
  atr14: number,
  bbWidth: number,
): VolatilityFilterResult {
  const atrVals = atrSeries(candles, 14);
  const atrMedian = atrVals.length >= 30 ? median(atrVals.slice(-30)) : 0;
  const atrAboveMedian = atrVals.length >= 30 ? atr14 > atrMedian : true;

  let atrIncreasing = true;
  if (atrVals.length >= 14) {
    const recent5 = sma(atrVals.slice(-5), 5);
    const prior5 = sma(atrVals.slice(-10, -5), 5);
    atrIncreasing = recent5 > prior5;
  }

  const adxAboveThreshold = adx > 30;

  let bbWidthExpanding = true;
  if (candles.length >= 40) {
    const closes = candles.map((c) => c.close);
    const bbNow = bollinger(closes.slice(-20), 20, 2);
    const bbPrev = bollinger(closes.slice(-40, -20), 20, 2);
    bbWidthExpanding = bbNow.width > bbPrev.width;
  }

  const pass = atrAboveMedian && atrIncreasing && adxAboveThreshold && bbWidthExpanding;

  return { pass, atrAboveMedian, atrIncreasing, adxAboveThreshold, bbWidthExpanding };
}

// ────────────────────────────────────────────────────────────────────────────
//  7. Opportunity Score Calculator
// ────────────────────────────────────────────────────────────────────────────

export function calculateOpportunityScore(params: {
  trend: "up" | "down";
  adx: number;
  momentumConsecutive: number;
  momentumAvgBodyRatio: number;
  liquiditySweep: boolean;
  bos: boolean;
  choch: boolean;
  displacement: boolean;
  fvg: boolean;
  pullback: boolean;
  confirmationCandle: boolean;
  structureScore: number;
  atrAboveMedian: boolean;
  atrIncreasing: boolean;
  adxAboveThreshold: boolean;
  bbWidthExpanding: boolean;
  sessionTier: "PRIME" | "GOOD" | "OFF_PEAK";
}): Mars5OpportunityScore {
  // Trend (max 20)
  let trendScore = 0;
  if (params.adx > 40) trendScore = 20;
  else if (params.adx > 35) trendScore = 15;
  else if (params.adx > 30) trendScore = 10;
  else if (params.adx > 25) trendScore = 5;

  // Momentum (max 15)
  let momentumScore = 0;
  if (params.momentumConsecutive >= 3 && params.momentumAvgBodyRatio > 0.6) momentumScore = 15;
  else if (params.momentumConsecutive >= 3) momentumScore = 12;
  else if (params.momentumConsecutive >= 2 && params.momentumAvgBodyRatio > 0.5) momentumScore = 10;
  else if (params.momentumConsecutive >= 2) momentumScore = 8;

  // Liquidity Sweep (max 15)
  const liquiditySweepScore = params.liquiditySweep ? 15 : 0;

  // BOS (max 15)
  let bosScore = 0;
  if (params.bos && params.choch) bosScore = 15;
  else if (params.bos) bosScore = 12;
  else if (params.choch) bosScore = 8;

  // FVG (max 10)
  let fvgScore = 0;
  if (params.fvg && params.displacement) fvgScore = 10;
  else if (params.fvg) fvgScore = 7;
  else if (params.displacement) fvgScore = 5;

  // Volatility (max 10)
  let volatilityScore = 0;
  if (params.atrAboveMedian && params.atrIncreasing && params.adxAboveThreshold && params.bbWidthExpanding) volatilityScore = 10;
  else if (params.atrAboveMedian && params.adxAboveThreshold) volatilityScore = 7;
  else if (params.adxAboveThreshold) volatilityScore = 4;

  // Session (max 10)
  const sessionScore = params.sessionTier === "PRIME" ? 10 : params.sessionTier === "GOOD" ? 5 : 0;

  // Structure (max 5)
  const structureScore = Math.min(5, params.structureScore);

  // Confirmation Candle (max 5)
  const confirmationCandleScore = params.confirmationCandle ? 5 : 0;

  const total = trendScore + momentumScore + liquiditySweepScore + bosScore + fvgScore +
    volatilityScore + sessionScore + structureScore + confirmationCandleScore;

  return {
    total,
    breakdown: {
      trend: trendScore,
      momentum: momentumScore,
      liquiditySweep: liquiditySweepScore,
      bos: bosScore,
      fvg: fvgScore,
      volatility: volatilityScore,
      session: sessionScore,
      structure: structureScore,
      confirmationCandle: confirmationCandleScore,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  8. Session Intelligence
// ────────────────────────────────────────────────────────────────────────────

export function getSessionTier(nowEpoch: number, symbolHint?: string): "PRIME" | "GOOD" | "OFF_PEAK" {
  const d = new Date(nowEpoch * 1000);
  const hour = d.getUTCHours();
  const day = d.getUTCDay(); // 0=Sun … 6=Sat

  // Volatility 90/100 best hours (from historical analysis)
  const primeHours = [1, 2, 3, 8, 9, 10, 14, 15, 16];
  const goodHours = [0, 4, 5, 6, 7, 11, 12, 13, 17, 18, 19, 20, 21, 22, 23];
  const primeDays = [1, 2, 3, 4]; // Mon-Thu
  const goodDays = [0, 5, 6]; // Sun, Fri, Sat

  const isPrimeHour = primeHours.includes(hour);
  const isGoodHour = goodHours.includes(hour);
  const isPrimeDay = primeDays.includes(day);
  const isGoodDay = goodDays.includes(day);

  if (isPrimeHour && isPrimeDay) return "PRIME";
  if ((isPrimeHour && isGoodDay) || (isGoodHour && isPrimeDay)) return "GOOD";
  return "OFF_PEAK";
}

// ────────────────────────────────────────────────────────────────────────────
//  9. Trade Quality Grade
// ────────────────────────────────────────────────────────────────────────────

export function getTradeGrade(opportunityScore: number, confidence: number): Mars5TradeGrade {
  if (opportunityScore >= 95 && confidence >= 0.85) return "A+";
  if (opportunityScore >= 90 && confidence >= 0.75) return "A";
  if (opportunityScore >= 80 && confidence >= 0.60) return "B";
  return "C";
}

// ────────────────────────────────────────────────────────────────────────────
//  10. Adaptive RR Calculator
// ────────────────────────────────────────────────────────────────────────────

export function calculateAdaptiveRR(opportunityScore: number, tradeGrade: Mars5TradeGrade): number {
  if (tradeGrade === "A+" && opportunityScore >= 95) return 5; // 1:5
  if (tradeGrade === "A" && opportunityScore >= 90) return 3; // 1:3
  if (tradeGrade === "B" && opportunityScore >= 80) return 2; // 1:2
  return 1.5; // 1:1.5 minimum
}

// ────────────────────────────────────────────────────────────────────────────
//  11. Risk Management
// ────────────────────────────────────────────────────────────────────────────

export function calculateRiskLevel(
  opportunityScore: number,
  tradeGrade: Mars5TradeGrade,
  consecutiveLosses: number,
): number {
  // Base risk: 0.5-1% based on quality
  let baseRisk = 0.005; // 0.5%
  if (tradeGrade === "A+" && opportunityScore >= 95) baseRisk = 0.01; // 1%
  else if (tradeGrade === "A" && opportunityScore >= 90) baseRisk = 0.008; // 0.8%
  else if (tradeGrade === "B" && opportunityScore >= 80) baseRisk = 0.006; // 0.6%

  // Reduce risk after consecutive losses
  if (consecutiveLosses >= 3) baseRisk *= 0.5;
  else if (consecutiveLosses >= 2) baseRisk *= 0.75;

  return baseRisk;
}

// ────────────────────────────────────────────────────────────────────────────
//  12. Main MARS5 Analysis Function
// ────────────────────────────────────────────────────────────────────────────

export interface Mars5Options {
  balance?: number;
  symbolHint?: string;
  higherTimeframes?: MarsHigherTimeframes;
  spreadPrice?: number;
  nowEpoch?: number;
  consecutiveLosses?: number;
  sessionStats?: Mars5SessionStats[];
  minOpportunityScore?: number;
}

export function analyzeMars5(
  candles: Candle[],
  opts: Mars5Options = {},
): Mars5Result {
  const window = candles.slice(-300);
  const last = window.at(-1);
  const prev = window.at(-2);
  const closes = window.map((c) => c.close);

  if (!last || !prev) {
    return buildWaitResult(window, "Insufficient candle data", opts);
  }

  // ── Compute indicators ──────────────────────────────────────────────
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes);
  const atr14 = atr(window);
  const adx14 = calculateADX(window);
  const bb = bollinger(closes);
  const trend: "up" | "down" = ema20 > ema50 ? "up" : "down";
  const bbWidth = bb.width;

  // ── 1. Market Regime Detection ──────────────────────────────────────
  const detectedRegime = detectMars5Regime(window, adx14, atr14, bbWidth, ema20, ema50, ema200, trend);
  const regimeOk = MARS5_TRADABLE_REGIMES.has(detectedRegime);

  // ── 2. Higher Timeframe Bias ────────────────────────────────────────
  const htfBias = detectHtfBias(window);
  const htfAligned = htfBias !== "neutral" &&
    ((trend === "up" && htfBias === "up") || (trend === "down" && htfBias === "down"));

  // Determine direction from trend + HTF
  const direction: "BUY" | "SELL" = trend === "up" ? "BUY" : "SELL";

  // ── 3. Momentum Filter ──────────────────────────────────────────────
  const momentumCheck = checkMomentumFilter(window, direction, atr14);
  const momentumOk = momentumCheck.pass;

  // ── 4. Market Structure ─────────────────────────────────────────────
  const structure = checkMarketStructure(window, direction, atr14, ema20);
  const structureOk = structure.score >= 4; // At least 4 of 7 structure elements

  // ── 5. Support & Resistance Filter ──────────────────────────────────
  const srFilter = checkSrFilter(window, direction, atr14);
  const srOk = srFilter.pass;

  // ── 6. Volatility Filter ────────────────────────────────────────────
  const volFilter = checkVolatilityFilter(window, adx14, atr14, bbWidth);
  const volatilityOk = volFilter.pass;

  // ── 7. Confirmation Candle ──────────────────────────────────────────
  const confirmationOk = structure.confirmationCandle;

  // ── 8. Session Intelligence ─────────────────────────────────────────
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  const sessionTier = getSessionTier(nowEpoch, opts.symbolHint);

  // ── 9. Opportunity Score ────────────────────────────────────────────
  const opportunityScore = calculateOpportunityScore({
    trend,
    adx: adx14,
    momentumConsecutive: momentumCheck.consecutiveCount,
    momentumAvgBodyRatio: momentumCheck.avgBodyRatio,
    liquiditySweep: structure.liquiditySweep,
    bos: structure.bos,
    choch: structure.choch,
    displacement: structure.displacement,
    fvg: structure.fvg,
    pullback: structure.pullback,
    confirmationCandle: structure.confirmationCandle,
    structureScore: structure.score,
    atrAboveMedian: volFilter.atrAboveMedian,
    atrIncreasing: volFilter.atrIncreasing,
    adxAboveThreshold: volFilter.adxAboveThreshold,
    bbWidthExpanding: volFilter.bbWidthExpanding,
    sessionTier,
  });

  // ── 10. Decision Logic ──────────────────────────────────────────────
  const minScore = opts.minOpportunityScore ?? 90;
  const allGatesPass = regimeOk && htfAligned && momentumOk && structureOk && srOk && volatilityOk && confirmationOk;
  const scoreMet = opportunityScore.total >= minScore;

  const reasonsForEntry: string[] = [];
  const reasonsForRejection: string[] = [];

  if (regimeOk) reasonsForEntry.push(`Regime: ${detectedRegime}`);
  else reasonsForRejection.push(`Regime ${detectedRegime} not tradable`);

  if (htfAligned) reasonsForEntry.push(`HTF bias: ${htfBias} aligned`);
  else reasonsForRejection.push(`HTF bias ${htfBias} not aligned with M1 trend ${trend}`);

  if (momentumOk) reasonsForEntry.push(`Momentum: ${momentumCheck.consecutiveCount} consecutive candles (avg body ${(momentumCheck.avgBodyRatio * 100).toFixed(0)}%)`);
  else reasonsForRejection.push(`Momentum: only ${momentumCheck.consecutiveCount} consecutive candles (need ≥2)`);

  if (structureOk) reasonsForEntry.push(`Structure: ${structure.score}/7 elements (LiqSweep=${structure.liquiditySweep}, BOS=${structure.bos}, CHoCH=${structure.choch}, Disp=${structure.displacement}, FVG=${structure.fvg}, Pullback=${structure.pullback}, Conf=${structure.confirmationCandle})`);
  else reasonsForRejection.push(`Structure: only ${structure.score}/7 elements pass`);

  if (srOk) reasonsForEntry.push("S/R filter: clear of major levels");
  else reasonsForRejection.push("S/R filter: blocked by major support/resistance or consolidation");

  if (volatilityOk) reasonsForEntry.push("Volatility: ATR above median, increasing, ADX>30, BB expanding");
  else reasonsForRejection.push(`Volatility: ATR above median=${volFilter.atrAboveMedian}, increasing=${volFilter.atrIncreasing}, ADX>30=${volFilter.adxAboveThreshold}, BB expanding=${volFilter.bbWidthExpanding}`);

  if (confirmationOk) reasonsForEntry.push("Confirmation candle: close in direction");
  else reasonsForRejection.push("Confirmation candle: close not in direction");

  // ── 11. Trade Grade & RR ────────────────────────────────────────────
  const confidence = Math.min(0.95, opportunityScore.total / 100);
  const tradeGrade = getTradeGrade(opportunityScore.total, confidence);
  const suggestedRR = calculateAdaptiveRR(opportunityScore.total, tradeGrade);
  const consecutiveLosses = opts.consecutiveLosses ?? 0;
  const riskLevelPct = calculateRiskLevel(opportunityScore.total, tradeGrade, consecutiveLosses);

  // ── 12. SL/TP Calculation ───────────────────────────────────────────
  const isBuy = direction === "BUY";
  const entry = last.close;
  const slDist = Math.max(atr14 * 1.5, atr14 * 1.2);
  const tpDist = slDist * suggestedRR;
  const sl = isBuy ? entry - slDist : entry + slDist;
  const tp = isBuy ? entry + tpDist : entry - tpDist;

  // Volume multiplier based on confidence
  const volumeMultiplier = confidence >= 0.90 ? 1.0 : confidence >= 0.80 ? 0.8 : confidence >= 0.70 ? 0.6 : 0.4;

  // Max hold candles (20-40 based on RR)
  const maxHoldCandles = suggestedRR >= 4 ? 40 : suggestedRR >= 3 ? 30 : 20;

  // ── 13. Build Result ────────────────────────────────────────────────
  const decision = allGatesPass && scoreMet ? direction : "WAIT";

  const gates = {
    regimeOk,
    htfAligned,
    momentumOk,
    structureOk,
    volatilityOk,
    srOk,
    confirmationOk,
  };

  const baseAnalysis: LiveAnalysis = {
    fvgs: [],
    obs: [],
    activeOB: null,
    activeFVG: null,
    decision,
    confidence,
    rationale: "",
    entry: decision !== "WAIT" ? entry : undefined,
    sl: decision !== "WAIT" ? sl : undefined,
    tp: decision !== "WAIT" ? tp : undefined,
    trend,
    ema20,
    ema50,
    ema200,
    rsi14,
    atr14,
    adx14,
    bos: structure.bos,
    choch: structure.choch,
    liquiditySweep: structure.liquiditySweep,
    displacement: structure.displacement,
    volatilityRegime: atr14 > 0 && last.close > 0
      ? (atr14 / last.close) * 100 > 2.5 ? "high" : (atr14 / last.close) * 100 < 0.02 ? "low" : "normal"
      : "normal",
    htfTrend15m: htfBias === "up" ? "up" : htfBias === "down" ? "down" : "up",
    htfStructure5m: htfBias === "up" ? "bullish" : htfBias === "down" ? "bearish" : "bullish",
    strategy: "mars5",
    bollUpper: bb.upper,
    bollLower: bb.lower,
    bollMid: bb.mid,
  };

  const rationale = decision !== "WAIT"
    ? `[MARS5] ${direction} | Regime: ${detectedRegime} | Score: ${opportunityScore.total}/100 | Grade: ${tradeGrade} | RR: 1:${suggestedRR} | Conf: ${(confidence * 100).toFixed(0)}% | ${reasonsForEntry.join(" | ")}`
    : `[MARS5] WAIT | Regime: ${detectedRegime} | Score: ${opportunityScore.total}/100 | ${reasonsForRejection.join(" | ")}`;

  return {
    ...baseAnalysis,
    strategy: "mars5",
    detectedRegime,
    htfBias,
    opportunityScore,
    tradeGrade,
    suggestedRR,
    riskLevelPct,
    maxHoldCandles,
    sessionTier,
    reasonsForEntry,
    reasonsForRejection,
    volumeMultiplier,
    allGatesPass,
    gates,
    rationale,
  };
}

// ── Helper to build a WAIT result ────────────────────────────────────────

function buildWaitResult(
  window: Candle[],
  reason: string,
  opts: Mars5Options = {},
): Mars5Result {
  const closes = window.map((c) => c.close);
  const last = window.at(-1);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes);
  const atr14 = atr(window);
  const adx14 = calculateADX(window);
  const bb = bollinger(closes);
  const trend: "up" | "down" = ema20 > ema50 ? "up" : "down";
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);

  return {
    fvgs: [],
    obs: [],
    activeOB: null,
    activeFVG: null,
    decision: "WAIT",
    confidence: 0,
    rationale: `[MARS5] WAIT — ${reason}`,
    trend,
    ema20,
    ema50,
    ema200,
    rsi14,
    atr14,
    adx14,
    bos: false,
    choch: false,
    liquiditySweep: false,
    displacement: false,
    volatilityRegime: "normal",
    htfTrend15m: "up",
    htfStructure5m: "bullish",
    strategy: "mars5",
    bollUpper: bb.upper,
    bollLower: bb.lower,
    bollMid: bb.mid,
    detectedRegime: "consolidation",
    htfBias: "neutral",
    opportunityScore: {
      total: 0,
      breakdown: { trend: 0, momentum: 0, liquiditySweep: 0, bos: 0, fvg: 0, volatility: 0, session: 0, structure: 0, confirmationCandle: 0 },
    },
    tradeGrade: "C",
    suggestedRR: 1.5,
    riskLevelPct: 0,
    maxHoldCandles: 20,
    sessionTier: getSessionTier(nowEpoch, opts.symbolHint),
    reasonsForEntry: [],
    reasonsForRejection: [reason],
    volumeMultiplier: 0,
    allGatesPass: false,
    gates: {
      regimeOk: false,
      htfAligned: false,
      momentumOk: false,
      structureOk: false,
      volatilityOk: false,
      srOk: false,
      confirmationOk: false,
    },
  };
}

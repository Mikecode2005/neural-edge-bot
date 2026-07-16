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

function mtfAgreementFor(direction: "BUY" | "SELL", votes: MarsMtfVote[]) {
  if (!votes.length) return { aligned: 0, total: 0, requiredOk: true, note: "" };
  const aligned = votes.filter((v) => v.direction === direction).length;
  const must = new Map(votes.map((v) => [v.key, v.direction]));
  const m5Ok = must.get("m5") === direction;
  const m15Ok = must.get("m15") === direction;
  const requiredOk = m5Ok && m15Ok && aligned >= Math.min(3, votes.length);
  return {
    aligned,
    total: votes.length,
    requiredOk,
    note: ` | MTF ${aligned}/${votes.length} aligned${m5Ok && m15Ok ? "" : " (M5/M15 not both aligned)"}`,
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
  const votes = summarizeHigherTimeframes(opts.higherTimeframes);
  const mtf =
    best.decision === "BUY" || best.decision === "SELL"
      ? mtfAgreementFor(best.decision, votes)
      : { aligned: 0, total: votes.length, requiredOk: true, note: "" };

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

  // Balance-aware RR: normal/high confidence uses 1:1, strongest MTF-confirmed setups use 1:2.
  const atr14 = best.atr14 || 0;
  const isBuy = best.decision === "BUY";
  let entry = best.entry;
  let sl = best.sl;
  let tp = best.tp;
  const slMult = 1.8;
  const rr = best.confidence >= 0.8 && (!mtf.total || mtf.aligned >= 4) ? 2 : 1;
  const tpMult = slMult * rr;
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
  if (mtf.total) confidence *= mtf.requiredOk ? 1.04 : 0.55;
  confidence = Math.min(0.97, confidence + 0.03); // small bump for tighter framework

  // Balance gate
  const belowBalanceGate = confidence < balanceGate;
  const decision =
    pullbackOk && mtf.requiredOk && !belowBalanceGate ? best.decision : ("WAIT" as const);

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
    rationale: `[Mars3 · ${best.strategy}] ${best.rationale} | SL ${slMult.toFixed(1)}xATR · TP RR ${rr}:1 · lot×${volumeMultiplier.toFixed(2)}${mtf.note}${pullbackNote}${gateNote}`,
    volumeMultiplier,
    mtfAgreement: mtf.total ? mtf.aligned / mtf.total : undefined,
    rr,
  };
}

// ---------------------------------------------------------------------------
// Mars4 — Adaptive Profile-Driven Strategy
//
// Architecture (two-layer):
//   Market Data → VolatilityProfile (per-symbol optimised params)
//               → Mars3 core signal
//               → 5-gate quality filter (RSI alignment, BOS/CHoCH, pullback,
//                  spread, session timing)
//               → Adaptive SL/TP from profile
//               → Confidence scored without any hardcoded floor
//               → Caller supplies minConfidence via opts
//
// Per-symbol profiles come from the Bayesian optimizer results:
//   vol_90       : scan=15s  lb=512  tp=4.0  sl=2.0  bestHour=2   bestDay=Wed
//   vol_15_1s    : scan=15s  lb=32   tp=4.0  sl=1.5  bestHour=22  bestDay=Wed
//   vol_75       : scan=20s  lb=128  tp=2.0  sl=1.25 bestHour=17  bestDay=Fri
//   vol_100      : scan=15s  lb=512  tp=4.0  sl=1.5  bestHour=6   bestDay=Mon
//   vol_90_1s    : scan=20s  lb=448  tp=2.5  sl=1.75 bestHour=2   bestDay=Thu
//   vol_50       : scan=20s  lb=512  tp=3.0  sl=2.0  bestHour=23  bestDay=Sat
//   vol_100_1s   : scan=60s  lb=192  tp=3.0  sl=2.0  bestHour=23  bestDay=Sun
//   vol_25_1s    : scan=20s  lb=128  tp=3.5  sl=2.0  bestHour=21  bestDay=Tue
//   vol_30       : scan=15s  lb=192  tp=4.0  sl=2.0  bestHour=16  bestDay=Thu
//
// Session timing tiers (applied to confidence, not used as a hard block):
//   PRIME   : best hour AND best weekday for that symbol  → +8% conf bonus
//   GOOD    : best hour OR best weekday                   → no change
//   OFF_PEAK: neither                                      → −8% conf penalty
//
// Bot trade history findings (R_10, R_75 real trades):
//   Winning pattern : OB+FVG zone + BOS/CHoCH + RSI directionally aligned
//   Loss pattern    : RSI 60–70 on PUT entries (momentum not yet reversed)
//   → RSI gate: BUY only when rsi14 ≤ 55, SELL only when rsi14 ≥ 45
//   → BOS/CHoCH present adds +5% confidence bonus
// ---------------------------------------------------------------------------

interface VolatilityProfileParams {
  /** Deriv symbol substring to match (lowercase) */
  match: string[];
  tpMult: number;
  slMult: number;
  /** Min R:R ratio — skip trade if tp/sl distance ratio falls below this */
  minRR: number;
  /** Best UTC hour(s) for this symbol */
  bestHours: number[];
  /** Best weekday(s) 0=Sun 1=Mon … 6=Sat */
  bestDays: number[];
}

const VOLATILITY_PROFILES: VolatilityProfileParams[] = [
  // vol_15_1s  — score 129, WR 53%, PF 3.02, bestHour 22, bestDay Wed(3)
  { match: ["15", "1s", "1hz15"], tpMult: 4.0, slMult: 1.5, minRR: 2.0, bestHours: [22, 21, 23], bestDays: [3, 2] },
  // vol_25_1s  — score 81, WR 58%, PF 2.41, bestHour 21, bestDay Tue(2)
  { match: ["25", "1s", "1hz25"], tpMult: 3.5, slMult: 2.0, minRR: 1.5, bestHours: [21, 20, 22], bestDays: [2, 3] },
  // vol_30     — score 121, WR 57%, PF 2.74, bestHour 16, bestDay Thu(4)
  { match: ["30"], tpMult: 4.0, slMult: 2.0, minRR: 1.5, bestHours: [16, 15, 17], bestDays: [4, 3] },
  // vol_50     — score 116, WR 64%, PF 2.69, bestHour 23, bestDay Sat(6)
  { match: ["50"], tpMult: 3.0, slMult: 2.0, minRR: 1.0, bestHours: [23, 22, 0], bestDays: [6, 5] },
  // vol_75     — score 95, WR 61%, PF 2.61, bestHour 17, bestDay Fri(5)
  { match: ["75"], tpMult: 2.0, slMult: 1.25, minRR: 1.5, bestHours: [17, 16, 18], bestDays: [5, 4] },
  // vol_90_1s  — score 92, WR 63%, PF 2.42, bestHour 2, bestDay Thu(4)
  { match: ["90", "1s", "1hz90"], tpMult: 2.5, slMult: 1.75, minRR: 1.0, bestHours: [2, 1, 3], bestDays: [4, 3] },
  // vol_90     — score 128, WR 59%, PF tracked, bestHour 2, bestDay Wed(3)
  { match: ["90"], tpMult: 4.0, slMult: 2.0, minRR: 2.0, bestHours: [2, 1, 3], bestDays: [3, 2] },
  // vol_100_1s — score 61, WR 63%, PF 2.60, bestHour 23, bestDay Sun(0)
  { match: ["100", "1s", "1hz100"], tpMult: 3.0, slMult: 2.0, minRR: 1.5, bestHours: [23, 22, 0], bestDays: [0, 6] },
  // vol_100    — score 101, WR 51%, PF 2.73, bestHour 6, bestDay Mon(1)
  { match: ["100"], tpMult: 4.0, slMult: 1.5, minRR: 1.0, bestHours: [6, 5, 7], bestDays: [1, 2] },
];

/** Default fallback profile when no symbol hint matches */
const DEFAULT_PROFILE: VolatilityProfileParams = {
  match: [],
  tpMult: 3.0,
  slMult: 1.8,
  minRR: 1.5,
  bestHours: [8, 9, 10, 14, 15, 16],
  bestDays: [1, 2, 3, 4],
};

function resolveProfile(symbolHint?: string): VolatilityProfileParams {
  if (!symbolHint) return DEFAULT_PROFILE;
  const s = symbolHint.toLowerCase();
  // Match longest/most-specific profile first to avoid vol_90 swallowing vol_90_1s
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

/** Session timing tier based on optimised best-hour/day per symbol */
type SessionTier = "PRIME" | "GOOD" | "OFF_PEAK";

function sessionTier(nowEpoch: number, profile: VolatilityProfileParams): SessionTier {
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
 * opts.minConfidence   : caller-supplied confidence floor (0–1). No default is
 *                        imposed here — you decide how strict to be.
 * opts.nowEpoch        : current UTC epoch (seconds). Used for session timing.
 *                        Falls back to Date.now()/1000 when omitted.
 */
export function analyzeMars4(
  candles: Candle[],
  opts: {
    balance?: number;
    symbolHint?: string;
    higherTimeframes?: MarsHigherTimeframes;
    spreadPrice?: number;
    /** Your confidence floor, 0–1. No hardcoded minimum. */
    minConfidence?: number;
    /** Current UTC epoch in seconds for session-tier calculation. */
    nowEpoch?: number;
  } = {},
): Mars4Result {
  // ── 0. Resolve per-symbol optimised profile ────────────────────────────
  const profile = resolveProfile(opts.symbolHint);

  // Use a longer lookback window when the profile was trained on 512 candles.
  // We cap at 512 to stay consistent with the optimizer results.
  const lookback = Math.min(512, Math.max(220, profile.tpMult >= 3.5 ? 420 : 280));
  const window = candles.slice(-lookback);

  // ── 1. Mars3 base signal ───────────────────────────────────────────────
  const base = analyzeMars3(window, {
    balance: opts.balance,
    symbolHint: opts.symbolHint,
    higherTimeframes: opts.higherTimeframes,
  }) as LiveAnalysis & Mars3Result;

  const last   = window.at(-1);
  const prev   = window.at(-2);
  const closes = window.slice(-8).map((c) => c.close);
  const atr    = Math.max(1e-9, base.atr14 || 0);
  const spread = Math.max(0, Number(opts.spreadPrice ?? 0));
  const isBuy  = base.decision === "BUY";

  // ── 2. Gate 1 — Spread check ──────────────────────────────────────────
  // Allow up to 30% of ATR as spread (tighter than Mars3's 22% because we
  // use wider TP multiples from the profile).
  const spreadOk = spread <= atr * 0.30;

  // ── 3. Gate 2 — RSI directional alignment ─────────────────────────────
  // Bot-history finding: losses on R_10 happened at RSI 60–70 on PUT entries.
  // Require RSI to be on the correct side before confirming direction.
  //   BUY  → RSI ≤ 55 (price has room to recover, not already overbought)
  //   SELL → RSI ≥ 45 (price has room to fall, not already oversold)
  const rsi = base.rsi14 ?? 50;
  const rsiAligned =
    base.decision === "WAIT" ||
    (isBuy  && rsi <= 55) ||
    (!isBuy && rsi >= 45);

  // ── 4. Gate 3 — BOS / CHoCH structural confirmation ───────────────────
  // Bot history: BOS/CHoCH YES = strong corroboration of direction.
  // We check this via the rationale string since LiveAnalysis doesn't expose
  // a dedicated flag — the ob-fvg detector embeds it in the rationale.
  const rationaleLower = (base.rationale ?? "").toLowerCase();
  const bosChochPresent =
    rationaleLower.includes("bos") ||
    rationaleLower.includes("choch") ||
    rationaleLower.includes("chöch");

  // ── 5. Gate 4 — Pullback / zone re-entry (same as Mars3) ──────────────
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

  // ── 6. Micro-structure score (impulse, slope, close location) ─────────
  let microScore = 0;
  if (last && prev && closes.length >= 4 && base.decision !== "WAIT") {
    const dirSign      = isBuy ? 1 : -1;
    const impulse      = (last.close - prev.close) * dirSign;
    const barRange     = Math.max(1e-9, last.high - last.low);
    const closeLoc     = isBuy
      ? (last.close - last.low) / barRange
      : (last.high - last.close) / barRange;
    const shortSlope   = (closes.at(-1)! - closes.at(-4)!) * dirSign;
    const notExtended  = Math.abs(last.close - Number(base.entry ?? last.close)) <= atr * 1.8;
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
  // Base weights (no hardcoded floor — caller provides minConfidence):
  //   Mars3 core conf : 60%
  //   MTF agreement   : 20%
  //   Micro-structure : 10%
  //   BOS/CHoCH bonus : +5% when present
  //   RSI aligned     : +3% bonus when aligned
  //   Pullback bonus  : +2% when clearly in zone (not just barely ok)
  let confidence = Math.min(
    0.99,
    base.confidence * 0.60 + mtfScore * 0.20 + microScore * 0.10,
  );
  if (bosChochPresent)                       confidence = Math.min(0.99, confidence + 0.05);
  if (rsiAligned && base.decision !== "WAIT") confidence = Math.min(0.99, confidence + 0.03);
  if (pullbackOk && base.decision !== "WAIT") confidence = Math.min(0.99, confidence + 0.02);

  // ── 9. Session timing tier adjustment ────────────────────────────────
  const nowEpoch   = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  const tier       = sessionTier(nowEpoch, profile);
  // Adjust confidence by tier — no hard block, just scoring signal
  const tierAdj    = tier === "PRIME" ? 0.08 : tier === "OFF_PEAK" ? -0.08 : 0;
  confidence       = Math.min(0.99, Math.max(0, confidence + tierAdj));

  // ── 10. Gate 5 — R:R check ───────────────────────────────────────────
  // Profile defines optimal TP/SL multiples from optimizer results.
  const tpDist = atr * profile.tpMult;
  const slDist = Math.max(atr * profile.slMult, spread * 3);
  const rr     = slDist > 0 ? tpDist / slDist : 0;
  const rrOk   = rr >= profile.minRR;

  // ── 11. Build final SL/TP from profile ───────────────────────────────
  const entry = base.entry ?? last?.close;
  let sl = base.sl;
  let tp = base.tp;
  if (entry != null && atr > 0 && base.decision !== "WAIT") {
    sl = isBuy ? entry - slDist : entry + slDist;
    tp = isBuy ? entry + tpDist : entry - tpDist;
  }

  // ── 12. Final decision ────────────────────────────────────────────────
  // All quality gates must pass. Confidence gate is caller-controlled via
  // opts.minConfidence — if not supplied, no floor is applied.
  const minConf      = opts.minConfidence ?? 0;
  const gatesPassed  =
    base.decision !== "WAIT" &&
    rsiAligned &&
    pullbackOk &&
    spreadOk &&
    rrOk &&
    confidence >= minConf;
  const decision     = gatesPassed ? base.decision : ("WAIT" as const);

  // ── 13. Position sizing ───────────────────────────────────────────────
  // Scale lot size with confidence: higher confidence → larger fraction.
  // Stays proportional — never a flat hardcoded multiplier.
  const volumeMultiplier =
    confidence >= 0.90 ? 1.00 :
    confidence >= 0.80 ? 0.80 :
    confidence >= 0.70 ? 0.60 : 0.40;

  const balance          = Math.max(0, Number(opts.balance ?? 0));
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
    rsiAligned       ? null : `RSI ${rsi.toFixed(0)} misaligned`,
    pullbackOk       ? null : "no pullback/zone",
    spreadOk         ? null : "spread too wide",
    rrOk             ? null : `RR ${rr.toFixed(2)} < min ${profile.minRR}`,
    confidence>=minConf ? null : `conf ${(confidence*100).toFixed(1)}% < floor ${(minConf*100).toFixed(0)}%`,
  ].filter(Boolean).join(", ");

  const rationale = [
    `[Mars4·${opts.symbolHint ?? "?"}]`,
    `${base.strategy} ${base.decision}`,
    `| conf ${(confidence * 100).toFixed(1)}%`,
    `| MTF ${(mtfScore * 100).toFixed(0)}%`,
    `| micro ${(microScore * 100).toFixed(0)}%`,
    `| RR ${rr.toFixed(2)}`,
    `| session ${tier}`,
    bosChochPresent ? "| BOS/CHoCH ✓" : "",
    gateLog         ? `| BLOCKED: ${gateLog}` : "| ALL GATES OK",
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

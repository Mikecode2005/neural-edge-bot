# Design Document

## Overview

Replace the `analyzeMars4` implementation in `src/lib/strategies/mars.ts` with the improved symbol-aware version from `src/lib/strategies/marsupdate.ts`. Mars1, Mars2, and Mars3 are **not touched**. The bot engine (`src/mt5-direct/bot.functions.ts`) receives two small additions to pass `nowEpoch` and `minConfidence`. The strategy catalog (`src/lib/strategies/catalog.ts`) gets an updated description for `mars4`.

---

## Architecture

### File touch list

| File | Change |
|---|---|
| `src/lib/strategies/mars.ts` | Replace Mars4Result interface + analyzeMars4 function + add private helpers (VolatilityProfileParams, VOLATILITY_PROFILES, DEFAULT_PROFILE, resolveProfile, sessionTier type + function). Mars1–3 untouched. |
| `src/mt5-direct/bot.functions.ts` | Add `nowEpoch` and `minConfidence` to the `analyzeMars4` call. |
| `src/lib/strategies/catalog.ts` | Update `description` for `id: "mars4"`. |

---

## Component Design

### 1. Private helpers added to mars.ts (above Mars4Result)

```ts
interface VolatilityProfileParams {
  match: string[];
  tpMult: number;
  slMult: number;
  minRR: number;
  bestHours: number[];
  bestDays: number[];
}

const VOLATILITY_PROFILES: VolatilityProfileParams[] = [ /* 9 profiles */ ];
const DEFAULT_PROFILE: VolatilityProfileParams = { /* fallback */ };

function resolveProfile(symbolHint?: string): VolatilityProfileParams { /* longest-match */ }

type SessionTier = "PRIME" | "GOOD" | "OFF_PEAK";
function sessionTier(nowEpoch: number, profile: VolatilityProfileParams): SessionTier { /* UTC hour+day */ }
```

### 2. Updated Mars4Result interface

```ts
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
```

### 3. analyzeMars4 function — 14-step pipeline

0. Resolve profile from `symbolHint`
1. Mars3 base signal (adaptive lookback 220–512)
2. Spread gate (spreadOk = spread ≤ ATR × 0.30)
3. RSI gate (BUY ≤ 55, SELL ≥ 45)
4. BOS/CHoCH gate (rationale substring check)
5. Pullback/zone gate (≥25% wick retrace OR active OB/FVG zone)
6. Micro-structure score (impulse, slope, close-location, extension, spread)
7. MTF score (base.mtfAgreement ?? 0.5)
8. Confidence synthesis (Mars3×0.60 + MTF×0.20 + micro×0.10 + bonuses)
9. Session tier adjustment (±0.08, clamped [0,0.99])
10. R:R gate (tpDist/slDist ≥ profile.minRR)
11. Build SL/TP from profile (slDist = ATR×slMult max spread×3, tpDist = ATR×tpMult)
12. Final decision (all 5 gates pass AND conf ≥ minConfidence)
13. Position sizing (volumeMultiplier, maxScalePositions, basketFields, scaleAllowed)
14. Return Mars4Result

### 4. bot.functions.ts — Mars4 call site update

```ts
m.analyzeMars4(candles, {
  balance: available,
  symbolHint: symbol,
  higherTimeframes,
  spreadPrice,
  nowEpoch: Math.floor(Date.now() / 1000),   // ← add
  minConfidence: minConfidence,               // ← add (uses existing streakThreshold var)
})
```

The `scaleAllowed` / `maxScalePositions` reads at lines ~795–825 already work because they read from `(decision as any).analysis?.scaleAllowed` — no changes needed there.

### 5. catalog.ts — description update

```ts
{
  id: "mars4",
  label: "Mars4",
  description:
    "Symbol-aware adaptive strategy: per-pair volatility profiles, 5-gate filter (RSI/BOS/pullback/spread/RR), session timing tiers (PRIME/GOOD/OFF_PEAK), and profile-calibrated SL/TP from Bayesian optimizer results",
}
```

---

## Data Flow

```
Bot tick
  → fetchMarsHigherTimeframes
  → analyzeMars4(candles, { balance, symbolHint=symbol, higherTimeframes, spreadPrice, nowEpoch, minConfidence })
      → resolveProfile(symbolHint)          // pick one of 9 profiles or default
      → analyzeMars3(window, ...)           // base signal
      → 5 quality gates
      → confidence synthesis + session tier
      → SL/TP from profile multipliers
      → return Mars4Result { decision, sessionTier, profileUsed, gates, ... }
  → bot engine reads: decision, confidence, sl, tp, scaleAllowed, maxScalePositions
  → place or skip order
```

---

## Error Handling

- If `symbolHint` is absent or unrecognised → `DEFAULT_PROFILE` used silently, `profileUsed = "default"`
- If `spreadPrice` is 0 or absent → `spreadOk = true` (Gate 4 auto-passes)
- If `nowEpoch` is absent → `Math.floor(Date.now() / 1000)` fallback
- If `minConfidence` is absent → floor treated as 0 (all gate-passing signals allowed through)

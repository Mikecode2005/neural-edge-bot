# Requirements Document

## Introduction

This feature replaces the existing `analyzeMars4` implementation inside
`src/lib/strategies/mars.ts` with the new, improved version from
`src/lib/strategies/marsupdate.ts`. Mars1, Mars2, and Mars3 are untouched.

The key improvement is that Mars4 becomes **symbol-aware (pair-conscious)**:
it resolves a per-symbol volatility profile from `symbolHint`, applies
optimised TP/SL multipliers derived from Bayesian optimizer results, runs a
5-gate quality filter, adjusts confidence with session-timing tiers, and
exposes a richer `Mars4Result` shape so the MT5 bot engine, the UI, and any
future consumers can read `sessionTier`, `profileUsed`, `gates`,
`scaleAllowed`, `maxScalePositions`, `basketProfitTargetUsd`, `basketStopUsd`,
`mtfScore`, and `microScore` directly from the strategy output.

---

## Glossary

- **Mars4**: The fourth generation of the MARS multi-strategy detector;
  returns a `Mars4Result` object.
- **Mars4Result**: The TypeScript interface returned by `analyzeMars4`.
  Extends `Mars3Result` with `sessionTier`, `profileUsed`, `gates`,
  `scaleAllowed`, `maxScalePositions`, `basketProfitTargetUsd`,
  `basketStopUsd`, `mtfScore`, and `microScore`.
- **Mars3Result**: Parent interface; extends `LiveAnalysis` with
  `volumeMultiplier`, `mtfAgreement`, and `rr`.
- **LiveAnalysis**: Core analysis type defined in `src/lib/ob-fvg.ts`.
- **VolatilityProfile**: Per-symbol parameter set (`tpMult`, `slMult`,
  `minRR`, `bestHours`, `bestDays`) resolved from `symbolHint`.
- **symbolHint**: Caller-supplied string identifying the traded symbol (e.g.
  `"Volatility 90 Index"`, `"1HZ25V"`). Used to resolve the VolatilityProfile.
- **SessionTier**: Enum value `"PRIME" | "GOOD" | "OFF_PEAK"` derived by
  comparing the current UTC hour and weekday against the profile's
  `bestHours` / `bestDays` arrays.
- **5-Gate filter**: The sequential quality checks that must all pass before
  Mars4 emits a non-WAIT decision: RSI alignment, BOS/CHoCH, pullback/zone,
  spread, and R:R.
- **minConfidence**: Caller-supplied confidence floor (0–1). Mars4 does NOT
  impose its own hardcoded floor.
- **nowEpoch**: Caller-supplied current UTC epoch (seconds). Falls back to
  `Date.now() / 1000` when omitted.
- **Bot Engine**: The MT5 bot tick handler in
  `src/mt5-direct/bot.functions.ts` that dispatches to strategies and
  consumes the result.
- **catalog.ts**: The strategy catalog file that advertises Mars4 metadata
  to the UI.
- **Candle**: OHLC data point as defined in `src/lib/deriv-ws.ts`.
- **MarsHigherTimeframes**: Map of higher-timeframe candle arrays keyed by
  `"m5" | "m15" | "m30" | "h1" | "h4"`.

---

## Requirements

### Requirement 1: Replace Mars4 Implementation in mars.ts

**User Story:** As a developer, I want `src/lib/strategies/mars.ts` to
contain the improved Mars4 implementation from `marsupdate.ts`, so that all
callers that import from `mars.ts` automatically get the new behaviour.

#### Acceptance Criteria

1. THE `mars.ts` File SHALL export an `analyzeMars4` function with the
   signature:
   ```
   analyzeMars4(candles: Candle[], opts?: {
     balance?: number;
     symbolHint?: string;
     higherTimeframes?: MarsHigherTimeframes;
     spreadPrice?: number;
     minConfidence?: number;
     nowEpoch?: number;
   }): Mars4Result
   ```
2. THE `mars.ts` File SHALL export a `Mars4Result` interface that extends
   `Mars3Result` with the fields `sessionTier`, `profileUsed`, `gates`,
   `scaleAllowed`, `maxScalePositions`, `basketProfitTargetUsd`,
   `basketStopUsd`, `mtfScore`, and `microScore`.
3. WHEN `mars.ts` is updated, THE `analyzeMars1`, `analyzeMars2`, and
   `analyzeMars3` functions SHALL remain identical to their current
   implementations and SHALL NOT be modified.
4. THE `mars.ts` File SHALL NOT import from `marsupdate.ts`; the new Mars4
   code SHALL be inlined or copied directly.
5. WHEN the existing `analyzeMars4` export is replaced, THE `Mars4Result`
   interface in `mars.ts` SHALL include `sessionTier: "PRIME" | "GOOD" |
   "OFF_PEAK"` and `profileUsed: string` which are absent from the current
   implementation.

---

### Requirement 2: Per-Symbol Volatility Profile Resolution

**User Story:** As a bot operator, I want Mars4 to automatically select the
correct tuning parameters for the symbol I am trading, so that TP/SL
distances are calibrated to that pair's historical win-rate and profit factor.

#### Acceptance Criteria

1. WHEN `analyzeMars4` is called with a `symbolHint` that matches one of the
   nine known profiles (vol_90, vol_15_1s, vol_75, vol_100, vol_90_1s,
   vol_50, vol_100_1s, vol_25_1s, vol_30), THE Strategy SHALL resolve the
   matching `VolatilityProfileParams` and use its `tpMult` and `slMult` to
   compute final SL and TP distances as multiples of ATR14.
2. WHEN `analyzeMars4` is called without a `symbolHint`, or with a
   `symbolHint` that does not match any profile, THE Strategy SHALL use the
   default fallback profile (`tpMult=3.0`, `slMult=1.8`, `minRR=1.5`).
3. WHEN multiple profiles share an overlapping match string (e.g. both
   vol_90 and vol_90_1s match `"90"`), THE Strategy SHALL resolve to the
   profile whose longest match token is found in the symbol hint, preventing
   vol_90 from incorrectly swallowing vol_90_1s entries.
4. THE `Mars4Result` SHALL expose `profileUsed: string` containing the first
   match token of the resolved profile, or `"default"` when the fallback
   profile is used.
5. WHEN a non-WAIT decision is produced, THE Strategy SHALL compute
   `slDist = ATR14 × profile.slMult` and `tpDist = ATR14 × profile.tpMult`
   and set `sl` and `tp` accordingly; spread protection SHALL be applied so
   that `slDist ≥ spread × 3`.

---

### Requirement 3: 5-Gate Quality Filter

**User Story:** As a risk manager, I want every Mars4 signal to pass five
independent quality checks before a trade is signalled, so that historically
loss-prone setups (e.g. RSI 60–70 on PUT entries) are systematically filtered.

#### Acceptance Criteria

1. THE Strategy SHALL evaluate Gate 1 (RSI Alignment): WHEN the proposed
   decision is BUY, THE Strategy SHALL require `rsi14 ≤ 55`; WHEN the
   proposed decision is SELL, THE Strategy SHALL require `rsi14 ≥ 45`.
2. THE Strategy SHALL evaluate Gate 2 (BOS/CHoCH): THE Strategy SHALL detect
   the presence of a Break-of-Structure or Change-of-Character signal by
   checking whether the base analysis rationale contains the substrings
   `"bos"`, `"choch"`, or `"chöch"` (case-insensitive).
3. THE Strategy SHALL evaluate Gate 3 (Pullback/Zone): WHEN the proposed
   decision is BUY, THE Strategy SHALL require either a ≥25% wick retrace on
   the last candle OR price inside an active bullish OB/FVG zone; WHEN the
   proposed decision is SELL, THE mirror condition SHALL apply.
4. THE Strategy SHALL evaluate Gate 4 (Spread): THE Strategy SHALL require
   that `spreadPrice ≤ ATR14 × 0.30`; WHEN `spreadPrice` is zero or not
   supplied, Gate 4 SHALL pass automatically.
5. THE Strategy SHALL evaluate Gate 5 (R:R): THE Strategy SHALL compute the
   expected R:R ratio as `tpDist / slDist` and require it to be ≥
   `profile.minRR`.
6. THE `Mars4Result` SHALL expose a `gates` object with boolean fields
   `rsiAligned`, `bosChochPresent`, `pullbackOk`, `spreadOk`, and `rrOk`
   reflecting the outcome of each gate for the most recent evaluation.
7. WHEN any gate fails, THE Strategy SHALL set `decision` to `"WAIT"`.
8. WHEN all gates pass AND `confidence ≥ opts.minConfidence`, THE Strategy
   SHALL set `decision` to the base signal's direction (`"BUY"` or `"SELL"`).

---

### Requirement 4: Session Timing Tiers

**User Story:** As a bot operator, I want Mars4 to reward entries at
historically productive times and penalise off-peak entries, so that the
confidence score reflects when the bot is most likely to win on a given
symbol.

#### Acceptance Criteria

1. WHEN `analyzeMars4` is called, THE Strategy SHALL determine the session
   tier by comparing the UTC hour and weekday derived from `opts.nowEpoch`
   (or `Date.now()/1000` when omitted) against the resolved profile's
   `bestHours` and `bestDays` arrays.
2. WHEN the current UTC hour is in `profile.bestHours` AND the current UTC
   weekday is in `profile.bestDays`, THE Strategy SHALL classify the session
   as `"PRIME"` and add `+0.08` to the synthesised confidence score.
3. WHEN the current UTC hour is in `profile.bestHours` OR the current UTC
   weekday is in `profile.bestDays` (but not both), THE Strategy SHALL
   classify the session as `"GOOD"` with no confidence adjustment.
4. WHEN neither condition holds, THE Strategy SHALL classify the session as
   `"OFF_PEAK"` and subtract `0.08` from the synthesised confidence score.
5. THE session tier adjustment SHALL be applied after the base confidence
   synthesis formula and SHALL NOT be a hard block; a PRIME session increases
   confidence but an OFF_PEAK session can still produce a trade if all gates
   pass and the resulting confidence exceeds `opts.minConfidence`.
6. THE `Mars4Result` SHALL expose `sessionTier: "PRIME" | "GOOD" |
   "OFF_PEAK"`.

---

### Requirement 5: Confidence Synthesis Without Hardcoded Floor

**User Story:** As a strategy developer, I want Mars4 to synthesise
confidence from multiple weighted inputs and respect only the caller-supplied
floor, so that I can control selectivity per deployment context without
touching strategy source code.

#### Acceptance Criteria

1. THE Strategy SHALL compute synthesised confidence as:
   `conf = min(0.99, mars3Conf × 0.60 + mtfScore × 0.20 + microScore × 0.10)`
   before applying bonuses and tier adjustments.
2. WHEN BOS/CHoCH is present, THE Strategy SHALL add `+0.05` to synthesised
   confidence (capped at 0.99).
3. WHEN RSI is aligned and the decision is not WAIT, THE Strategy SHALL add
   `+0.03` to synthesised confidence (capped at 0.99).
4. WHEN pullback/zone gate passes and the decision is not WAIT, THE Strategy
   SHALL add `+0.02` to synthesised confidence (capped at 0.99).
5. THE Strategy SHALL NOT impose any internal minimum confidence floor;
   WHEN `opts.minConfidence` is not supplied, THE Strategy SHALL treat the
   floor as `0`, allowing all gate-passing signals through regardless of
   confidence level.
6. THE `Mars4Result` SHALL expose `mtfScore: number` (0–1) representing
   the MTF agreement ratio used in the synthesis.
7. THE `Mars4Result` SHALL expose `microScore: number` (0–1) representing
   the micro-structure quality score used in the synthesis.

---

### Requirement 6: Adaptive Position Sizing and Basket/Scale Fields

**User Story:** As a bot operator, I want Mars4 to compute position-sizing
multipliers and basket trading parameters from the synthesised confidence
level, so that higher-conviction entries can scale up while low-conviction
entries are sized down automatically.

#### Acceptance Criteria

1. THE Strategy SHALL set `volumeMultiplier` based on synthesised confidence:
   `≥ 0.90 → 1.00`, `≥ 0.80 → 0.80`, `≥ 0.70 → 0.60`, else `0.40`.
2. THE Strategy SHALL set `maxScalePositions` based on synthesised
   confidence: `≥ 0.90 → 10`, `≥ 0.80 → 6`, `≥ 0.70 → 4`, else `2`.
3. THE Strategy SHALL set `basketProfitTargetUsd` to
   `max(1, balance × (0.006 if conf ≥ 0.80 else 0.003))`, rounded to 2
   decimal places.
4. THE Strategy SHALL set `basketStopUsd` to
   `max(2, balance × 0.015)`, rounded to 2 decimal places.
5. THE Strategy SHALL set `scaleAllowed` to `true` ONLY WHEN all gates pass
   AND `microScore ≥ 0.40`; otherwise `scaleAllowed` SHALL be `false`.
6. IF `opts.balance` is zero or not supplied, the basket USD fields SHALL
   default to their `max()` floor values (`basketProfitTargetUsd = 1`,
   `basketStopUsd = 2`).

---

### Requirement 7: Consistent nowEpoch Parameter Threading

**User Story:** As a test engineer, I want to be able to supply a fixed
`nowEpoch` to `analyzeMars4`, so that session-timing behaviour is fully
deterministic in tests without mocking `Date.now`.

#### Acceptance Criteria

1. WHEN `opts.nowEpoch` is supplied, THE Strategy SHALL use it exclusively
   for session tier computation and SHALL NOT call `Date.now()`.
2. WHEN `opts.nowEpoch` is omitted, THE Strategy SHALL fall back to
   `Math.floor(Date.now() / 1000)`.
3. THE `nowEpoch` value SHALL be forwarded to the `sessionTier` helper
   without modification.

---

### Requirement 8: Bot Engine Consumption of New Mars4Result Fields

**User Story:** As a bot operator, I want the MT5 bot engine to correctly
read the new `sessionTier`, `gates`, and `profileUsed` fields from
`Mars4Result`, so that scaling decisions, activity log entries, and basket
guards reflect the improved strategy output.

#### Acceptance Criteria

1. WHEN `strategyMode === "mars4"`, THE Bot Engine SHALL read
   `decision.analysis.maxScalePositions` from the `Mars4Result` to determine
   the per-bot scaling cap (capped by the user-configured
   `mars4ConfiguredMaxPositions`).
2. WHEN `strategyMode === "mars4"`, THE Bot Engine SHALL read
   `decision.analysis.scaleAllowed` from the `Mars4Result`; IF this is
   `false`, THE Bot Engine SHALL log a `"SKIP"` activity entry and SHALL NOT
   place an order.
3. WHEN the `analyzeMars4` call receives `opts.spreadPrice`, THE Bot Engine
   SHALL pass the live spread price from MT5 symbol info (`symInfo.spread ×
   symInfo.point`) so Gate 4 (spread) operates on real broker data.
4. WHEN `strategyMode === "mars4"`, THE Bot Engine SHALL pass `opts.nowEpoch`
   as `Math.floor(Date.now() / 1000)` at call time so session-tier scoring
   reflects the actual clock.
5. WHEN `strategyMode === "mars4"`, THE Bot Engine SHALL pass
   `opts.minConfidence` equal to the bot's configured `min_confidence` so
   the caller-controlled floor is respected.

---

### Requirement 9: Catalog Description Update

**User Story:** As a UI user, I want the Mars4 entry in the strategy catalog
to accurately describe its new capabilities, so that I can make an informed
choice when selecting a strategy for my bot.

#### Acceptance Criteria

1. THE `STRATEGY_CATALOG` in `src/lib/strategies/catalog.ts` SHALL update
   the `description` field for `id: "mars4"` to reflect the new adaptive
   profile-driven approach, session timing tiers, 5-gate filter, and
   symbol-aware SL/TP.
2. THE `label` field for `id: "mars4"` SHALL remain `"Mars4"` so existing
   UI references are not broken.

---

### Requirement 10: Backward-Compatible Mars4Result Interface

**User Story:** As a developer integrating Mars4 output, I want the
`Mars4Result` interface to remain a strict superset of the previous shape,
so that existing code that reads `scaleAllowed`, `maxScalePositions`,
`basketProfitTargetUsd`, `basketStopUsd`, `mtfScore`, and `microScore` does
not break.

#### Acceptance Criteria

1. THE new `Mars4Result` SHALL retain all six fields present in the current
   implementation: `scaleAllowed`, `maxScalePositions`, `basketProfitTargetUsd`,
   `basketStopUsd`, `mtfScore`, and `microScore`.
2. THE new `Mars4Result` SHALL add `sessionTier`, `profileUsed`, and `gates`
   as additional fields without removing or renaming any existing field.
3. WHEN `analyzeMars4` is called without a `spreadPrice`, THE function SHALL
   still return a valid `Mars4Result` with `gates.spreadOk` set to `true`
   (spread gate passes when no spread data is available).
4. THE `analyzeMars4` function signature SHALL accept all four parameters
   that the current implementation accepts (`balance`, `symbolHint`,
   `higherTimeframes`, `spreadPrice`) so existing call sites do not require
   changes.

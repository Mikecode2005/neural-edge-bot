# Implementation Tasks

## Task 1: Replace Mars4 in mars.ts

- [ ] 1.1 Add VolatilityProfileParams interface, VOLATILITY_PROFILES array, DEFAULT_PROFILE constant, resolveProfile function, SessionTier type, and sessionTier helper function to mars.ts — placed between the end of analyzeMars3 and the Mars4Result interface
- [ ] 1.2 Replace the Mars4Result interface with the new version that adds sessionTier, profileUsed, and gates fields
- [ ] 1.3 Replace the analyzeMars4 function body with the new 14-step implementation from marsupdate.ts (do not import from marsupdate.ts — inline everything)
- [ ] 1.4 Verify Mars1, Mars2, and Mars3 are byte-for-byte identical to the original

## Task 2: Update bot.functions.ts Mars4 call site

- [ ] 2.1 Add `nowEpoch: Math.floor(Date.now() / 1000)` to the analyzeMars4 opts object
- [ ] 2.2 Add `minConfidence: streakThreshold` to the analyzeMars4 opts object

## Task 3: Update catalog.ts description

- [ ] 3.1 Update the description field for id "mars4" to: "Symbol-aware adaptive strategy: per-pair volatility profiles, 5-gate filter (RSI/BOS/pullback/spread/RR), session timing tiers (PRIME/GOOD/OFF_PEAK), and profile-calibrated SL/TP from Bayesian optimizer results"

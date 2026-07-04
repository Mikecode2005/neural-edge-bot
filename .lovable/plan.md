## Problem analysis

Reviewed `src/lib/ob-fvg.ts`, `src/lib/bots/bot-engine.ts`, `src/mt5-direct/bot.functions.ts`, and the MT5 UI. Current results are mostly losing on Volatility 10 (1s) because the strategy has structural weaknesses on synthetic tick indices:

1. **`decision` gate is broken.** `analyze()` returns `BUY`/`SELL` as soon as *any* unmitigated OB+FVG exists — trend, HTF, sweep, displacement, RSI are computed but not required. Confidence is padded (`score = 0.4 + small bonuses`) so even a counter-trend setup passes a 0.65–0.70 threshold.
2. **Retracement not enforced.** A bullish OB triggers BUY even when price is above the OB and has not returned to the FVG.
3. **Fixed 1.0 ATR SL / 1.5 ATR TP** on 1s vol indices gets hit by noise; RR of 1.5 is too low once spread is included.
4. **Single strategy.** OB+FVG alone is fragile in ranging tick data. No mean-reversion or momentum-continuation confirmation.
5. **No cool-down / loss-streak brake.** Bot keeps firing after consecutive losses.
6. **MT5 UI shows stake $ fields** (Lock-in Stake, Min Stake, Account Balance) that are Deriv-binary concepts. On MT5, position size is *lots*; risk should be derived from `lots × SL distance × tickValue`.
7. **Qwen wiring is present** but never gets called from the Bots page (only MT5), and even on MT5 the OB+FVG fallback fires without telling the user why. Also Qwen is not fed the new confluence features cleanly.

## Deliverables

### Backend — strategy engine (`src/lib/ob-fvg.ts`)

Rewrite `analyze()` to be a real gate, not a formatter:

- Require **all** of these before emitting BUY/SELL:
  - Active unmitigated OB + unfilled FVG **and** price has retraced into the OB zone (not merely near it).
  - Trend alignment on 1m **and** HTF 15m EMA20/50.
  - RSI not extreme (BUY < 68, SELL > 32).
  - Volatility regime `normal` (ATR band tuned per symbol family — wider for 1s indices).
  - Either liquidity sweep **or** displacement candle in trade direction within last 5 bars.
  - ADX ≥ 18 (skip dead chop).
- If any hard gate fails → `decision = "WAIT"`. This alone kills most losing trades.
- Confidence recalibrated to a proper 0–1 scale (base 0.30 + weighted bonuses capped at 0.95); no free floor.
- Widen SL to `1.5 × ATR`, TP to `2.5 × ATR` (RR 1.67) with a 3R cap at nearest swing liquidity.
- Add a **mean-reversion confluence** helper (`analyzeMeanReversion`) for ranging regimes: Bollinger-band touch + RSI divergence, used as a secondary strategy.
- Add a **momentum-continuation** helper (`analyzeMomentum`): EMA-pullback + displacement candle in trend direction.
- Export a new `analyzeMulti(candles)` that runs all three and returns the highest-confidence signal with `strategy` tag.

### Backend — bot engine (`src/lib/bots/bot-engine.ts`)

- `makeObFvgBotDecision` → rename internally to `makeMultiStrategyDecision`, keep the old export as a thin wrapper for callers.
- Consume `analyzeMulti`; only trade when `analysis.decision !== "WAIT"` **and** confidence ≥ threshold.
- Add loss-streak cool-down: after 3 losses in a row, require confidence ≥ threshold + 0.10 for the next 5 ticks.
- Add per-symbol ATR floor so 1s indices don't over-trade tiny ranges.

### Backend — MT5 tick handler (`src/mt5-direct/bot.functions.ts`)

- Drop the Deriv-style `stake` model. Compute `riskUsd = lots × slDistance × tickValue × contractSize / tickSize` from `symbolInfo` and log it; use lots as the source of truth for position size.
- Move the `min_confidence` guard, loss-streak brake, and `analyzeMulti` result into the tick decision path so Qwen and OB+FVG both benefit.
- When `strategy_mode === "qwen"`, always send the multi-strategy features (from `analyzeMulti`) plus recalled lessons; log a clear ACTIVITY row saying which strategy fired.

### Backend — Qwen (`src/lib/ai/qwen.functions.ts`)

- Update `DOCTRINE` to describe the 3 strategies and the hard gates; require Qwen to only emit CALL/PUT when the corresponding gate set is satisfied.
- Feed `analyzeMulti` output (best signal + rejected reasons) into the user prompt.
- Keep classification + lesson recording as-is.

### Frontend — MT5 page (`src/routes/_authenticated/mt5-direct.tsx`)

- Remove the money-stake inputs (Lock-in Stake, Min Stake, Account Balance) from the New MT5 Bot form.
- Keep and emphasize: **Symbol, Account (demo/real), Interval, Min Confidence, Volume (lots), Strategy Mode (OB+FVG / Qwen AI / Multi-Strategy)**.
- Show a live **Risk per trade** helper: `lots × recent SL distance × pip value ≈ $X` computed from `mt5PerformanceReport` symbol info.
- On each running bot card, replace the "stake $X" chip with "**Volume X lots**" and add a "Strategy" chip.
- Add a "Strategy" column in the activity table so users see which of OB+FVG / MR / Momentum / Qwen fired.

### Wiring so nothing else breaks

- `mt5StartBot` input validator keeps `max_stake_per_trade`/`min_stake_per_trade` optional with defaults so existing bots still load; the new UI just omits them.
- `bot_runs.ai_config` gains `{ volume, risk_usd_estimate }` — no schema change needed (JSONB).
- Bots page (`_authenticated/bots.tsx`) continues to use the stake model (Deriv binary). No changes required there.

## Technical notes

- All strategy functions stay pure and unit-testable; no DOM or network access in `ob-fvg.ts`.
- `analyzeMulti` returns `{ decision, confidence, strategy: "ob-fvg" | "mean-reversion" | "momentum", ...LiveAnalysis }` so the UI can render the badge without extra DB fields.
- Loss-streak state stored on `bot_runs` via existing `wins`/`losses` counters plus a new derived `consecutive_losses` computed on read from `bot_activity` (no migration).
- Qwen prompt stays JSON-only; token budget unchanged.

## Out of scope for this change

- Backtester UI (still uses the old single-strategy analyzer; can be migrated in a follow-up).
- Server-side cron loop enablement for MT5 (already discussed as a separate task).
- Any change to Deriv bots.

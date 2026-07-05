# Multi-Strategy Confluence Engine — Implementation Plan

Goal: turn today's OB+FVG / Momentum / Mean-Reversion trio into a professional, regime-aware ensemble that mirrors the ranked framework you shared, with per-strategy performance tracking and a per-strategy backtester.

## Architecture (single tick pipeline)

```text
Candles (1m + HTF 15m/1h) 1m 2m 5m
   ↓
1. Regime Engine        → { regime: trend_up|trend_dn|range|compression|reversal, score, adx, atr%, bb_width }
   ↓
2. Analysis (HTF Bias)  → BOS / CHOCH / trend from EMA20/50/200 stack on HTF
   ↓
3. POI Selection        → OB zones, FVG zones, liquidity pools (equal highs/lows), OTE Fib 0.62–0.79
   ↓
4. Strategy Signals (run in parallel, gated by regime)
      • MSNR + CRT              (primary, trend + range)
      • APA (Analysis→POI→Action) (primary complement)
      • Liquidity Sweep / Turtle Soup (reversal / range extremes)
      • OB + FVG (SMC)          (confluence + entry precision)
      • Volatility Compression→Expansion (compression regime only)
      • Wyckoff phase tag       (reversal / accumulation context)
      • EMA Pullback Momentum   (trend only)
      • ICT OTE                 (entry refinement inside POI)
      • Fractal Swing BOS/CHOCH (structure confirmation)
      • Dynamic S/R             (target selection)
      • Bollinger + RSI MR      (range only)
   ↓
5. Confluence Scorer    → 0–100 (weights below); require ≥70 AND regime-match
   ↓
6. Confidence + Decision (BUY/SELL/WAIT) + Strategy tag + reasons
   ↓
7. Risk Manager         → 1% risk cap, SL to nearest structure, TP1 = 1R (partial), TP2 = swing liquidity
   ↓
8. Executor (Deriv / MT5) + Logger (per-strategy + confluence breakdown)
   ↓
9. AI Learning (Qwen)   → post-trade lesson, feeds next tick's prompt
```

## Confluence scoring

Base 30 (valid primary signal), plus:

- +30 Liquidity Sweep aligned with bias
- +25 OB/FVG overlap at POI
- +20 Volatility expansion after compression
- +15 OTE 0.62–0.79 or fresh fractal BOS
- +10 EMA pullback OR Dynamic S/R touch
- +10 Wyckoff phase match (spring/UT)
- −20 counter-regime, −15 stale POI (>50 bars), −10 RSI extreme against trade

Trade if `score ≥ 70` AND regime allows the strategy. Size = `baseVolume × (score/100)` clamped to symbol lot step.

## Regime → allowed strategies


| Regime      | Primary                      | Confluence                        |
| ----------- | ---------------------------- | --------------------------------- |
| trend_up/dn | MSNR+CRT, APA, EMA pull      | OB/FVG, OTE, Fractal, Dynamic S/R |
| range       | APA, Liquidity Sweep, BB+RSI | OB/FVG, Wyckoff, Dynamic S/R      |
| compression | (wait) Vol Expansion         | Fractal breakout                  |
| reversal    | Turtle Soup, Wyckoff         | Liquidity Sweep, OB/FVG, APA      |


## Files

**New**

- `src/lib/strategies/regime.ts` — `detectRegime(candles, htf)` (ADX, ATR%, BB width, BOS/CHOCH, min-bar confirmation)
- `src/lib/strategies/msnr-crt.ts`
- `src/lib/strategies/apa.ts`
- `src/lib/strategies/liquidity-sweep.ts`
- `src/lib/strategies/vol-expansion.ts`
- `src/lib/strategies/wyckoff.ts`
- `src/lib/strategies/ote.ts`
- `src/lib/strategies/fractal.ts`
- `src/lib/strategies/dynamic-sr.ts`
- `src/lib/strategies/bb-rsi.ts`
- `src/lib/strategies/confluence.ts` — scorer + `analyzeEnsemble(candles, htf)` returning `{ decision, confidence, strategy, regime, score, breakdown[], sl, tp1, tp2, poi }`
- `src/lib/strategies/indicators.ts` — shared ADX, BB, fractals, swing detector, liquidity pools
- `src/routes/_authenticated/strategy-lab.tsx` — per-strategy backtester UI (pick symbol, timeframe, date range, strategies to enable, min score); table of per-strategy win-rate, PF, expectancy, avg R, max DD, equity curve
- `src/lib/backtest/multi-backtest.functions.ts` — server fn `runMultiBacktest({ symbol, from, to, strategies, minScore, htfTf })`; replays candles bar-by-bar through `analyzeEnsemble`, records every signal with the winning strategy tag, simulates SL/TP1/TP2, returns per-strategy and aggregate metrics

**Edited**

- `src/lib/ob-fvg.ts` — keep existing exports; move OB/FVG detection helpers into `strategies/indicators.ts`; `analyzeMulti` becomes a thin wrapper around `analyzeEnsemble` for backward compatibility
- `src/lib/bots/bot-engine.ts` — replace `makeMultiStrategyDecision` internals with `analyzeEnsemble`; write `strategy`, `regime`, `confluence_score`, `score_breakdown` into activity log
- `src/mt5-direct/bot.functions.ts` — same swap; log per-strategy tag; use score-weighted lot sizing (clamped to symbol volume step)
- `src/lib/ai/qwen.functions.ts` — DOCTRINE updated to describe regime + confluence rules; user prompt now carries `regime`, `poi`, `strategy_signals[]`, `score_breakdown`
- `src/routes/_authenticated/bots.tsx` — activity row shows Regime + Strategy + Score chips
- `src/routes/_authenticated/mt5-direct.tsx` — same chips; add "Strategy Lab" nav link
- `src/routes/_authenticated/backtest.tsx` — add link/tab to Strategy Lab; keep legacy single-strategy report
- `src/components/AppNav.tsx` — add "Strategy Lab" entry

**Migration** (`supabase/migrations/<ts>_strategy_performance.sql`)

- `bot_activity`: add `regime text`, `confluence_score numeric`, `score_breakdown jsonb` (nullable, no data loss)
- New view `strategy_performance` aggregating from `bot_positions` grouped by `ai_config->>'strategy'` with wins/losses/net/PF/expectancy
- GRANT SELECT on view to `authenticated`

## Risk & guardrails

- Hard 1% account-risk cap per trade; loss-streak brake (already implemented) escalates required score by +10 after 3 losses.
- Daily loss limit at 3% halts the bot for the session.
- Skip when regime = compression unless Vol Expansion fires.
- Freshness: POIs older than 50 bars ignored.
- Failed-head-test filter in APA: if same POI tested 2× and rejected, invalidate bias.

## Testing

- `src/lib/strategies/__tests__/regime.test.ts`, `confluence.test.ts`, `apa.test.ts`, `liquidity-sweep.test.ts` — unit tests on synthetic candle fixtures for each detector and the scorer thresholds.
- Manual: run backtester on Volatility 10 (1s) + EURUSD 1m for last 7 days; verify per-strategy stats populate and total ≥ current OB+FVG baseline.

## finally update the multistrategy well and very well and we mostly dont use eurusd mostly volatitlity and the  qwen finetuning well also 
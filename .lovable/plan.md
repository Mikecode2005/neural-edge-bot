## Goal

Turn the current mocked dashboard into a real autonomous trader on Deriv. AI is the decision-maker — it reads market context, recalls past strategy notes from Supabase, picks direction + stake + TP/SL, and either suggests or auto-fires the trade depending on the mode toggle.

## Architecture

```text
Browser ── Deriv OAuth ──▶ Deriv               (per-user token, never leaves client+server)
   │
   │  Live WS  ◀──── ticks, balance, contracts, portfolio ────▶  Deriv WS (app_id = DERIV_APP_ID)
   │
   ├─▶ Supabase  (account, sessions, strategy_memory, trades, signals, ai_decisions, settings)
   │
   └─▶ TanStack server fn  ──▶ HF Inference API (Qwen2.5-7B-Instruct)
                              │
                              └── prompt = strategy doctrine + recent candles + OB/FVG zones
                                          + recalled memory snippets + account state
                              └── returns JSON: {action, stake, duration, tp, sl, confidence, reasoning, lesson?}
```

The legacy `/hf_backend` FastAPI stays in the repo but is no longer on the hot path. Everything runs from TanStack server functions calling HF directly — one less thing to deploy.

## Deriv layer (ported from devty)

Port the minimum from `devtybot-main/src/external/deriv-core` + `services/derivws-accounts.service.ts`:

- `src/lib/deriv/oauth.ts` — `initiateLogin`, `handleOAuthCallback`, PKCE, CSRF, storage helpers.
- `src/lib/deriv/ws.ts` — single shared WS to `wss://ws.derivws.com/websockets/v3?app_id=...`, request/response correlation by `req_id`, auto-reconnect, subscription registry. Replaces current ad-hoc `deriv-ws.ts`.
- `src/lib/deriv/api.ts` — typed wrappers: `authorize`, `balance(subscribe)`, `ticks_history`, `ticks(subscribe)`, `proposal`, `buy`, `sell`, `proposal_open_contract(subscribe)`, `portfolio`, `active_symbols`.
- `src/lib/deriv/accounts.ts` — fetch accounts list, switch active loginid, demo/real flag.

New routes:
- `/auth/deriv` — public; redirects to Deriv OAuth.
- `/auth/deriv/callback` — public; exchanges code, stores tokens in Supabase per user, redirects to `/dashboard`.

## AI layer

`src/lib/ai/qwen.functions.ts` — server fn `analyzeMarket({ symbol, candles, obZones, fvgZones, account })`:

1. Pull last N relevant `strategy_memory` rows (by symbol + strategy + outcome).
2. Build a system prompt = the **strategy doctrine** (see below) + recalled lessons.
3. Call `https://router.huggingface.co/...` for `Qwen/Qwen2.5-7B-Instruct` with `HF_TOKEN`, request JSON-mode response.
4. Validate against Zod schema, persist to `ai_decisions`, return to client.

`src/lib/ai/learn.functions.ts` — server fn `recordOutcome({ decisionId, pnl, contractDetails })`: writes a `strategy_memory` row with what worked / didn't, tagged by symbol, timeframe, setup type. Triggered automatically when a contract closes.

### Strategy doctrine (baked into the system prompt)

Order Block + Fair Value Gap, on V10/V15/V25 (1s and standard). Rules taught explicitly:
- FVG = 3-candle imbalance, candle1.high < candle3.low (bullish) or candle1.low > candle3.high (bearish).
- OB = last opposite-color candle before the impulse that created the FVG.
- Entry trigger: price returns into OB zone with rejection wick.
- TP = next liquidity pool (recent swing high/low); SL = beyond OB extreme + buffer.
- Risk: stake ≤ `risk_percent` of balance, default 2%, hard-capped server-side.
- Skip if spread > X, if FVG already mitigated, if conflicting higher-TF structure.

The model returns `{direction: CALL|PUT|NONE, stake, duration_unit, duration, take_profit, stop_loss, confidence_0_1, reasoning, lesson_to_store?}`.

## Trade execution

`src/lib/trading/execute.functions.ts` — `executeTrade({decision, mode})`:
1. Re-validate risk gates server-side (never trust client).
2. Call Deriv `proposal` → `buy` with `limit_order: { take_profit, stop_loss }` for multipliers, or duration-based contract for rise/fall fallback.
3. Subscribe to `proposal_open_contract` for the contract id, stream updates to client + persist final settlement to `trade_history`, then trigger `recordOutcome`.

Mode toggle (per user, stored in `settings`):
- `account: demo | real`
- `execution: manual | auto`

Manual: signal lights up an "Approve trade" card showing AI reasoning + TP/SL; user clicks Buy.
Auto: server fn auto-executes the moment `analyzeMarket` returns `confidence ≥ threshold` and risk gates pass. Auto-loop runs in the browser (one tab = one runner) reading live WS ticks, recomputing OB/FVG on candle close, calling Qwen, calling execute. A "Stop bot" kill switch is always visible.

Real-account toggle is gated behind a confirmation modal + daily loss cap + max stake cap.

## UI revamp

Routes (all under `_authenticated/`):
- `/dashboard` — live balance, open positions (real), today's P/L, currently-watched symbol, AI status pill.
- `/trade` — primary screen: TradingView-style chart with OB/FVG overlays, live tick price, AI Decision panel (current reasoning streamed), symbol selector (V10/V10 1s/V15/V15 1s/V25/V25 1s), mode toggles, Start/Stop bot button, recent decisions list.
- `/history` — real `trade_history` from Deriv contracts, P/L per trade, AI's pre-trade reasoning vs actual outcome.
- `/memory` — browse `strategy_memory`: what the AI has learned, by symbol/setup. Editable (user can delete bad lessons).
- `/settings` — Deriv account connect/disconnect, account switcher (demo accounts list), risk caps, confidence threshold, model picker.
- `/auth` — sign-in (email+Google via Lovable Cloud), then "Connect Deriv" CTA.

Mock data removed wholesale. Empty states say "Connect Deriv to begin" / "No trades yet — start the bot".

## Database changes (new migration)

- `deriv_connections (user_id, loginid, account_type, currency, balance, access_token_encrypted, refresh_token_encrypted, expires_at, is_active)`
- `ai_decisions (id, user_id, symbol, timeframe, direction, stake, tp, sl, confidence, reasoning, model, prompt_hash, candles_snapshot, created_at, contract_id?)`
- `strategy_memory (id, user_id, symbol, setup_type, lesson, outcome, pnl, embedding?, tags[], created_at, last_used_at, usefulness_score)`
- `bot_runs (id, user_id, started_at, stopped_at, mode, account_type, symbol, total_trades, total_pnl)`
- Extend `trade_history` with `ai_decision_id`, `deriv_contract_id`, `tp`, `sl`.
- Extend `settings` with `auto_trade`, `account_mode`, `min_confidence`, `max_daily_loss`, `max_stake`.

All with proper RLS scoped to `auth.uid()` and the GRANTs.

## Auth

Email/password + Google sign-in via Lovable Cloud managed flow on `/auth`. Deriv OAuth is a *separate* step after app login — Deriv tokens are stored encrypted, scoped to the app user.

## Security notes

- Deriv access tokens encrypted at rest (Fernet) in `deriv_connections`, only readable by `supabaseAdmin` in server fns.
- HF_TOKEN only used inside server fns, never sent to client.
- Server-side risk gates re-check every trade; client toggles are advisory.
- Auto mode requires explicit checkbox + 5-second confirmation hold before first activation per session.

## Build order (so each slice is testable)

1. **DB migration** + RLS + GRANTs.
2. **Deriv WS client + OAuth** + `/auth/deriv` + `/auth/deriv/callback` + accounts switcher.
3. **Live dashboard wired to real WS** (balance, ticks, no AI yet) — proves end-to-end Deriv works.
4. **Qwen server fn** + `strategy_memory` read/write + AI Decision panel in manual mode (no execution).
5. **Trade execution** via `proposal`/`buy` in demo, manual approval flow, contract streaming.
6. **Auto mode loop** + bot run tracking + kill switch.
7. **Real-account gate** + daily loss / max stake enforcement.
8. **History + Memory + Settings pages** polished.

## Scope I am NOT doing in this pass

- Multiple strategies (only OB+FVG; pluggable interface ready though).
- Strategy backtester UI.
- Mobile app.
- Embeddings-based memory recall (uses simple tag+recency filter; embedding column reserved for later).
- Resurrecting the FastAPI `/hf_backend` (kept in repo, off the hot path).

## What I need to confirm before I start

1. **Deriv app_id**: you've saved `DERIV_APP_ID`. Confirm the OAuth **redirect URL** registered on Deriv's app dashboard matches `https://id-preview--79a3623d-5b7c-4a95-bd3f-9f4cbc98adec.lovable.app/auth/deriv/callback` (and later the published domain). If not, OAuth will bounce.
2. **Default symbol** on first load — `R_10` (V10), or `1HZ10V` (V10 1s)?
3. **Confidence threshold** default for auto mode — `0.7`?
4. **Risk defaults** — 2% stake/trade, max 5 trades/day, max 10% daily loss?

Reply with answers (or "go with defaults") and I'll start at step 1.

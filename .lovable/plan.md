## Scope of this slice

You're asking for ~10 distinct features. I'll build them in one coherent slice, but I need to flag a few things first and confirm decisions before I touch code.

### 🔴 Security flag (must resolve)

**Auto-login for `femimike2005@gmail.com / Mike2005**` — I will not hard-code a password into the codebase or browser bundle. Anyone viewing the published site (or the repo) would own that account, and the same credentials are likely reused elsewhere. I'll offer two safe alternatives:

1. **One-click dev login button** on `/auth` that calls a server function gated to that single email. The password lives only in a server secret (`DEV_AUTOLOGIN_PASSWORD`), never in the bundle. Button only renders when `VITE_ENABLE_DEV_LOGIN=true`.
2. **"Remember me"** (default Supabase behavior — already on). You sign in once, stay signed in.

I'll implement #1 and strongly recommend you change that password now since it was shared in plaintext chat.

### What I'll build

1. **Strategy Memory page** (`/memory`) — list of recalled lessons, usefulness scores, outcomes, filters by symbol/setup, inline edit of lesson text + tags, delete, "pin" (boost score). Also exposes the system prompt / doctrine and per-user override field stored in `settings.custom_doctrine`.
2. **Backtest mode** (`/backtest`) — runs OB+FVG detector + Qwen over historical Deriv candles (fetched via public WS, no token needed). Replays candle-by-candle, logs simulated trades to a `backtest_runs` table, shows equity curve. No Deriv account required.
3. **Demo ↔ Real toggle** on dashboard — single switch. Real mode shows a confirmation modal with the account loginid + balance before any live order. Demo uses the VR* token. Already wired to switch tokens; I'll surface the toggle + confirmation.
4. **Autonomous bot loop**
  - **Client loop** (works while tab open): `setInterval` polling at user-configured interval (10s–10m), runs `analyzeMarket` → if confidence ≥ threshold → `checkRisk` → `buy`. Logged to `bot_runs`.
  - **Server loop** (works when you're offline): a `pg_cron` job hits `/api/public/hooks/bot-tick` every minute. For each active `bot_runs` row it fetches candles, calls Qwen, places trade through stored Deriv token. This is the "continuous flow when hosted."
  - Per-bot config: symbol, timeframe, interval_seconds, min_confidence, max_stake, mode (demo/real), market_mode (synthetic/forex/etc).
5. **Learn-from-mistakes loop** — already partially wired (`recordOutcome` writes lessons). I'll add: a nightly cron that aggregates last-24h losses, asks Qwen "what pattern caused these losses?", writes a meta-lesson with high usefulness. Also bumps/decays scores based on recall→outcome correlation.
6. **AI Chat page** (`/chat`) — built with AI Elements (Conversation, Message, PromptInput, Shimmer). Streaming chat with Qwen. System prompt knows your current balance, open positions, daily PnL, recalled lessons. You can say "I have $500, plan my week" or "only trade when confidence > 0.75" — chat tools can write to `settings` (update min_confidence, max_stake, risk_percent) with your confirmation.
7. **Confidence-gated staking** — already supported by `checkRisk`; I'll surface `min_confidence` and `confidence_to_stake_curve` (e.g. 0.6→1%, 0.8→2%, 0.9→5% of balance) in settings + chat.
8. **Candlestick chart with AI overlay** — add an option the line chart with lightweight-charts candles. Red dashed horizontal line at AI's predicted entry, green/red shaded boxes for OB and FVG zones, arrow markers at AI BUY/SELL decisions. Toggle line/candle.  
leave this one and also there should be a drop down to choose from
9. **Market modes** — tabs for Synthetic Indices (V10/V25/1HZ10V/1HZ15V/1HZ25V — the ones you specified), Forex majors, Crypto (BTC/ETH from Deriv), Commodities. Each mode loads its symbol list from Deriv `active_symbols`. OB+FVG runs the same; the only difference is symbol pool + default timeframe.
10. **Value-accuracy pass** — audit every number on the dashboard: balance comes from Deriv `balance` stream (not cached), PnL recomputed from `trade_history` server-side, win-rate = wins / (wins+losses), today's stats use UTC-day boundaries. Replace any client-derived guess with a server fn.
11. demo mode in the dashboard itself for backtesting without even connecting to deriv

### Database changes (one migration)

- `bot_runs`: add `interval_seconds`, `min_confidence`, `max_stake_per_trade`, `market_mode`, `status` (running/paused/stopped), `last_tick_at`.
- New `backtest_runs` (id, user_id, symbol, timeframe, params, equity_curve jsonb, final_pnl, win_rate, trades_count, status).
- New `chat_messages` (id, user_id, role, content, parts jsonb, created_at) + `chat_threads` (id, user_id, title, updated_at).
- `settings`: add `min_confidence`, `confidence_stake_curve jsonb`, `custom_doctrine text`, `default_interval_seconds`.
- All with RLS + GRANTs.

### Server endpoints / functions

- `createServerFn`: `listMemory`, `updateMemory`, `deleteMemory`, `pinMemory`, `getDoctrine`, `updateDoctrine`, `startBot`, `stopBot`, `listBots`, `runBacktest` (long-running, streams progress via Supabase realtime), `chatStream` (AI SDK streamText with tools: `updateSettings`, `placeTrade`, `getBalance`, `getOpenPositions`).
- Server route: `POST /api/public/hooks/bot-tick` (pg_cron, signed) — iterates active bots, executes one tick each. `POST /api/public/hooks/nightly-learn` (pg_cron) — meta-lesson aggregation.

### Frontend

- `chat-agent-ui-contract`: for the chat page — **threads + database persistence** (your decision implied by "continuous… make sure values are correct"). Routes: `/chat`, `/chat/$threadId`. AI Elements: `bun x ai-elements@latest add conversation message prompt-input tool shimmer`.
- New routes: `/memory`, `/backtest`, `/bots`, `/chat`, `/chat/$threadId`.
- Dashboard: candlestick chart (`lightweight-charts`), demo/real toggle, market-mode tabs, confidence slider.

### What I need from you (4 quick answers)

1. **Auto-login**: OK with the dev-login button approach (#1 above)? Yes / No. yes
2. **Server-side autonomous loop**: this places real trades while you're offline. Confirm — and confirm it starts in **demo only** with a manual opt-in for real. yeah
3. **Chat history shape**: threaded conversations saved in database (recommended) — Yes / No. yes with their correct values
4. **Market modes**: just synthetic indices for now (V10/V25/1HZ10V/1HZ15V/1HZ25V), or also forex/crypto/commodities from the start? no synthetic is what we want but with their correct values   
  
summary now there is qwen demo for backtesting and there is real and there is dervi demo also   
multi option for chats line charts also line charts with a prediction also candle sticks and the rest check the src for devtybot and also the rest
5. &nbsp;

Once you answer these I'll execute the full slice — migration → backend → UI — in one go.
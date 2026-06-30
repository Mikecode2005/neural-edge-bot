# Neural Edge Bot — AI Trading Platform

Autonomous AI trading system for Deriv and MetaTrader 5 (MT5). Uses Qwen AI (via Hugging Face) for market analysis and trade execution.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env   # (or edit .env directly)

# Start development server
npm run dev
```

## MT5 Direct Integration

The MT5 Direct module (`src/mt5-direct/`) provides a trading interface for MetaTrader 5 via the `metatrader5-sdk` Node.js package.

### Setup

1. **Install the SDK** (already done):
   ```bash
   npm install metatrader5-sdk
   ```

2. **Configure credentials** in `.env`:
   ```
   MT5_ACCOUNT_LOGIN=12345678
   MT5_ACCOUNT_PASSWORD=your_mt5_password
   MT5_ACCOUNT_SERVER=Deriv-Server
   MT5_LIB_MODE=node-sdk
   ```

3. **Start the app** and navigate to **MT5 Direct** tab to connect and trade.

### Library Choice

- **Primary:** `metatrader5-sdk` (npm) — Wraps the MetaTrader 5 Web API in a clean Node.js interface without requiring the MT5 desktop terminal.
- **Fallback:** Python FastAPI bridge — Uses the native `MetaTrader5` Python package which requires the MT5 terminal installed on Windows. Set `MT5_LIB_MODE=python-bridge` and run:
  ```bash
  pip install MetaTrader5 fastapi uvicorn
  python -m hf_backend.app.mt5_bridge  # or your bridge entrypoint
  ```

### Architecture

```
src/mt5-direct/
├── client.ts          # Mt5Client class — Node SDK + Python bridge abstraction
├── types.ts           # Shared TypeScript interfaces
├── api.ts             # TanStack server functions (called from the UI)
├── metatrader5-sdk.d.ts  # Type declarations for the SDK
└── __tests__/
    └── mt5-client.test.ts  # Unit tests (mocking SDK)

src/render/backend/mt5-direct/
└── common.ts          # Shared helpers reused from backtest & bots logic
```

## Running Tests

```bash
# Unit tests (mocking SDK)
npx vitest run

# Integration tests (requires MT5 demo account — gated by MT5_INTEGRATION_TEST=true)
MT5_INTEGRATION_TEST=true npx vitest run src/mt5-direct/__tests__/mt5-integration.test.ts

# All tests
npx vitest run
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase anon key | Yes |
| `HF_TOKEN` | Hugging Face API token | For AI features |
| `DERIV_API_TOKEN` | Deriv API token | For Deriv trading |
| `MT5_ACCOUNT_LOGIN` | MT5 login ID | For MT5 Direct |
| `MT5_ACCOUNT_PASSWORD` | MT5 password | For MT5 Direct |
| `MT5_ACCOUNT_SERVER` | MT5 server address | For MT5 Direct |
| `MT5_LIB_MODE` | `node-sdk` or `python-bridge` | Optional (default: `node-sdk`) |

## Project Structure

```
src/
├── components/        # UI components (AppNav, ui/*)
├── routes/            # TanStack Router pages
│   └── _authenticated/
│       ├── bots.tsx      # Autonomous bot trading
│       ├── backtest.tsx  # Backtest engine
│       ├── mt5-direct.tsx # MT5 Direct trading page
│       └── ...
├── mt5-direct/        # MT5 Direct module
├── lib/               # Core libraries (Deriv WS, OB+FVG, AI, bots)
└── integrations/      # Supabase client
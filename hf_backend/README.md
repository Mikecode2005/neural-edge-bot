# AI Trading Backend — Hugging Face Space

Production FastAPI service hosting the AI trading engine.

## Components

| Module | Purpose |
|---|---|
| `app/main.py` | FastAPI app + all HTTP endpoints |
| `app/strategy_ob_fvg.py` | Order Block + Fair Value Gap detector |
| `app/prediction_engine.py` | Forecasting models (LSTM / XGBoost stubs + heuristic) |
| `app/qwen_reasoner.py` | Qwen 3 reasoning via HF Inference API |
| `app/deriv_client.py` | Deriv WebSocket API (ticks, candles, contracts) |
| `app/paper_trader.py` | Virtual-balance simulation engine |
| `app/risk.py` | Pre-trade risk gates |
| `app/supabase_client.py` | Writes predictions / trades / signals |
| `app/schemas.py` | Pydantic request/response models |

## Deploy to Hugging Face Space

1. Create a **Docker** Space (CPU basic is fine — Qwen runs via Inference API).
2. Push the contents of this `hf_backend/` folder as the Space root.
3. Add these **Space Secrets**:

   | Name | Value |
   |---|---|
   | `HF_TOKEN` | Your HF token (read access; for Inference API) |
   | `SUPABASE_URL` | `https://wlfldxrhbrwqqxlbfhxr.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | (from Lovable Cloud — server-only) |
   | `DERIV_APP_ID` | `1089` (public app_id for read-only data) |
   | `DERIV_API_TOKEN` | **Only for live trading.** Leave unset for demo. |
   | `QWEN_MODEL` | `Qwen/Qwen2.5-7B-Instruct` (or `Qwen/Qwen2.5-1.5B-Instruct` for lower cost) |
   | `ENCRYPTION_KEY` | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |

4. The Space exposes:

   ```
   GET  /health
   GET  /models
   GET  /portfolio?mode=demo
   GET  /history?mode=demo&limit=50
   GET  /performance?mode=demo
   GET  /confidence?symbol=R_10
   POST /predict          { symbol, timeframe }
   POST /reason           { symbol, indicators, prediction }
   POST /paper-trade      { symbol, side, size, sl, tp }
   POST /trade            { symbol, side, size, sl, tp }   # live (token required)
   POST /feedback         { prediction_id, rating, comment }
   POST /retrain-request  { model_name }
   ```

## Local dev

```bash
cd hf_backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill in
uvicorn app.main:app --reload --port 7860
```

## Security notes

- The Deriv API token is **never** sent to the browser. All trade requests pass through this backend.
- API connection tokens stored in `public.api_connections` are Fernet-encrypted with `ENCRYPTION_KEY`.
- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — only ever used server-side.
- Rotate `HF_TOKEN` and `DERIV_API_TOKEN` if either is ever exposed.

## First strategy: Order Block + Fair Value Gap

See `app/strategy_ob_fvg.py`. Logic:

1. Scan last N candles for 3-candle **FVG** patterns:
   - Bullish FVG: `candle[i-1].high < candle[i+1].low`
   - Bearish FVG: `candle[i-1].low  > candle[i+1].high`
2. Identify the **Order Block** = last opposite-color candle preceding the impulse that created the FVG.
3. When price retraces into the OB zone, emit a signal:
   - Entry = OB midpoint
   - SL = beyond the OB extreme + 1 ATR buffer
   - TP = next liquidity pool (recent swing high/low) or 2R
4. Qwen receives the structured market context and decides BUY / SELL / WAIT with reasoning.

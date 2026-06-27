"""
AI Trading Backend — FastAPI entry point.

Endpoints:
  GET  /health
  GET  /models
  GET  /portfolio?mode=demo
  GET  /history?mode=demo&limit=50
  GET  /performance?mode=demo
  GET  /confidence?symbol=R_10
  POST /predict
  POST /reason
  POST /paper-trade
  POST /trade           (live, requires DERIV_API_TOKEN)
  POST /feedback
  POST /retrain-request
"""
from __future__ import annotations
import logging
from typing import Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import supabase_client as sb
from .config import get_settings
from .deriv_client import DerivClient, DerivError
from .paper_trader import (open_paper_trade, close_paper_trade,
                           get_or_create_portfolio)
from .prediction_engine import ensemble, heuristic_forecast
from .qwen_reasoner import reason as qwen_reason
from .risk import validate_trade
from .schemas import (PredictRequest, ReasonRequest, PaperTradeRequest,
                      TradeRequest, TradeResponse, FeedbackRequest,
                      RetrainRequest, StrategySignal)
from .strategy_ob_fvg import generate_signal

log = logging.getLogger("uvicorn.error")
settings = get_settings()

app = FastAPI(title="AI Trading Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------------- system ------------------------------------------

@app.get("/health")
async def health():
    return {
        "ok": True,
        "qwen_configured": bool(settings.HF_TOKEN),
        "supabase_configured": bool(sb.sb()),
        "deriv_live_enabled": bool(settings.DERIV_API_TOKEN),
        "model": settings.QWEN_MODEL,
    }


@app.get("/models")
async def models():
    return {
        "reasoner": settings.QWEN_MODEL,
        "forecasters": ["heuristic-momentum-v1", "lstm-stub", "xgboost-stub",
                        "ensemble-v1"],
        "strategies": ["ob_fvg"],
    }


# -------------------------- portfolio / history ------------------------------

@app.get("/portfolio")
async def portfolio(mode: str = "demo"):
    return await get_or_create_portfolio(None, mode)


@app.get("/history")
async def history(mode: str = "demo", limit: int = 50):
    return sb.select("trade_history", eq={"mode": mode},
                     order="opened_at", desc=True, limit=limit)


@app.get("/performance")
async def performance(mode: str = "demo"):
    trades = sb.select("trade_history", eq={"mode": mode, "status": "closed"},
                       order="closed_at", desc=True, limit=500)
    if not trades:
        return {"total_trades": 0, "win_rate": 0, "total_pnl": 0,
                "profit_factor": 0}
    wins = [t for t in trades if (t.get("pnl") or 0) > 0]
    losses = [t for t in trades if (t.get("pnl") or 0) < 0]
    gross_win = sum(t["pnl"] for t in wins) or 0.0
    gross_loss = abs(sum(t["pnl"] for t in losses)) or 1e-9
    return {
        "total_trades": len(trades),
        "winning_trades": len(wins),
        "losing_trades": len(losses),
        "win_rate": len(wins) / len(trades),
        "total_pnl": sum(t["pnl"] or 0 for t in trades),
        "profit_factor": gross_win / gross_loss,
    }


@app.get("/confidence")
async def confidence(symbol: str = "R_10"):
    rows = sb.select("predictions", eq={"symbol": symbol},
                     order="created_at", desc=True, limit=20)
    if not rows:
        return {"symbol": symbol, "avg_confidence": 0, "samples": 0}
    avg = sum(float(r.get("confidence") or 0) for r in rows) / len(rows)
    return {"symbol": symbol, "avg_confidence": avg, "samples": len(rows)}


# -------------------------- core AI loop ------------------------------------

@app.post("/predict", response_model=StrategySignal)
async def predict(req: PredictRequest):
    """Run OB+FVG strategy on latest Deriv candles and emit a signal."""
    granularity = _granularity_seconds(req.timeframe)
    client = DerivClient()
    try:
        candles = await client.candles(req.symbol, granularity=granularity,
                                       count=req.lookback)
    except DerivError as e:
        raise HTTPException(502, f"Deriv error: {e}")

    signal = generate_signal(req.symbol, req.timeframe, candles)
    forecast = ensemble(candles)

    # persist
    pred = sb.insert("predictions", {
        "symbol": req.symbol,
        "timeframe": req.timeframe,
        "decision": signal.decision,
        "confidence": round(signal.confidence, 3),
        "risk_score": round(1 - signal.confidence, 3),
        "success_probability": round(signal.confidence, 3),
        "reasoning": signal.rationale,
        "trade_plan": {"entry": signal.entry, "sl": signal.sl, "tp": signal.tp},
        "indicators": signal.indicators,
        "market_state": {"forecast": forecast},
        "suggested_entry": signal.entry,
        "suggested_sl": signal.sl,
        "suggested_tp": signal.tp,
        "model_version": "ob_fvg-v1",
    })
    sb.insert("live_signals", {
        "symbol": req.symbol,
        "decision": signal.decision,
        "confidence": round(signal.confidence, 3),
        "price": signal.price,
        "ob_zone": signal.ob.model_dump() if signal.ob else None,
        "fvg_zone": signal.fvg.model_dump() if signal.fvg else None,
        "reasoning": signal.rationale,
    })
    return signal


@app.post("/reason")
async def reason_endpoint(req: ReasonRequest):
    return await qwen_reason(req.symbol, req.timeframe,
                             req.indicators, req.prediction, req.market_state)


# -------------------------- trading ------------------------------------------

@app.post("/paper-trade", response_model=TradeResponse)
async def paper_trade(req: PaperTradeRequest):
    client = DerivClient()
    tick = await client.tick(req.symbol)
    price = float(tick.get("quote") or 0)
    if not price:
        raise HTTPException(502, "Could not fetch current price")

    pf = await get_or_create_portfolio(None, "demo")
    check = validate_trade(
        balance=float(pf.get("balance") or 0),
        open_positions=int(pf.get("open_positions") or 0),
        today_pnl=float(pf.get("realized_pnl") or 0),
        trade_size=req.size,
        confidence=0.7,  # passed when called from /predict; user override OK
        max_daily_loss=settings.MAX_DAILY_LOSS_DEFAULT,
        max_open_trades=settings.MAX_OPEN_TRADES_DEFAULT,
        risk_percent=2.0,
    )
    if not check.ok:
        return TradeResponse(ok=False, message=check.reason or "Rejected")

    row = await open_paper_trade(req, current_price=price)
    return TradeResponse(ok=True, trade_id=row.get("id"),
                         message="Paper trade opened")


@app.post("/trade", response_model=TradeResponse)
async def live_trade(req: TradeRequest):
    if not settings.DERIV_API_TOKEN:
        raise HTTPException(403,
            "Live trading disabled: set DERIV_API_TOKEN in Space secrets.")
    client = DerivClient(token=settings.DERIV_API_TOKEN)
    contract_type = "CALL" if req.side == "BUY" else "PUT"
    try:
        buy = await client.buy_contract(
            symbol=req.symbol, contract_type=contract_type,
            amount=req.size, duration=5, duration_unit="m",
        )
    except DerivError as e:
        raise HTTPException(502, f"Deriv: {e}")
    row = sb.insert("trade_history", {
        "mode": "live",
        "symbol": req.symbol,
        "side": req.side,
        "entry_price": float(buy.get("buy_price") or 0),
        "size": req.size,
        "stop_loss": req.sl,
        "take_profit": req.tp,
        "status": "open",
        "deriv_contract_id": str(buy.get("contract_id") or ""),
        "prediction_id": req.prediction_id,
    })
    return TradeResponse(ok=True, trade_id=(row or {}).get("id"),
                         contract_id=str(buy.get("contract_id") or ""),
                         message="Live contract bought")


# -------------------------- feedback / retrain -------------------------------

@app.post("/feedback")
async def feedback(req: FeedbackRequest):
    sb.insert("feedback", req.model_dump())
    return {"ok": True}


@app.post("/retrain-request")
async def retrain(req: RetrainRequest):
    sb.insert("logs", {
        "level": "info", "source": "retrain",
        "message": f"Retrain requested for {req.model_name}",
        "meta": req.model_dump(),
    })
    return {"ok": True, "queued": True}


# -------------------------- helpers ------------------------------------------

def _granularity_seconds(tf: str) -> int:
    table = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800,
             "1h": 3600, "4h": 14400, "1d": 86400}
    return table.get(tf, 60)

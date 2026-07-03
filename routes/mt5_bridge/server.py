"""MT5 Bridge — Refactored FastAPI server using the Execution Engine.

This bridge provides a REST API for MT5 trading operations. It uses the
MT5ExecutionEngine which handles all broker-specific details automatically.

Architecture:
    Frontend → FastAPI → ExecutionEngine → MT5

The AI/frontend only needs to specify:
    - symbol
    - side (buy/sell)
    - volume
    - sl (optional)
    - tp (optional)

The execution engine handles:
    - symbol validation
    - price selection (BUY=ask, SELL=bid)
    - stop validation & adjustment
    - filling mode detection
    - volume normalization
    - order checking
    - retries
    - broker compatibility

Usage:
    python -m routes.mt5_bridge.server
    uvicorn routes.mt5_bridge.server:app --host 0.0.0.0 --port 8765
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from typing import Any, Optional
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from fastapi import BackgroundTasks
from uuid import uuid4

env_path = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(env_path)

log = logging.getLogger("uvicorn.error")

app = FastAPI(title="MT5 Bridge (Refactored)", version="2.0.0", docs_url="/docs")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global engine instance (lazy-initialized via /initialize)
_engine: Optional[Any] = None

# Simple in-memory bot registry
_mt5_bots: dict = {}


# ── Internal helpers ──

def _import_mt5():
    """Lazy-import MetaTrader5 so the module loads without MT5 installed."""
    try:
        import MetaTrader5 as mt5
        return mt5
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="MetaTrader5 Python package is not installed. Run: pip install MetaTrader5. "
                   "This package requires the MT5 terminal to be installed on Windows.",
        )


def _get_engine():
    """Get the global execution engine, raising if not initialized."""
    global _engine
    if _engine is None:
        raise HTTPException(status_code=400, detail="MT5 not initialized. Call /initialize first.")
    return _engine


def _tf_to_mt5(timeframe: str) -> Any:
    mt5 = _import_mt5()
    mapping = {
        "1m": mt5.TIMEFRAME_M1,
        "5m": mt5.TIMEFRAME_M5,
        "15m": mt5.TIMEFRAME_M15,
        "30m": mt5.TIMEFRAME_M30,
        "1h": mt5.TIMEFRAME_H1,
        "4h": mt5.TIMEFRAME_H4,
        "1d": mt5.TIMEFRAME_D1,
    }
    tf = mapping.get(timeframe)
    if tf is None:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {timeframe}")
    return tf


def _mt5_rate_to_dict(rate: Any) -> dict:
    """Convert an MT5 rate to a dict (numpy-safe)."""
    def _get(field: str):
        if hasattr(rate, field):
            return getattr(rate, field)
        try:
            return rate[field]
        except Exception:
            try:
                names = getattr(rate.dtype, "names", None)
                if names and field in names:
                    return rate[field]
            except Exception:
                return None
        return None

    def _to_native(val: Any) -> Any:
        if val is None:
            return 0
        try:
            if hasattr(val, "item"):
                return val.item()
            return float(val)
        except Exception:
            return val

    t = _get("time")
    return {
        "time": int(_to_native(t)) if t is not None else 0,
        "open": float(_to_native(_get("open"))) or 0.0,
        "high": float(_to_native(_get("high"))) or 0.0,
        "low": float(_to_native(_get("low"))) or 0.0,
        "close": float(_to_native(_get("close"))) or 0.0,
        "tickVolume": int(_to_native(_get("tick_volume"))) or int(_to_native(_get("tickVolume"))) or 0,
        "realVolume": int(_to_native(_get("real_volume"))) or int(_to_native(_get("realVolume"))) or 0,
        "spread": int(_to_native(_get("spread"))) or 0,
    }


# ── Pydantic models ──

class Credentials(BaseModel):
    login: int
    password: str
    server: str


class OrderRequest(BaseModel):
    """Simple order request from the AI/frontend.

    The AI only needs to specify:
    - symbol
    - type (buy/sell)
    - volume
    - sl (optional)
    - tp (optional)

    The execution engine handles all MT5-specific details.
    """
    symbol: str
    type: str  # "buy" | "sell"
    volume: float
    sl: Optional[float] = 0.0
    tp: Optional[float] = 0.0
    comment: Optional[str] = ""
    magic: Optional[int] = 0
    deviation: Optional[int] = 20


class CloseRequest(BaseModel):
    ticket: int


class ClosePartialRequest(BaseModel):
    ticket: int
    volume: float


class ModifyRequest(BaseModel):
    ticket: int
    sl: Optional[float] = 0.0
    tp: Optional[float] = 0.0


class RatesRequest(BaseModel):
    symbol: str
    timeframe: str  # "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d"
    count: int = 100


class SymbolRequest(BaseModel):
    symbol: str


class ValidateRequest(BaseModel):
    symbol: str
    type: str  # "buy" | "sell"
    volume: float
    sl: Optional[float] = 0.0
    tp: Optional[float] = 0.0


# ── Health & Status ──

@app.get("/health")
async def health():
    connected = _engine is not None and _engine.is_connected()
    return {"status": "ok", "mt5_initialized": connected}


@app.get("/status")
async def status():
    engine = _get_engine()
    account = engine.get_account()
    if account is None:
        return {"connected": False, "error": "Terminal disconnected"}
    return {"connected": True, "account": account}


# ── Initialization ──

@app.post("/initialize")
async def initialize(creds: Optional[Credentials] = None):
    global _engine

    mt5 = _import_mt5()

    # Import and create engine
    from .execution_engine import MT5ExecutionEngine
    _engine = MT5ExecutionEngine(mt5)

    if creds:
        result = _engine.connect(creds.login, creds.password, creds.server)
        if not result["success"]:
            _engine = None
            raise HTTPException(status_code=401, detail=result.get("error", "Login failed"))
        log.info(f"MT5 initialized and logged in as {creds.login}@{creds.server}")
        return {"status": "ok", "login": creds.login, "server": creds.server}
    else:
        result = _engine.connect()
        if not result["success"]:
            _engine = None
            raise HTTPException(status_code=500, detail=result.get("error", "Initialize failed"))
        log.info("MT5 initialized (no login)")
        return {"status": "ok", "login": 0, "server": ""}


@app.post("/shutdown")
async def shutdown():
    global _engine, _mt5_bots
    if _engine is not None:
        _engine.disconnect()
    _engine = None
    _mt5_bots.clear()
    return {"status": "ok"}


# ── Account ──

@app.get("/account-info")
async def account_info():
    engine = _get_engine()
    account = engine.get_account()
    if account is None:
        raise HTTPException(status_code=500, detail="Failed to get account info")
    return account


# ── Symbols ──

@app.post("/symbol-info")
async def symbol_info(req: SymbolRequest):
    engine = _get_engine()
    info = engine.get_symbol(req.symbol)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Symbol '{req.symbol}' not found")
    return info


@app.post("/symbol-tick")
async def symbol_tick(req: SymbolRequest):
    """Get the latest tick for a symbol."""
    engine = _get_engine()
    spec = engine.get_symbol(req.symbol)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Symbol '{req.symbol}' not found")
    return {
        "time": int(datetime.now().timestamp()),
        "bid": spec.get("bid", 0),
        "ask": spec.get("ask", 0),
        "last": 0,
        "volume": 0,
    }


@app.post("/symbol-filling")
async def symbol_filling(req: SymbolRequest):
    """Get supported filling modes for a symbol."""
    engine = _get_engine()
    modes = engine.get_supported_filling(req.symbol)
    return {"symbol": req.symbol, "supportedFillingModes": modes}


# ── Order Execution ──

@app.post("/order-send")
async def order_send(req: OrderRequest):
    """Execute a trade order.

    The AI/frontend provides simple parameters. The execution engine handles
    all MT5-specific details including price selection, stop validation,
    filling mode detection, and retries.
    """
    engine = _get_engine()

    from .execution_engine import TradeRequest

    trade_req = TradeRequest(
        symbol=req.symbol,
        side=req.type,
        volume=req.volume,
        sl=req.sl or 0.0,
        tp=req.tp or 0.0,
        comment=req.comment or "",
        magic=req.magic or 0,
        deviation=req.deviation or 20,
    )

    result = engine.send_order(trade_req)

    if result.success:
        return result.to_dict()
    else:
        # Convert to HTTP exception
        from .error_codes import retcode_to_http_exception
        error_info = retcode_to_http_exception(result.retcode, result.message)
        raise HTTPException(
            status_code=error_info.get("status_code", 400),
            detail=error_info.get("detail", result.message),
        )


@app.post("/order-validate")
async def order_validate(req: ValidateRequest):
    """Validate a trade request without executing it.

    Returns detailed information about the trade including valid SL/TP levels.
    """
    engine = _get_engine()
    validation = engine.validate_trade(
        symbol=req.symbol,
        side=req.type,
        volume=req.volume,
        sl=req.sl or 0.0,
        tp=req.tp or 0.0,
    )
    return validation


# ── Positions ──

@app.get("/positions")
async def positions(symbol: str = ""):
    engine = _get_engine()
    return engine.positions(symbol)


@app.post("/positions-close")
async def positions_close(req: CloseRequest):
    engine = _get_engine()
    result = engine.close_position(req.ticket)
    if result.success:
        return result.to_dict()
    raise HTTPException(
        status_code=400,
        detail=f"Close failed (retcode={result.retcode}): {result.message}",
    )


@app.post("/positions-close-partial")
async def positions_close_partial(req: ClosePartialRequest):
    engine = _get_engine()
    result = engine.close_partial(req.ticket, req.volume)
    if result.success:
        return result.to_dict()
    raise HTTPException(
        status_code=400,
        detail=f"Partial close failed (retcode={result.retcode}): {result.message}",
    )


@app.post("/positions-modify")
async def positions_modify(req: ModifyRequest):
    engine = _get_engine()
    result = engine.modify_position(req.ticket, req.sl or 0.0, req.tp or 0.0)
    if result.success:
        return result.to_dict()
    raise HTTPException(
        status_code=400,
        detail=f"Modify failed (retcode={result.retcode}): {result.message}",
    )


# ── Rates ──

@app.post("/rates")
async def rates(req: RatesRequest):
    from .execution_engine import TRADE_RETCODE_CODES

    if _engine is None or not _engine.is_connected():
        raise HTTPException(status_code=400, detail="MT5 not initialized. Call /initialize first.")

    mt5 = _import_mt5()
    tf = _tf_to_mt5(req.timeframe)
    try:
        rates_data = mt5.copy_rates_from_pos(req.symbol, tf, 0, req.count)
        log.info(f"rates_data type={type(rates_data)} len={len(rates_data) if rates_data is not None else 'None'}")
        if rates_data is None or len(rates_data) == 0:
            return []
        out = []
        for r in rates_data:
            try:
                out.append(_mt5_rate_to_dict(r))
            except Exception as e:
                try:
                    preview = repr(r)[:200]
                except Exception:
                    preview = "<unrepresentable>"
                out.append({"error": str(e), "type": str(type(r)), "repr": preview})
        return out
    except Exception as e:
        log.exception("Rates fetch failed")
        raise HTTPException(status_code=500, detail=f"Rates error: {e}")


# ── History ──

@app.get("/history")
async def history(from_date: int = 0, to_date: int = 0):
    engine = _get_engine()
    return engine.history(from_date, to_date)


# ── Orders (pending) ──

@app.get("/orders")
async def orders():
    engine = _get_engine()
    return engine.orders()


# ── Tunnel control (ngrok) ──

class TunnelRegister(BaseModel):
    public_url: str


_tunnel_url: Optional[str] = None


@app.post("/tunnel/register")
async def tunnel_register(reg: TunnelRegister):
    global _tunnel_url
    _tunnel_url = reg.public_url
    log.info(f"Tunnel registered: {_tunnel_url}")
    return {"ok": True, "url": _tunnel_url}


@app.get("/tunnel/info")
async def tunnel_info():
    return {"url": _tunnel_url}


@app.post("/tunnel/start")
async def tunnel_start():
    global _tunnel_url
    try:
        from pyngrok import ngrok, conf
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"pyngrok not available: {e}")
    token = os.getenv("NGROK_AUTH_TOKEN")
    if token:
        conf.get_default().auth_token = token
    try:
        port = int(os.getenv("MT5_BRIDGE_PORT", "8765"))
        http_tunnel = ngrok.connect(port, "http")
        _tunnel_url = http_tunnel.public_url
        log.info(f"ngrok tunnel started: {_tunnel_url}")
        return {"ok": True, "url": _tunnel_url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start ngrok: {e}")


@app.post("/tunnel/stop")
async def tunnel_stop():
    global _tunnel_url
    try:
        from pyngrok import ngrok
        ngrok.kill()
    except Exception:
        pass
    _tunnel_url = None
    return {"ok": True}


# ── Lightweight bot endpoints (in-memory) ──

class BotStartRequest(BaseModel):
    symbol: str
    timeframe: str = "1m"
    interval_seconds: int = 60
    enable_trading: bool = False


def _create_bot_entry(symbol: str, timeframe: str, interval_seconds: int, enable_trading: bool):
    bot_id = str(uuid4())
    return {
        "id": bot_id,
        "symbol": symbol,
        "timeframe": timeframe,
        "interval_seconds": interval_seconds,
        "enable_trading": enable_trading,
        "status": "running",
        "last_loop_at": None,
        "activity": [],
        "task": None,
    }


async def _bot_loop(bot_id: str):
    global _mt5_bots, _engine
    bot = _mt5_bots.get(bot_id)
    if not bot:
        return
    symbol = bot["symbol"]
    tf = bot["timeframe"]
    interval = bot["interval_seconds"]

    # Get engine once
    if _engine is None:
        return

    while bot["status"] == "running":
        try:
            mt5 = _import_mt5()
            rates = mt5.copy_rates_from_pos(symbol, _tf_to_mt5(tf), 0, 3)
            if not rates:
                closes = []
            else:
                rates_list = [_mt5_rate_to_dict(r) for r in rates]
                closes = [r.get("close", 0.0) for r in rates_list]
            ts = int(datetime.now(tz=timezone.utc).timestamp())
            decision = "scan"
            details = {}
            if len(closes) >= 2:
                if closes[-1] > closes[-2]:
                    decision = "bullish_scan"
                elif closes[-1] < closes[-2]:
                    decision = "bearish_scan"
                details = {"last_close": closes[-1], "prev_close": closes[-2]}
            entry = {"timestamp": ts, "action": decision, "details": details}
            bot["activity"].insert(0, entry)
            bot["last_loop_at"] = datetime.now(timezone.utc).isoformat()

            if bot.get("enable_trading") and _engine is not None:
                try:
                    from .execution_engine import TradeRequest
                    trade_req = TradeRequest(
                        symbol=symbol,
                        side="buy" if decision == "bullish_scan" else "sell",
                        volume=0.01,
                    )
                    result = _engine.send_order(trade_req)
                    bot["activity"].insert(0, {
                        "timestamp": int(datetime.now(timezone.utc).timestamp()),
                        "action": "order_sent",
                        "result": result.to_dict(),
                    })
                except Exception as e:
                    bot["activity"].insert(0, {
                        "timestamp": int(datetime.now(timezone.utc).timestamp()),
                        "action": "order_error",
                        "error": str(e),
                    })
        except Exception as e:
            bot["activity"].insert(0, {
                "timestamp": int(datetime.now(timezone.utc).timestamp()),
                "action": "error",
                "error": str(e),
            })
        await asyncio.sleep(interval)


@app.post("/bot/start")
async def bot_start(req: BotStartRequest, background: BackgroundTasks):
    global _mt5_bots
    bot = _create_bot_entry(req.symbol, req.timeframe, req.interval_seconds, req.enable_trading)
    _mt5_bots[bot["id"]] = bot
    task = asyncio.create_task(_bot_loop(bot["id"]))
    bot["task"] = task
    return {"ok": True, "bot": {k: v for k, v in bot.items() if k != "task"}}


@app.post("/bot/stop")
async def bot_stop(data: dict):
    global _mt5_bots
    bot_id = data.get("id")
    bot = _mt5_bots.get(bot_id)
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found")
    bot["status"] = "stopped"
    t = bot.get("task")
    if t and not t.done():
        t.cancel()
    return {"ok": True}


@app.get("/bot/list")
async def bot_list():
    return [{k: v for k, v in b.items() if k != "task"} for b in _mt5_bots.values()]


@app.get("/bot/activity")
async def bot_activity(bot_id: str):
    bot = _mt5_bots.get(bot_id)
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found")
    return bot.get("activity", [])


@app.get("/bot/open-positions")
async def bot_open_positions(bot_id: str):
    engine = _get_engine()
    bot = _mt5_bots.get(bot_id)
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found")
    return engine.positions(bot["symbol"])


@app.post("/bot/tick")
async def bot_tick(data: dict):
    bot_id = data.get("id")
    bot = _mt5_bots.get(bot_id)
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found")
    await _bot_loop(bot_id)
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO)
    port = int(os.getenv("MT5_BRIDGE_PORT", "8765"))
    host = os.getenv("MT5_BRIDGE_HOST", "0.0.0.0")
    log.info(f"Starting MT5 Bridge v2 on {host}:{port}...")
    uvicorn.run(app, host=host, port=port, log_level="info")
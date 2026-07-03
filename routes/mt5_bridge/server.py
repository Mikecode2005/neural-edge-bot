"""MT5 Bridge — FastAPI server that wraps the native MetaTrader5 Python package.

This bridge provides a REST API for MT5 trading operations. It requires the MT5
terminal installed on Windows (MetaTrader5 Python package dependency).

Usage:
    python -m routes.mt5_bridge.server
    uvicorn routes.mt5_bridge.server:app --host 0.0.0.0 --port 8765

For Render deployment, point MT5_BRIDGE_URL in the frontend to the Render service URL.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from typing import Any, Optional, Union
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

app = FastAPI(title="MT5 Bridge", version="1.0.0", docs_url="/docs")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global MT5 state
_mt5_initialized = False
_mt5_login = 0
_mt5_server = ""
_tunnel_url: Optional[str] = None

# Simple in-memory bot registry for lightweight automation/control from frontend
_mt5_bots: dict = {}




# ── Pydantic models ──

class Credentials(BaseModel):
    login: int
    password: str
    server: str


class OrderRequest(BaseModel):
    symbol: str
    type: str  # "buy" | "sell"
    volume: float
    price: Optional[float] = 0.0
    sl: Optional[float] = 0.0
    tp: Optional[float] = 0.0
    comment: Optional[str] = ""
    magic: Optional[int] = 0
    deviation: Optional[int] = 20
    type_filling: Optional[Union[str, int]] = Field("ioc", alias="typeFilling")

    class Config:
        allow_population_by_field_name = True


class CloseRequest(BaseModel):
    ticket: int


class RatesRequest(BaseModel):
    symbol: str
    timeframe: str  # "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d"
    count: int = 100


class SymbolRequest(BaseModel):
    symbol: str


# ── MT5 wrapper (lazy import so the module loads without MT5 installed) ──

def _import_mt5():
    try:
        import MetaTrader5 as mt5
        return mt5
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="MetaTrader5 Python package is not installed. Run: pip install MetaTrader5. "
                   "This package requires the MT5 terminal to be installed on Windows.",
        )


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


def _order_type_to_mt5(type_str: str) -> int:
    mt5 = _import_mt5()
    return mt5.ORDER_TYPE_BUY if type_str == "buy" else mt5.ORDER_TYPE_SELL


def _mt5_account_to_dict(account_info: Any) -> dict:
    return {
        "login": account_info.login,
        "balance": account_info.balance,
        "equity": account_info.equity,
        "margin": account_info.margin,
        "marginFree": account_info.margin_free,
        "marginLevel": account_info.margin_level,
        "currency": account_info.currency,
        "server": account_info.server,
        "name": account_info.name,
        "company": account_info.company,
        "leverage": account_info.leverage,
    }


def _mt5_position_to_dict(pos: Any) -> dict:
    return {
        "ticket": pos.ticket,
        "symbol": pos.symbol,
        "type": "buy" if pos.type == 0 else "sell",
        "volume": pos.volume,
        "priceOpen": pos.price_open,
        "priceCurrent": pos.price_current,
        "sl": pos.sl,
        "tp": pos.tp,
        "profit": pos.profit,
        "swap": pos.swap,
        "comment": pos.comment,
        "magic": pos.magic,
        "time": int(pos.time),
    }


def _mt5_order_result_to_dict(result: Any) -> dict:
    return {
        "retcode": result.retcode,
        "ticket": result.order if hasattr(result, "order") else getattr(result, "ticket", 0),
        "volume": result.volume,
        "price": result.price,
        "comment": result.comment,
    }


def _mt5_rate_to_dict(rate: Any) -> dict:
    # Support numpy.void records and objects with attributes
    def _get(field: str):
        if hasattr(rate, field):
            return getattr(rate, field)
        try:
            return rate[field]
        except Exception:
            try:
                # numpy structured array may expose fields via names
                names = getattr(rate.dtype, "names", None)
                if names and field in names:
                    return rate[field]
            except Exception:
                return None
        return None

    def _to_native(val: Any) -> Any:
        """Convert numpy scalars to native Python types for JSON serialization."""
        if val is None:
            return 0
        try:
            # Handle numpy integer types (int64, uint64, etc.)
            if hasattr(val, "item"):
                return val.item()
            # Handle numpy floats
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


def _mt5_symbol_to_dict(info: Any) -> dict:
    trade_mode_map = {0: "disabled", 1: "enabled", 2: "closeonly", 3: "longonly", 4: "shortonly"}
    return {
        "symbol": info.name,
        "digits": info.digits,
        "point": info.point,
        "spread": info.spread,
        "bid": info.bid,
        "ask": info.ask,
        "volumeMin": info.volume_min,
        "volumeMax": info.volume_max,
        "volumeStep": info.volume_step,
        "tradeMode": trade_mode_map.get(info.trade_mode, "unknown"),
        "description": info.description,
        "path": info.path,
        "marginInitial": info.margin_initial,
        "marginMaintenance": info.margin_maintenance,
    }


@app.get("/health")
async def health():
    return {"status": "ok", "mt5_initialized": _mt5_initialized, "login": _mt5_login, "server": _mt5_server}


@app.get("/status")
async def status():
    if not _mt5_initialized:
        return {"connected": False, "error": "Not initialized"}
    mt5 = _import_mt5()
    info = mt5.account_info()
    if info is None:
        return {"connected": False, "error": "Terminal disconnected"}
    return {"connected": True, "account": _mt5_account_to_dict(info)}


@app.post("/initialize")
async def initialize(creds: Optional[Credentials] = None):
    global _mt5_initialized, _mt5_login, _mt5_server

    mt5 = _import_mt5()

    if _mt5_initialized:
        mt5.shutdown()
        _mt5_initialized = False

    initialized = mt5.initialize()
    if not initialized:
        error = mt5.last_error()
        raise HTTPException(
            status_code=500,
            detail=f"MT5 initialize() failed: {error or 'Unknown error'}. Ensure MT5 terminal is installed and not already running."
        )

    _mt5_initialized = True

    if creds:
        authorized = mt5.login(creds.login, password=creds.password, server=creds.server)
        if not authorized:
            error = mt5.last_error()
            mt5.shutdown()
            _mt5_initialized = False
            raise HTTPException(
                status_code=401,
                detail=f"MT5 login failed for {creds.login}@{creds.server}: {error or 'Invalid credentials'}"
            )
        _mt5_login = creds.login
        _mt5_server = creds.server
        log.info(f"MT5 initialized and logged in as {creds.login}@{creds.server}")
    else:
        _mt5_login = 0
        _mt5_server = ""
        log.info("MT5 initialized (no login credentials provided)")

    return {"status": "ok", "login": _mt5_login, "server": _mt5_server}


@app.post("/shutdown")
async def shutdown():
    global _mt5_initialized, _mt5_login, _mt5_server
    if _mt5_initialized:
        mt5 = _import_mt5()
        mt5.shutdown()
    _mt5_initialized = False
    _mt5_login = 0
    _mt5_server = ""
    return {"status": "ok"}


@app.get("/account-info")
async def account_info():
    if not _mt5_initialized:
        raise HTTPException(status_code=400, detail="MT5 not initialized. Call /initialize first.")
    mt5 = _import_mt5()
    info = mt5.account_info()
    if info is None:
        raise HTTPException(status_code=500, detail="Failed to get account info")
    return _mt5_account_to_dict(info)


@app.get("/positions")
async def positions():
    if not _mt5_initialized:
        raise HTTPException(status_code=400, detail="MT5 not initialized.")
    mt5 = _import_mt5()
    pos_list = mt5.positions_get()
    if pos_list is None:
        return []
    return [_mt5_position_to_dict(p) for p in pos_list]


@app.post("/order-send")
async def order_send(req: OrderRequest):
    if not _mt5_initialized:
        raise HTTPException(status_code=400, detail="MT5 not initialized.")
    mt5 = _import_mt5()
    order_type = _order_type_to_mt5(req.type)
    
    # Get symbol info to check allowed filling modes
    symbol_info = mt5.symbol_info(req.symbol)
    if symbol_info is None:
        raise HTTPException(status_code=400, detail=f"Symbol {req.symbol} not found")
    
    # Map filling mode from string or integer input to broker constants
    if isinstance(req.type_filling, int):
        if req.type_filling == 0:
            filling_mode = mt5.ORDER_FILLING_FOK
        elif req.type_filling == 2:
            filling_mode = mt5.ORDER_FILLING_RETURN
        else:
            filling_mode = mt5.ORDER_FILLING_IOC
    else:
        mode = (req.type_filling or "ioc").lower()
        if mode == "fok":
            filling_mode = mt5.ORDER_FILLING_FOK
        elif mode == "return":
            filling_mode = mt5.ORDER_FILLING_RETURN
        else:
            filling_mode = mt5.ORDER_FILLING_IOC
    
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": req.symbol,
        "volume": req.volume,
        "type": order_type,
        "price": req.price if req.price and req.price > 0 else 0.0,
        "sl": req.sl or 0.0,
        "tp": req.tp or 0.0,
        "deviation": req.deviation or 20,
        "magic": req.magic or 0,
        "comment": req.comment or "",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode,
    }
    if not request["price"] or request["price"] == 0.0:
        tick = mt5.symbol_info_tick(req.symbol)
        if tick is None:
            raise HTTPException(status_code=400, detail=f"Cannot get tick for {req.symbol}")
        request["price"] = tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid

    def _try_send(req_body: dict) -> Any:
        res = mt5.order_send(req_body)
        if res is None:
            return None
        return res

    result = _try_send(request)
    if result is None:
        err = mt5.last_error()
        raise HTTPException(status_code=500, detail=f"Order send failed: {err}")

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        # Try all fallback filling modes
        initial_mode = request["type_filling"]
        fallback_modes = []
        if initial_mode != mt5.ORDER_FILLING_FOK:
            fallback_modes.append(mt5.ORDER_FILLING_FOK)
        if initial_mode != mt5.ORDER_FILLING_IOC:
            fallback_modes.append(mt5.ORDER_FILLING_IOC)
        if initial_mode != mt5.ORDER_FILLING_RETURN:
            fallback_modes.append(mt5.ORDER_FILLING_RETURN)

        for fallback in fallback_modes:
            request["type_filling"] = fallback
            result = _try_send(request)
            if result is None:
                continue
            if result.retcode == mt5.TRADE_RETCODE_DONE:
                break

        if result is None:
            err = mt5.last_error()
            raise HTTPException(status_code=500, detail=f"Order send failed: {err}")
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            # Last chance without explicit type_filling
            request.pop("type_filling", None)
            result = _try_send(request)
            if result is not None and result.retcode == mt5.TRADE_RETCODE_DONE:
                return _mt5_order_result_to_dict(result)
            if result is None:
                err = mt5.last_error()
                raise HTTPException(status_code=500, detail=f"Order send failed: {err}")
            raise HTTPException(status_code=400, detail=f"Order rejected (retcode={result.retcode}): {result.comment}")

    return _mt5_order_result_to_dict(result)


@app.post("/positions-close")
async def positions_close(req: CloseRequest):
    if not _mt5_initialized:
        raise HTTPException(status_code=400, detail="MT5 not initialized.")
    mt5 = _import_mt5()
    pos_list = mt5.positions_get(ticket=req.ticket)
    if pos_list is None or len(pos_list) == 0:
        raise HTTPException(status_code=404, detail=f"Position #{req.ticket} not found")
    position = pos_list[0]
    tick = mt5.symbol_info_tick(position.symbol)
    if tick is None:
        raise HTTPException(status_code=400, detail=f"Cannot get tick for {position.symbol}")
    close_type = mt5.ORDER_TYPE_SELL if position.type == 0 else mt5.ORDER_TYPE_BUY
    close_price = tick.bid if position.type == 0 else tick.ask
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": position.symbol,
        "volume": position.volume,
        "type": close_type,
        "position": req.ticket,
        "price": close_price,
        "deviation": 20,
        "magic": position.magic,
        "comment": "Closed by MT5 Bridge",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    if result is None:
        err = mt5.last_error()
        raise HTTPException(status_code=500, detail=f"Close failed: {err}")
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(status_code=400, detail=f"Close rejected (retcode={result.retcode}): {result.comment}")
    return _mt5_order_result_to_dict(result)


@app.post("/rates")
async def rates(req: RatesRequest):
    if not _mt5_initialized:
        raise HTTPException(status_code=400, detail="MT5 not initialized.")
    mt5 = _import_mt5()
    tf = _tf_to_mt5(req.timeframe)
    try:
        rates_data = mt5.copy_rates_from_pos(req.symbol, tf, 0, req.count)
        log.info(f"rates_data type={type(rates_data)} len={len(rates_data) if rates_data is not None else 'None'}")
        if rates_data is not None and len(rates_data) > 0:
            first = rates_data[0]
            try:
                log.info(f"first rate type={type(first)} repr={repr(first)[:200]}")
            except Exception:
                log.info("first rate repr unavailable")
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


@app.post("/symbol-info")
async def symbol_info(req: SymbolRequest):
    if not _mt5_initialized:
        raise HTTPException(status_code=400, detail="MT5 not initialized.")
    mt5 = _import_mt5()
    info = mt5.symbol_info(req.symbol)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Symbol '{req.symbol}' not found")
    return _mt5_symbol_to_dict(info)


@app.post("/symbol-tick")
async def symbol_tick(req: SymbolRequest):
    if not _mt5_initialized:
        raise HTTPException(status_code=400, detail="MT5 not initialized.")
    mt5 = _import_mt5()
    tick = mt5.symbol_info_tick(req.symbol)
    if tick is None:
        raise HTTPException(status_code=404, detail=f"Cannot get tick for '{req.symbol}'")
    return {
        "time": int(tick.time),
        "bid": tick.bid,
        "ask": tick.ask,
        "last": tick.last,
        "volume": tick.volume,
    }


# ── Tunnel control (ngrok) ──
class TunnelRegister(BaseModel):
    public_url: str


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
    """Attempt to start an ngrok tunnel automatically using pyngrok if available.
    If pyngrok is not installed or NGROK_AUTH_TOKEN is not set, return an informative error.
    """
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
    global _mt5_bots
    mt5 = _import_mt5()
    bot = _mt5_bots.get(bot_id)
    if not bot:
        return
    symbol = bot["symbol"]
    tf = bot["timeframe"]
    interval = bot["interval_seconds"]
    while bot["status"] == "running":
        try:
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
            # Optionally place a tiny test order if trading enabled (be careful)
            if bot.get("enable_trading"):
                try:
                    # Place a small market order (0.01 lots) as demo — caller should enable carefully
                    req = {
                        "symbol": symbol,
                        "type": "buy" if decision == "bullish_scan" else "sell",
                        "volume": 0.01,
                    }
                    res = mt5.order_send({
                        "action": mt5.TRADE_ACTION_DEAL,
                        "symbol": req["symbol"],
                        "volume": req["volume"],
                        "type": mt5.ORDER_TYPE_BUY if req["type"] == "buy" else mt5.ORDER_TYPE_SELL,
                        "price": 0.0,
                        "type_time": mt5.ORDER_TIME_GTC,
                        "type_filling": mt5.ORDER_FILLING_IOC,
                    })
                    bot["activity"].insert(0, {"timestamp": int(datetime.now(timezone.utc).timestamp()), "action": "order_sent", "result": getattr(res, "retcode", None)})
                except Exception as e:
                    bot["activity"].insert(0, {"timestamp": int(datetime.now(timezone.utc).timestamp()), "action": "order_error", "error": str(e)})
        except Exception as e:
            bot["activity"].insert(0, {"timestamp": int(datetime.now(timezone.utc).timestamp()), "action": "error", "error": str(e)})
        await asyncio.sleep(interval)


@app.post("/bot/start")
async def bot_start(req: BotStartRequest, background: BackgroundTasks):
    global _mt5_bots
    bot = _create_bot_entry(req.symbol, req.timeframe, req.interval_seconds, req.enable_trading)
    _mt5_bots[bot["id"]] = bot
    # Start background task
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
    # cancel task if running
    t = bot.get("task")
    if t and not t.done():
        t.cancel()
    return {"ok": True}


@app.get("/bot/list")
async def bot_list():
    return [ {k: v for k, v in b.items() if k != "task"} for b in _mt5_bots.values() ]


@app.get("/bot/activity")
async def bot_activity(bot_id: str):
    bot = _mt5_bots.get(bot_id)
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found")
    return bot.get("activity", [])


@app.get("/bot/open-positions")
async def bot_open_positions(bot_id: str):
    # Return current MT5 positions filtered by symbol for the bot
    if not _mt5_initialized:
        raise HTTPException(status_code=400, detail="MT5 not initialized")
    mt5 = _import_mt5()
    bot = _mt5_bots.get(bot_id)
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found")
    pos_list = mt5.positions_get()
    if pos_list is None:
        return []
    filtered = [p for p in pos_list if p.symbol == bot["symbol"]]
    return [_mt5_position_to_dict(p) for p in filtered]


@app.post("/bot/tick")
async def bot_tick(data: dict):
    bot_id = data.get("id")
    bot = _mt5_bots.get(bot_id)
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found")
    # run a single iteration synchronously
    await _bot_loop(bot_id)
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO)
    port = int(os.getenv("MT5_BRIDGE_PORT", "8765"))
    host = os.getenv("MT5_BRIDGE_HOST", "0.0.0.0")
    log.info(f"Starting MT5 Bridge on {host}:{port}...")
    uvicorn.run(app, host=host, port=port, log_level="info")

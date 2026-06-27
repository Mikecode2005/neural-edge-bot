"""
Minimal async Deriv WebSocket client.

Supports the read-only operations needed by the strategy engine plus
contract buy for live mode. Token is only attached when the operation
requires it (balance, buy, portfolio).

Docs: https://api.deriv.com/api-explorer/
"""
from __future__ import annotations
import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional
import websockets

from .config import get_settings
from .schemas import Candle


class DerivError(RuntimeError):
    pass


class DerivClient:
    def __init__(self, app_id: Optional[str] = None,
                 token: Optional[str] = None):
        s = get_settings()
        self.app_id = app_id or s.DERIV_APP_ID
        self.token = token  # may be None for public ops
        self.url = f"{s.DERIV_WS_URL}?app_id={self.app_id}"

    @asynccontextmanager
    async def _connect(self):
        async with websockets.connect(self.url, max_size=2**22) as ws:
            if self.token:
                await self._call(ws, {"authorize": self.token})
            yield ws

    async def _call(self, ws, payload: dict[str, Any]) -> dict[str, Any]:
        req_id = payload.get("req_id") or str(uuid.uuid4())
        payload = {**payload, "req_id": req_id}
        await ws.send(json.dumps(payload))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("req_id") == req_id or msg.get("echo_req", {}).get("req_id") == req_id:
                if "error" in msg:
                    raise DerivError(msg["error"].get("message", "Deriv error"))
                return msg

    # ---------- public ----------

    async def candles(self, symbol: str, granularity: int = 60,
                      count: int = 200) -> list[Candle]:
        async with self._connect() as ws:
            resp = await self._call(ws, {
                "ticks_history": symbol,
                "adjust_start_time": 1,
                "count": count,
                "end": "latest",
                "granularity": granularity,
                "style": "candles",
            })
        rows = resp.get("candles", [])
        return [Candle(epoch=r["epoch"], open=float(r["open"]),
                       high=float(r["high"]), low=float(r["low"]),
                       close=float(r["close"]), volume=float(r.get("volume", 0)))
                for r in rows]

    async def tick(self, symbol: str) -> dict[str, Any]:
        async with self._connect() as ws:
            resp = await self._call(ws, {"ticks": symbol})
        return resp.get("tick", {})

    async def active_symbols(self) -> list[dict[str, Any]]:
        async with self._connect() as ws:
            resp = await self._call(ws, {
                "active_symbols": "brief", "product_type": "basic"})
        return resp.get("active_symbols", [])

    # ---------- authenticated ----------

    async def balance(self) -> dict[str, Any]:
        if not self.token:
            raise DerivError("Token required for balance()")
        async with self._connect() as ws:
            resp = await self._call(ws, {"balance": 1})
        return resp.get("balance", {})

    async def buy_contract(self, *, symbol: str, contract_type: str,
                            amount: float, duration: int = 5,
                            duration_unit: str = "m",
                            currency: str = "USD") -> dict[str, Any]:
        """
        contract_type: 'CALL' (BUY) or 'PUT' (SELL) for rise/fall contracts.
        """
        if not self.token:
            raise DerivError("Token required for buy_contract()")
        proposal = {
            "proposal": 1, "amount": amount, "basis": "stake",
            "contract_type": contract_type, "currency": currency,
            "duration": duration, "duration_unit": duration_unit,
            "symbol": symbol,
        }
        async with self._connect() as ws:
            p = await self._call(ws, proposal)
            prop = p.get("proposal", {})
            if "id" not in prop:
                raise DerivError("No proposal id returned")
            b = await self._call(ws, {"buy": prop["id"], "price": amount})
        return b.get("buy", {})

    async def portfolio(self) -> dict[str, Any]:
        if not self.token:
            raise DerivError("Token required for portfolio()")
        async with self._connect() as ws:
            resp = await self._call(ws, {"portfolio": 1})
        return resp.get("portfolio", {})

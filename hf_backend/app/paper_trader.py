"""Virtual paper-trading engine. Uses live Deriv prices but never executes."""
from __future__ import annotations
from typing import Any, Optional
from datetime import datetime, timezone
import uuid

from . import supabase_client as sb
from .config import get_settings
from .schemas import PaperTradeRequest


async def get_or_create_portfolio(user_id: Optional[str], mode: str = "demo") -> dict:
    rows = sb.select("portfolio", eq={"mode": mode, "user_id": user_id} if user_id
                     else {"mode": mode}, limit=1)
    if rows:
        return rows[0]
    s = get_settings()
    created = sb.insert("portfolio", {
        "user_id": user_id, "mode": mode,
        "balance": s.DEMO_STARTING_BALANCE,
        "equity": s.DEMO_STARTING_BALANCE,
    })
    return created or {
        "balance": s.DEMO_STARTING_BALANCE,
        "equity": s.DEMO_STARTING_BALANCE,
        "open_positions": 0, "realized_pnl": 0, "unrealized_pnl": 0,
    }


async def open_paper_trade(req: PaperTradeRequest, current_price: float,
                            user_id: Optional[str] = None) -> dict[str, Any]:
    portfolio = await get_or_create_portfolio(user_id, "demo")
    entry = req.entry or current_price
    row = sb.insert("trade_history", {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "prediction_id": req.prediction_id,
        "mode": "demo",
        "symbol": req.symbol,
        "side": req.side,
        "entry_price": entry,
        "size": req.size,
        "stop_loss": req.sl,
        "take_profit": req.tp,
        "status": "open",
        "reason_opened": "AI signal accepted",
        "opened_at": datetime.now(timezone.utc).isoformat(),
    })
    if portfolio.get("id"):
        sb.update("portfolio", portfolio["id"], {
            "open_positions": (portfolio.get("open_positions") or 0) + 1,
        })
    return row or {}


async def close_paper_trade(trade_id: str, exit_price: float,
                             reason: str = "manual close") -> dict[str, Any]:
    rows = sb.select("trade_history", eq={"id": trade_id}, limit=1)
    if not rows:
        return {"ok": False, "message": "Trade not found"}
    t = rows[0]
    sign = 1 if t["side"] == "BUY" else -1
    pnl = sign * (exit_price - float(t["entry_price"])) * float(t["size"])
    sb.update("trade_history", trade_id, {
        "exit_price": exit_price,
        "pnl": pnl,
        "status": "closed",
        "reason_closed": reason,
        "closed_at": datetime.now(timezone.utc).isoformat(),
    })
    pf = await get_or_create_portfolio(t.get("user_id"), "demo")
    if pf.get("id"):
        sb.update("portfolio", pf["id"], {
            "realized_pnl": float(pf.get("realized_pnl") or 0) + pnl,
            "balance": float(pf.get("balance") or 0) + pnl,
            "equity": float(pf.get("equity") or 0) + pnl,
            "open_positions": max(0, (pf.get("open_positions") or 1) - 1),
        })
    return {"ok": True, "pnl": pnl}

"""
Error Code Translator (Step 11).

Converts MT5 numeric retcodes into human-readable API responses.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("uvicorn.error")

# MT5 trade return codes
TRADE_RETCODE_CODES = {
    10004: "No connection to trade server",
    10006: "Order is not accepted by server",
    10007: "Request is too frequent, throttled",
    10008: "Request rejected",
    10009: "Request executed successfully",
    10010: "Order placed successfully",
    10011: "Order modified successfully",
    10012: "Order deleted successfully",
    10013: "Other order placed in same tick",
    10014: "Invalid volume (too small or malformed)",
    10015: "Invalid price",
    10016: "Invalid stops (SL/TP violation)",
    10017: "Trade is disabled",
    10018: "Not enough money to complete trade",
    10019: "Price changed",
    10020: "Off quotes (no price available)",
    10021: "Broker busy",
    10022: "Requote",
    10023: "Order is too many (position limit reached)",
    10024: "Too many trade requests",
    10025: "No changes made (order already as specified)",
    10026: "Autotrading disabled by server",
    10027: "Autotrading disabled by client terminal",
    10028: "Order locked (already being processed)",
    10029: "Order or position frozen",
    10030: "Unsupported filling mode",
    10031: "Unsupported order type",
    10032: "Order type not allowed by server",
    10033: "Order locked by another process",
    10034: "Order or position modified too frequently",
    10035: "Long positions only allowed",
    10036: "Short positions only allowed",
    10037: "Hedging is not allowed",
    10038: "Order exceeds FIFO rule",
    10039: "Expiration is not supported",
    10040: "Too many pending orders",
    10041: "Invalid or unsupported order expiration",
    10042: "Order type is not allowed for current symbol",
    10043: "Position is not changed",
    10044: "Position is not found",
    10045: "Too many positions opened",
}


class Retcode:
    """Represents an MT5 trade return code with human-readable description."""

    def __init__(self, code: int, description: str):
        self.code = code
        self.description = description

    def is_success(self) -> bool:
        return self.code == 10009 or self.code == 10010

    def is_slippage(self) -> bool:
        return self.code in (10019, 10022)  # price changed, requote

    def is_retryable(self) -> bool:
        return self.code in (
            10019,  # price changed
            10020,  # off quotes
            10021,  # broker busy
            10022,  # requote
            10024,  # too many requests
            10030,  # unsupported filling mode (retry with different mode)
        )

    def __repr__(self) -> str:
        return f"Retcode({self.code}: {self.description})"


def translate_retcode(code: int, comment: str = "") -> dict[str, Any]:
    """Convert an MT5 retcode to a human-readable API response dict."""
    description = TRADE_RETCODE_CODES.get(code, f"Unknown MT5 error code {code}")
    return {
        "retcode": code,
        "message": f"{description}",
        "comment": comment,
        "success": code == 10009,
    }


def retcode_to_http_exception(code: int, comment: str = "") -> dict[str, Any]:
    """Map MT5 retcodes to HTTP-friendly error details."""
    if code == 10009:
        return {"status_code": 200, "detail": "Trade executed successfully"}

    retcode_map = {
        10014: {"status_code": 400, "detail": f"Invalid volume: {comment}"},
        10015: {"status_code": 400, "detail": f"Invalid price: {comment}"},
        10016: {"status_code": 400, "detail": f"Invalid stop loss or take profit levels: {comment}. Ensure SL/TP are on the correct side of entry and meet minimum distance requirements."},
        10017: {"status_code": 403, "detail": "Trading is disabled for this account or symbol"},
        10018: {"status_code": 402, "detail": f"Insufficient margin: {comment}"},
        10019: {"status_code": 409, "detail": f"Price changed (requote): {comment}"},
        10020: {"status_code": 503, "detail": "No quotes available (off quotes)"},
        10021: {"status_code": 503, "detail": "Broker is busy, try again"},
        10026: {"status_code": 403, "detail": "Automated trading is disabled by the trade server"},
        10027: {"status_code": 403, "detail": "Automated trading is disabled in the MT5 terminal"},
        10030: {"status_code": 400, "detail": f"Unsupported filling mode for this symbol: {comment}"},
        10031: {"status_code": 400, "detail": f"Unsupported order type: {comment}"},
        10032: {"status_code": 400, "detail": f"Order type not allowed by server: {comment}"},
        10035: {"status_code": 403, "detail": "Only long positions are allowed for this symbol"},
        10036: {"status_code": 403, "detail": "Only short positions are allowed for this symbol"},
    }

    result = retcode_map.get(code, {
        "status_code": 500,
        "detail": f"MT5 trade error (retcode={code}): {comment or TRADE_RETCODE_CODES.get(code, 'Unknown error')}",
    })
    return result
"""
Filling Mode Detector (Step 2).

Automatically determines which ORDER_FILLING_* modes a symbol supports
by using order_check() against each mode. Caches the result per symbol.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

log = logging.getLogger("uvicorn.error")

# MT5 constants (we resolve them from the mt5 module at runtime)
ORDER_FILLING_FOK = 0
ORDER_FILLING_IOC = 1
ORDER_FILLING_RETURN = 2

FILLING_MODE_NAMES = {
    ORDER_FILLING_FOK: "FOK",
    ORDER_FILLING_IOC: "IOC",
    ORDER_FILLING_RETURN: "RETURN",
}


class FillingModeDetector:
    """Detects and caches supported filling modes per symbol."""

    def __init__(self, mt5_module: Any):
        self._mt5 = mt5_module
        self._cache: dict[str, list[int]] = {}  # symbol -> [supported modes]

    def get_supported(self, symbol: str, volume: float, order_type: int, price: float) -> list[int]:
        """Return list of supported filling modes for this symbol, ordered by preference.

        Uses order_check() to test each mode. Caches the result.
        """
        cached = self._cache.get(symbol)
        if cached is not None:
            return cached

        supported = self._detect(symbol, volume, order_type, price)
        self._cache[symbol] = supported
        log.info(
            "FillingModeDetector: %s supported modes = %s",
            symbol,
            [FILLING_MODE_NAMES.get(m, str(m)) for m in supported],
        )
        return supported

    def get_best(self, symbol: str, volume: float, order_type: int, price: float) -> int:
        """Return the single best filling mode (first supported)."""
        supported = self.get_supported(symbol, volume, order_type, price)
        if supported:
            return supported[0]
        # Fallback: try IOC first, then FOK, then RETURN
        log.warning("FillingModeDetector: no supported mode found for %s, falling back to IOC", symbol)
        return ORDER_FILLING_IOC

    def _detect(self, symbol: str, volume: float, order_type: int, price: float) -> list[int]:
        """Test each filling mode with order_check()."""
        mt5 = self._mt5
        supported: list[int] = []

        # Resolve constants from the mt5 module
        fok = getattr(mt5, "ORDER_FILLING_FOK", ORDER_FILLING_FOK)
        ioc = getattr(mt5, "ORDER_FILLING_IOC", ORDER_FILLING_IOC)
        ret = getattr(mt5, "ORDER_FILLING_RETURN", ORDER_FILLING_RETURN)
        gtc = getattr(mt5, "ORDER_TIME_GTC", 0)
        deal = getattr(mt5, "TRADE_ACTION_DEAL", 1)

        for mode in (fok, ioc, ret):
            request = {
                "action": deal,
                "symbol": symbol,
                "volume": volume,
                "type": order_type,
                "price": price,
                "type_filling": mode,
                "type_time": gtc,
            }
            try:
                check = mt5.order_check(request)
                if check is not None and check.retcode == 0:
                    supported.append(mode)
                    log.info(
                        "FillingModeDetector: %s supports %s (retcode=0)",
                        symbol,
                        FILLING_MODE_NAMES.get(mode, str(mode)),
                    )
                else:
                    retcode = check.retcode if check is not None else "None"
                    log.info(
                        "FillingModeDetector: %s does NOT support %s (retcode=%s)",
                        symbol,
                        FILLING_MODE_NAMES.get(mode, str(mode)),
                        retcode,
                    )
            except Exception as e:
                log.warning(
                    "FillingModeDetector: order_check failed for %s mode %s: %s",
                    symbol,
                    FILLING_MODE_NAMES.get(mode, str(mode)),
                    e,
                )

        return supported

    def clear(self, symbol: Optional[str] = None) -> None:
        if symbol:
            self._cache.pop(symbol, None)
        else:
            self._cache.clear()
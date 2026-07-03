"""
Symbol Specification Manager (Step 1).

Retrieves and caches symbol_info() and symbol_info_tick() for every symbol.
Automatically refreshes when the symbol changes or cache expires.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

log = logging.getLogger("uvicorn.error")

# Cache lifetime in seconds
_SYMBOL_CACHE_TTL = 60.0  # 1 minute


@dataclass
class SymbolSpec:
    """Complete trading specification for a single symbol."""
    # Identity
    name: str
    digits: int
    point: float
    tick_size: float

    # Trading rules
    trade_mode: int  # 0=disabled, 1=enabled, 2=closeonly, 3=longonly, 4=shortonly
    trade_exemode: int  # execution mode: 0=REQUEST, 1=INSTANT, 2=MARKET, 4=EXCHANGE
    filling_mode: int  # bitmask of supported ORDER_FILLING_* flags

    # Volume constraints
    volume_min: float
    volume_max: float
    volume_step: float

    # Stop / price constraints
    trade_stops_level: int  # minimum stop distance in points
    trade_freeze_level: int  # freeze level in points
    spread: int
    visible: int  # 0=hidden, 1=visible

    # Current market prices (from tick)
    bid: float = 0.0
    ask: float = 0.0
    last: float = 0.0

    # Supported filling modes (cached after detection)
    supported_filling_modes: list[int] = field(default_factory=lambda: [])

    # Cache metadata
    _cached_at: float = 0.0

    def is_cache_valid(self) -> bool:
        return (time.monotonic() - self._cached_at) < _SYMBOL_CACHE_TTL

    def refresh_needed(self) -> bool:
        return not self.is_cache_valid()


class SymbolManager:
    """Singleton-like cache of SymbolSpec objects."""

    def __init__(self, mt5_module: Any):
        self._mt5 = mt5_module
        self._cache: dict[str, SymbolSpec] = {}

    def get(self, symbol: str) -> Optional[SymbolSpec]:
        """Return cached spec, or fetch + cache if missing / stale."""
        cached = self._cache.get(symbol)
        if cached is not None and cached.is_cache_valid():
            # Still fresh — update tick prices only
            self._update_tick(cached)
            return cached

        return self._fetch_and_cache(symbol)

    def _fetch_and_cache(self, symbol: str) -> Optional[SymbolSpec]:
        """Fetch symbol_info + symbol_info_tick from MT5, build a SymbolSpec, cache it."""
        mt5 = self._mt5

        info = mt5.symbol_info(symbol)
        if info is None:
            log.warning("SymbolManager: symbol_info(%s) returned None", symbol)
            return None

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            log.warning("SymbolManager: symbol_info_tick(%s) returned None", symbol)

        spec = SymbolSpec(
            name=info.name,
            digits=info.digits,
            point=info.point,
            tick_size=info.trade_tick_size if hasattr(info, "trade_tick_size") and info.trade_tick_size > 0 else info.point,
            trade_mode=info.trade_mode,
            trade_exemode=info.trade_exemode if hasattr(info, "trade_exemode") else 2,  # default MARKET
            filling_mode=info.filling_mode if hasattr(info, "filling_mode") else 0,
            volume_min=info.volume_min,
            volume_max=info.volume_max,
            volume_step=info.volume_step,
            trade_stops_level=info.trade_stops_level,
            trade_freeze_level=info.trade_freeze_level,
            spread=info.spread,
            visible=info.visible,
            bid=tick.bid if tick is not None else 0.0,
            ask=tick.ask if tick is not None else 0.0,
            last=tick.last if tick is not None else 0.0,
            _cached_at=time.monotonic(),
        )

        self._cache[symbol] = spec
        log.info(
            "SymbolManager: cached %s digits=%d point=%g tick_size=%g "
            "vol_min=%g vol_max=%g vol_step=%g stops_level=%d freeze_level=%d "
            "filling_mode=%d trade_exemode=%d",
            symbol, spec.digits, spec.point, spec.tick_size,
            spec.volume_min, spec.volume_max, spec.volume_step,
            spec.trade_stops_level, spec.trade_freeze_level,
            spec.filling_mode, spec.trade_exemode,
        )
        return spec

    def _update_tick(self, spec: SymbolSpec) -> None:
        """Refresh bid/ask/last from the latest tick without rebuilding the whole spec."""
        mt5 = self._mt5
        try:
            tick = mt5.symbol_info_tick(spec.name)
            if tick is not None:
                spec.bid = tick.bid
                spec.ask = tick.ask
                spec.last = tick.last
        except Exception:
            pass  # non-critical — stale tick is better than crash

    def clear(self, symbol: Optional[str] = None) -> None:
        """Evict one symbol or the entire cache."""
        if symbol:
            self._cache.pop(symbol, None)
        else:
            self._cache.clear()
        log.info("SymbolManager cache cleared for %s", symbol if symbol else "ALL")
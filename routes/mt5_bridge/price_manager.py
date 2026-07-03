"""
Price Manager (Step 5).

Ensures BUY always uses tick.ask and SELL always uses tick.bid.
Normalizes prices to symbol digits and tick size.
"""
from __future__ import annotations

import logging
from typing import Optional

from .symbol_manager import SymbolSpec

log = logging.getLogger("uvicorn.error")

ORDER_TYPE_BUY = 0
ORDER_TYPE_SELL = 1


class PriceManager:
    """Handles price selection and normalization."""

    @staticmethod
    def get_entry_price(spec: SymbolSpec, order_type: int) -> float:
        """Get the correct entry price based on order type.

        BUY  -> ask (we buy at the market maker's ask price)
        SELL -> bid (we sell at the market maker's bid price)
        """
        if order_type == ORDER_TYPE_BUY:
            price = spec.ask
            log.info("PriceManager: BUY %s using ask=%.5f", spec.name, price)
        else:
            price = spec.bid
            log.info("PriceManager: SELL %s using bid=%.5f", spec.name, price)

        if price == 0.0:
            log.error("PriceManager: %s price is ZERO for order_type=%s", spec.name, order_type)

        return price

    @staticmethod
    def normalize_price(spec: SymbolSpec, price: float) -> float:
        """Round a price to the symbol's digits and tick size."""
        if price == 0.0:
            return 0.0

        # Round to tick_size granularity first
        if spec.tick_size > 0:
            tick = spec.tick_size
            normalized = round(price / tick) * tick
        else:
            normalized = price

        # Then round to symbol digits
        normalized = round(normalized, spec.digits)
        return normalized

    @staticmethod
    def is_valid_price(spec: SymbolSpec, price: float) -> bool:
        """Check if a price is valid (non-zero, within expected range)."""
        if price <= 0:
            return False
        # Prices should be within a reasonable range of bid/ask
        if spec.bid > 0 and spec.ask > 0:
            mid = (spec.bid + spec.ask) / 2
            # Allow prices up to 50% away from mid (very generous)
            if price < mid * 0.5 or price > mid * 1.5:
                log.warning(
                    "PriceManager: price %.5f is far from mid %.5f for %s",
                    price, mid, spec.name,
                )
                return False
        return True
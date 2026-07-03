"""
Stop Loss / Take Profit Calculator (Step 4).

Calculates valid SL and TP levels that satisfy broker-imposed minimum stop distances,
tick size granularity, and digit precision.

Key rule for Deriv synthetic indices:
- BUY: SL < entry, TP > entry
- SELL: SL > entry, TP < entry
- Minimum distance = trade_stops_level * point
- All prices must be rounded to symbol digits and aligned to tick_size
"""
from __future__ import annotations

import logging
from typing import Optional

from .symbol_manager import SymbolSpec
from .price_manager import PriceManager

log = logging.getLogger("uvicorn.error")

ORDER_TYPE_BUY = 0
ORDER_TYPE_SELL = 1


class StopCalculator:
    """Calculates broker-valid SL and TP levels."""

    @staticmethod
    def calculate_valid_sl(
        spec: SymbolSpec,
        order_type: int,
        entry_price: float,
        requested_sl: float,
    ) -> float:
        """Calculate a broker-valid stop loss.

        Args:
            spec: Symbol specification.
            order_type: ORDER_TYPE_BUY or ORDER_TYPE_SELL.
            entry_price: The price the order will be executed at.
            requested_sl: The user-requested SL (0.0 means no SL).

        Returns:
            A valid SL value (0.0 if no SL requested or cannot calculate).
        """
        if requested_sl == 0.0:
            return 0.0

        pm = PriceManager()
        normalized_sl = pm.normalize_price(spec, requested_sl)
        min_stop_distance = StopCalculator._get_min_stop_distance(spec)
        freeze_level = spec.trade_freeze_level * spec.point if spec.trade_freeze_level > 0 else 0.0

        log.info(
            "StopCalculator: %s %s entry=%.5f requested_sl=%.5f normalized_sl=%.5f "
            "min_stop_distance=%.5f freeze_level=%.5f",
            spec.name, "BUY" if order_type == ORDER_TYPE_BUY else "SELL",
            entry_price, requested_sl, normalized_sl,
            min_stop_distance, freeze_level,
        )

        if order_type == ORDER_TYPE_BUY:
            # BUY: SL must be BELOW entry
            max_sl = entry_price - min_stop_distance
            if normalized_sl > max_sl:
                # Adjust down to max allowed
                adjusted = max_sl
                log.warning(
                    "StopCalculator: BUY SL %.5f too close to entry, adjusted to %.5f "
                    "(max allowed = entry - min_stop_distance)",
                    normalized_sl, adjusted,
                )
                normalized_sl = adjusted
            if normalized_sl >= entry_price:
                # SL must be strictly less than entry
                normalized_sl = max_sl
                log.warning(
                    "StopCalculator: BUY SL >= entry, forced to %.5f",
                    normalized_sl,
                )
        else:
            # SELL: SL must be ABOVE entry
            min_sl = entry_price + min_stop_distance
            if normalized_sl < min_sl:
                # Adjust up to min allowed
                adjusted = min_sl
                log.warning(
                    "StopCalculator: SELL SL %.5f too close to entry, adjusted to %.5f "
                    "(min allowed = entry + min_stop_distance)",
                    normalized_sl, adjusted,
                )
                normalized_sl = adjusted
            if normalized_sl <= entry_price:
                # SL must be strictly greater than entry
                normalized_sl = min_sl
                log.warning(
                    "StopCalculator: SELL SL <= entry, forced to %.5f",
                    normalized_sl,
                )

        # Final normalization
        normalized_sl = pm.normalize_price(spec, normalized_sl)

        # Ensure freeze level distance from entry
        if freeze_level > 0:
            if order_type == ORDER_TYPE_BUY:
                if normalized_sl > entry_price - freeze_level and normalized_sl < entry_price:
                    normalized_sl = entry_price - freeze_level - min_stop_distance
                    log.warning(
                        "StopCalculator: BUY SL adjusted for freeze level to %.5f",
                        normalized_sl,
                    )
            else:
                if normalized_sl < entry_price + freeze_level and normalized_sl > entry_price:
                    normalized_sl = entry_price + freeze_level + min_stop_distance
                    log.warning(
                        "StopCalculator: SELL SL adjusted for freeze level to %.5f",
                        normalized_sl,
                    )

        normalized_sl = pm.normalize_price(spec, normalized_sl)
        log.info("StopCalculator: final SL = %.5f", normalized_sl)
        return normalized_sl

    @staticmethod
    def calculate_valid_tp(
        spec: SymbolSpec,
        order_type: int,
        entry_price: float,
        requested_tp: float,
        sl_price: float = 0.0,
    ) -> float:
        """Calculate a broker-valid take profit.

        Args:
            spec: Symbol specification.
            order_type: ORDER_TYPE_BUY or ORDER_TYPE_SELL.
            entry_price: The price the order will be executed at.
            requested_tp: The user-requested TP (0.0 means no TP).
            sl_price: The (already validated) SL price, used for context.

        Returns:
            A valid TP value (0.0 if no TP requested).
        """
        if requested_tp == 0.0:
            return 0.0

        pm = PriceManager()
        normalized_tp = pm.normalize_price(spec, requested_tp)
        min_stop_distance = StopCalculator._get_min_stop_distance(spec)

        log.info(
            "StopCalculator: %s %s entry=%.5f requested_tp=%.5f normalized_tp=%.5f "
            "min_stop_distance=%.5f",
            spec.name, "BUY" if order_type == ORDER_TYPE_BUY else "SELL",
            entry_price, requested_tp, normalized_tp,
            min_stop_distance,
        )

        if order_type == ORDER_TYPE_BUY:
            # BUY: TP must be ABOVE entry
            min_tp = entry_price + min_stop_distance
            if normalized_tp < min_tp:
                adjusted = min_tp
                log.warning(
                    "StopCalculator: BUY TP %.5f too close to entry, adjusted to %.5f",
                    normalized_tp, adjusted,
                )
                normalized_tp = adjusted
            if normalized_tp <= entry_price:
                normalized_tp = min_tp
                log.warning(
                    "StopCalculator: BUY TP <= entry, forced to %.5f",
                    normalized_tp,
                )
        else:
            # SELL: TP must be BELOW entry
            max_tp = entry_price - min_stop_distance
            if normalized_tp > max_tp:
                adjusted = max_tp
                log.warning(
                    "StopCalculator: SELL TP %.5f too close to entry, adjusted to %.5f",
                    normalized_tp, adjusted,
                )
                normalized_tp = adjusted
            if normalized_tp >= entry_price:
                normalized_tp = max_tp
                log.warning(
                    "StopCalculator: SELL TP >= entry, forced to %.5f",
                    normalized_tp,
                )

        # Final normalization
        normalized_tp = pm.normalize_price(spec, normalized_tp)

        # Ensure SL and TP don't cross
        if sl_price != 0.0:
            if order_type == ORDER_TYPE_BUY:
                if normalized_tp <= sl_price:
                    normalized_tp = sl_price + min_stop_distance + spec.point * 2
                    log.warning(
                        "StopCalculator: TP <= SL, adjusted TP to %.5f",
                        normalized_tp,
                    )
            else:
                if normalized_tp >= sl_price:
                    normalized_tp = sl_price - min_stop_distance - spec.point * 2
                    log.warning(
                        "StopCalculator: TP >= SL, adjusted TP to %.5f",
                        normalized_tp,
                    )

        normalized_tp = pm.normalize_price(spec, normalized_tp)
        log.info("StopCalculator: final TP = %.5f", normalized_tp)
        return normalized_tp

    @staticmethod
    def _get_min_stop_distance(spec: SymbolSpec) -> float:
        """Get the minimum stop distance in price units.

        trade_stops_level is in points. Multiply by point value.
        """
        if spec.trade_stops_level > 0:
            # For Deriv synthetic indices, stops_level is often 0 or very small
            distance = spec.trade_stops_level * spec.point
            log.info("StopCalculator: min_stop_distance = %d * %g = %g for %s",
                     spec.trade_stops_level, spec.point, distance, spec.name)
            return distance
        # If no stops level defined, use a safe default
        # For most Deriv indices, 2x spread is a safe minimum
        safe_min = spec.spread * spec.point * 2
        if safe_min > 0:
            return safe_min
        # Absolute floor: 1 tick
        return spec.tick_size
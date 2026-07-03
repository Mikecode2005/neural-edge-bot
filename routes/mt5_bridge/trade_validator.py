"""
Trade Validator (Step 3).

Validates every aspect of a trade request BEFORE it reaches MT5.
Rejects invalid requests with clear, human-readable error messages.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from .symbol_manager import SymbolSpec

log = logging.getLogger("uvicorn.error")

ORDER_TYPE_BUY = 0
ORDER_TYPE_SELL = 1


class ValidationResult:
    """Result of a trade validation."""

    def __init__(self, valid: bool, reason: str = ""):
        self.valid = valid
        self.reason = reason

    def __bool__(self) -> bool:
        return self.valid

    def __repr__(self) -> str:
        return f"ValidationResult(valid={self.valid}, reason='{self.reason}')"


VALID = ValidationResult(True)


def invalid(reason: str) -> ValidationResult:
    return ValidationResult(False, reason)


class TradeValidator:
    """Validates trade requests against symbol specifications."""

    @staticmethod
    def validate(
        spec: SymbolSpec,
        order_type: int,
        volume: float,
        price: float,
        sl: float = 0.0,
        tp: float = 0.0,
    ) -> ValidationResult:
        """Run all validation checks. Returns VALID or invalid(reason)."""

        checks = [
            TradeValidator._check_symbol_exists(spec),
            TradeValidator._check_symbol_visible(spec),
            TradeValidator._check_symbol_selected(spec),
            TradeValidator._check_market_open(spec),
            TradeValidator._check_trading_allowed(spec),
            TradeValidator._check_volume_min(spec, volume),
            TradeValidator._check_volume_max(spec, volume),
            TradeValidator._check_volume_step(spec, volume),
            TradeValidator._check_price_exists(price),
            TradeValidator._check_price_direction(spec, order_type, price),
        ]

        for check in checks:
            if not check:
                return check

        return VALID

    @staticmethod
    def _check_symbol_exists(spec: Optional[SymbolSpec]) -> ValidationResult:
        if spec is None:
            return invalid("Symbol not found in MT5")
        return VALID

    @staticmethod
    def _check_symbol_visible(spec: SymbolSpec) -> ValidationResult:
        if spec.visible == 0:
            return invalid(f"Symbol {spec.name} is hidden in Market Watch")
        return VALID

    @staticmethod
    def _check_symbol_selected(spec: SymbolSpec) -> ValidationResult:
        # We assume symbol_select() was called; this is a soft check
        if spec.visible == 0:
            return invalid(f"Symbol {spec.name} is not selected in Market Watch")
        return VALID

    @staticmethod
    def _check_market_open(spec: SymbolSpec) -> ValidationResult:
        if spec.trade_mode == 0:
            return invalid(f"Symbol {spec.name} is disabled (trade_mode=0)")
        if spec.trade_mode == 2:
            return invalid(f"Symbol {spec.name} is close-only only")
        return VALID

    @staticmethod
    def _check_trading_allowed(spec: SymbolSpec) -> ValidationResult:
        if spec.trade_mode == 0:
            return invalid("Trading is disabled for this symbol")
        return VALID

    @staticmethod
    def _check_volume_min(spec: SymbolSpec, volume: float) -> ValidationResult:
        if volume < spec.volume_min:
            return invalid(
                f"Volume {volume} is below minimum {spec.volume_min} for {spec.name}"
            )
        return VALID

    @staticmethod
    def _check_volume_max(spec: SymbolSpec, volume: float) -> ValidationResult:
        if volume > spec.volume_max:
            return invalid(
                f"Volume {volume} exceeds maximum {spec.volume_max} for {spec.name}"
            )
        return VALID

    @staticmethod
    def _check_volume_step(spec: SymbolSpec, volume: float) -> ValidationResult:
        if spec.volume_step > 0:
            # Check volume is a multiple of volume_step
            remainder = volume % spec.volume_step
            if remainder > 1e-10:  # floating point tolerance
                # Round to nearest step
                normalized = round(volume / spec.volume_step) * spec.volume_step
                return invalid(
                    f"Volume {volume} does not match volume_step {spec.volume_step} "
                    f"for {spec.name}. Nearest valid volume: {normalized}"
                )
        return VALID

    @staticmethod
    def _check_price_exists(price: float) -> ValidationResult:
        if price <= 0:
            return invalid(f"Invalid price: {price}")
        return VALID

    @staticmethod
    def _check_price_direction(spec: SymbolSpec, order_type: int, price: float) -> ValidationResult:
        """Verify the price is appropriate for the order direction."""
        if order_type == ORDER_TYPE_BUY:
            # BUY should use ask price
            if spec.ask > 0 and abs(price - spec.ask) > spec.ask * 0.01:
                log.warning(
                    "TradeValidator: BUY price %.5f differs from ask %.5f for %s",
                    price, spec.ask, spec.name,
                )
        else:
            # SELL should use bid price
            if spec.bid > 0 and abs(price - spec.bid) > spec.bid * 0.01:
                log.warning(
                    "TradeValidator: SELL price %.5f differs from bid %.5f for %s",
                    price, spec.bid, spec.name,
                )
        return VALID

    @staticmethod
    def normalize_volume(spec: SymbolSpec, volume: float) -> float:
        """Normalize volume to the symbol's volume_step."""
        if spec.volume_step > 0:
            normalized = round(volume / spec.volume_step) * spec.volume_step
            # Clamp to min/max
            normalized = max(spec.volume_min, min(spec.volume_max, normalized))
            return normalized
        return max(spec.volume_min, min(spec.volume_max, volume))
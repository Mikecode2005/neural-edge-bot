"""Pre-trade risk gates. Reject before any execution."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional


@dataclass
class RiskCheckResult:
    ok: bool
    reason: Optional[str] = None


def validate_trade(*, balance: float, open_positions: int, today_pnl: float,
                   trade_size: float, confidence: float,
                   max_daily_loss: float, max_open_trades: int,
                   risk_percent: float,
                   confidence_threshold: float = 0.6) -> RiskCheckResult:
    if balance <= 0:
        return RiskCheckResult(False, "Zero balance.")
    if trade_size <= 0:
        return RiskCheckResult(False, "Trade size must be positive.")
    if trade_size > balance:
        return RiskCheckResult(False, "Trade size exceeds balance.")
    if open_positions >= max_open_trades:
        return RiskCheckResult(False, f"Max open trades reached ({max_open_trades}).")
    if today_pnl <= -abs(max_daily_loss):
        return RiskCheckResult(False, f"Daily loss limit hit ({today_pnl:.2f}).")
    if confidence < confidence_threshold:
        return RiskCheckResult(False,
            f"Confidence {confidence:.2f} below threshold {confidence_threshold:.2f}.")
    max_risk = balance * (risk_percent / 100.0)
    if trade_size > max_risk:
        return RiskCheckResult(False,
            f"Trade size {trade_size:.2f} exceeds {risk_percent}% risk cap ({max_risk:.2f}).")
    return RiskCheckResult(True)

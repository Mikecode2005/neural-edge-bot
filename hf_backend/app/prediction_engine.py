"""
Prediction engine — numerical forecasters.

For the initial slice we ship one pure-Python heuristic forecaster + stubs
for LSTM / XGBoost / Transformer slots. Heavy models load lazily so the
Space starts fast.
"""
from __future__ import annotations
from typing import Any
import numpy as np
import pandas as pd

from .schemas import Candle


def _df(candles: list[Candle]) -> pd.DataFrame:
    return pd.DataFrame([c.model_dump() for c in candles])


def heuristic_forecast(candles: list[Candle], horizon: int = 5) -> dict[str, Any]:
    """Quick momentum + mean-reversion blend, returns next-N candle direction."""
    if len(candles) < 20:
        return {"direction": "flat", "expected_return": 0.0, "confidence": 0.0,
                "horizon": horizon, "model": "heuristic"}
    df = _df(candles)
    rets = df["close"].pct_change().dropna()
    momentum = rets.tail(10).mean()
    vol = rets.tail(20).std() or 1e-9
    z = momentum / vol
    expected = float(np.tanh(z) * vol * horizon)
    direction = "up" if expected > 0 else "down" if expected < 0 else "flat"
    confidence = float(min(abs(z) / 3, 0.9))
    return {
        "direction": direction,
        "expected_return": expected,
        "confidence": confidence,
        "horizon": horizon,
        "model": "heuristic-momentum-v1",
    }


# ---- stubs for future swap-in -----

def lstm_forecast(candles: list[Candle], horizon: int = 5) -> dict[str, Any]:
    """Placeholder — same contract as heuristic. Swap in a trained LSTM."""
    base = heuristic_forecast(candles, horizon)
    base["model"] = "lstm-stub"
    return base


def xgboost_forecast(candles: list[Candle], horizon: int = 5) -> dict[str, Any]:
    base = heuristic_forecast(candles, horizon)
    base["model"] = "xgboost-stub"
    return base


def ensemble(candles: list[Candle], horizon: int = 5) -> dict[str, Any]:
    """Average available models. Currently only the heuristic is real."""
    models = [heuristic_forecast(candles, horizon)]
    expected = float(np.mean([m["expected_return"] for m in models]))
    conf = float(np.mean([m["confidence"] for m in models]))
    direction = "up" if expected > 0 else "down" if expected < 0 else "flat"
    return {
        "direction": direction,
        "expected_return": expected,
        "confidence": conf,
        "horizon": horizon,
        "components": [m["model"] for m in models],
        "model": "ensemble-v1",
    }

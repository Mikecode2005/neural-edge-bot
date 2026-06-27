"""
Order Block + Fair Value Gap strategy.

Definitions
-----------
Fair Value Gap (3-candle imbalance):
  - Bullish FVG: candle[i-1].high < candle[i+1].low
    => gap zone = (candle[i-1].high, candle[i+1].low)
  - Bearish FVG: candle[i-1].low  > candle[i+1].high
    => gap zone = (candle[i+1].high, candle[i-1].low)

Order Block (anchor candle):
  - Bullish OB = last bearish candle (close < open) immediately preceding
    the bullish impulse that created the FVG.
  - Bearish OB = last bullish candle (close > open) immediately preceding
    the bearish impulse.
  - OB zone = (low, high) of that candle.

Signal logic
------------
When current price retraces into an unmitigated OB zone of the same direction
and the FVG anchoring it is still (at least partially) unfilled, emit a signal:

  Bullish OB tag -> BUY
  Bearish OB tag -> SELL

Risk plan
---------
  entry = midpoint of OB zone
  SL    = OB extreme on the protected side - 1 * ATR(14) buffer
  TP    = nearest swing liquidity in trade direction, capped at 3R / floored at 1.5R
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import Optional
import numpy as np
import pandas as pd

from .schemas import Candle, FVG, OrderBlock, StrategySignal


# ----------------------------- helpers --------------------------------------

def candles_to_df(candles: list[Candle]) -> pd.DataFrame:
    return pd.DataFrame([c.model_dump() for c in candles])


def atr(df: pd.DataFrame, period: int = 14) -> float:
    if len(df) < period + 1:
        return float((df["high"] - df["low"]).mean() or 0.0)
    h, l, c = df["high"].values, df["low"].values, df["close"].values
    tr = np.maximum.reduce([
        h[1:] - l[1:],
        np.abs(h[1:] - c[:-1]),
        np.abs(l[1:] - c[:-1]),
    ])
    return float(pd.Series(tr).rolling(period).mean().iloc[-1])


def ema(series: pd.Series, period: int) -> float:
    return float(series.ewm(span=period, adjust=False).mean().iloc[-1])


def rsi(series: pd.Series, period: int = 14) -> float:
    delta = series.diff()
    up = delta.clip(lower=0).rolling(period).mean()
    down = (-delta.clip(upper=0)).rolling(period).mean()
    rs = up / down.replace(0, np.nan)
    val = 100 - (100 / (1 + rs.iloc[-1]))
    return float(val) if not np.isnan(val) else 50.0


def swing_high(df: pd.DataFrame, lookback: int = 50) -> float:
    return float(df["high"].tail(lookback).max())


def swing_low(df: pd.DataFrame, lookback: int = 50) -> float:
    return float(df["low"].tail(lookback).min())


# ----------------------------- detectors ------------------------------------

def detect_fvgs(df: pd.DataFrame, max_age: int = 100) -> list[FVG]:
    fvgs: list[FVG] = []
    n = len(df)
    start = max(1, n - max_age - 1)
    end = n - 1  # need i+1 to exist
    h = df["high"].values
    l = df["low"].values
    for i in range(start, end):
        # bullish: gap between prev high and next low
        if h[i - 1] < l[i + 1]:
            fvgs.append(FVG(kind="bullish", bottom=float(h[i - 1]),
                            top=float(l[i + 1]), index=i))
        # bearish: gap between next high and prev low
        elif l[i - 1] > h[i + 1]:
            fvgs.append(FVG(kind="bearish", bottom=float(h[i + 1]),
                            top=float(l[i - 1]), index=i))
    # mark filled if price has since traded through
    last_close = float(df["close"].iloc[-1])
    last_high = float(df["high"].max())
    last_low = float(df["low"].min())
    for f in fvgs:
        post = df.iloc[f.index + 1:]
        if f.kind == "bullish":
            f.filled = bool((post["low"] <= f.bottom).any())
        else:
            f.filled = bool((post["high"] >= f.top).any())
    return fvgs


def detect_order_blocks(df: pd.DataFrame, fvgs: list[FVG]) -> list[OrderBlock]:
    obs: list[OrderBlock] = []
    o = df["open"].values
    c = df["close"].values
    h = df["high"].values
    l = df["low"].values
    for f in fvgs:
        # search backwards from FVG anchor for last opposite-color candle
        ob_kind = "bullish" if f.kind == "bullish" else "bearish"
        # bullish OB = last bearish (red) candle before bullish impulse
        # bearish OB = last bullish (green) candle before bearish impulse
        want_red = (ob_kind == "bullish")
        idx = None
        for j in range(f.index - 1, max(f.index - 10, -1), -1):
            is_red = c[j] < o[j]
            if want_red and is_red:
                idx = j
                break
            if (not want_red) and (c[j] > o[j]):
                idx = j
                break
        if idx is None:
            continue
        ob = OrderBlock(
            kind=ob_kind,
            top=float(h[idx]),
            bottom=float(l[idx]),
            index=idx,
            fvg_index=f.index,
        )
        # mitigated if price has revisited the zone after creation
        post = df.iloc[idx + 1:]
        if ob.kind == "bullish":
            ob.mitigated = bool((post["low"] <= ob.top).any() and
                                (post["low"] <= ob.bottom).any())
        else:
            ob.mitigated = bool((post["high"] >= ob.bottom).any() and
                                (post["high"] >= ob.top).any())
        obs.append(ob)
    return obs


# ----------------------------- signal generator -----------------------------

def generate_signal(symbol: str, timeframe: str,
                    candles: list[Candle]) -> StrategySignal:
    if len(candles) < 30:
        return StrategySignal(
            symbol=symbol, timeframe=timeframe, decision="WAIT",
            confidence=0.0, price=candles[-1].close if candles else 0.0,
            rationale="Insufficient candle history (need >= 30).",
        )

    df = candles_to_df(candles)
    price = float(df["close"].iloc[-1])
    a = atr(df)
    rsi_v = rsi(df["close"])
    ema20 = ema(df["close"], 20)
    ema50 = ema(df["close"], 50)
    trend = "up" if ema20 > ema50 else "down"

    fvgs = detect_fvgs(df)
    obs = detect_order_blocks(df, fvgs)

    # find the most recent valid (unmitigated) OB whose FVG is unfilled
    candidate: Optional[OrderBlock] = None
    paired_fvg: Optional[FVG] = None
    for ob in reversed(obs):
        f = next((x for x in fvgs if x.index == ob.fvg_index), None)
        if not f or f.filled or ob.mitigated:
            continue
        # require current price near OB (within 2 ATR)
        dist = min(abs(price - ob.top), abs(price - ob.bottom))
        if dist > 2 * a and not (ob.bottom <= price <= ob.top):
            continue
        candidate, paired_fvg = ob, f
        break

    indicators = {
        "ema20": ema20, "ema50": ema50, "rsi14": rsi_v,
        "atr14": a, "trend": trend,
        "swing_high": swing_high(df), "swing_low": swing_low(df),
        "fvg_count": len(fvgs), "ob_count": len(obs),
    }

    if not candidate or not paired_fvg:
        return StrategySignal(
            symbol=symbol, timeframe=timeframe, decision="WAIT",
            confidence=0.25, price=price,
            rationale="No unmitigated OB / unfilled FVG confluence near price.",
            indicators=indicators,
        )

    # build trade plan
    if candidate.kind == "bullish":
        entry = (candidate.top + candidate.bottom) / 2
        sl = candidate.bottom - a
        tp_liquidity = indicators["swing_high"]
        r = entry - sl
        tp = max(min(tp_liquidity, entry + 3 * r), entry + 1.5 * r)
        decision = "BUY"
    else:
        entry = (candidate.top + candidate.bottom) / 2
        sl = candidate.top + a
        tp_liquidity = indicators["swing_low"]
        r = sl - entry
        tp = min(max(tp_liquidity, entry - 3 * r), entry - 1.5 * r)
        decision = "SELL"

    # confidence model: trend alignment + RSI sanity + freshness
    trend_align = (decision == "BUY" and trend == "up") or \
                  (decision == "SELL" and trend == "down")
    rsi_ok = (decision == "BUY" and rsi_v < 65) or \
             (decision == "SELL" and rsi_v > 35)
    freshness = max(0.0, 1.0 - (len(df) - 1 - candidate.index) / 50)
    confidence = float(np.clip(
        0.40 + 0.20 * trend_align + 0.15 * rsi_ok + 0.25 * freshness, 0, 0.95
    ))

    rationale = (
        f"{candidate.kind.title()} OB at [{candidate.bottom:.5f}, "
        f"{candidate.top:.5f}] anchors an unfilled {paired_fvg.kind} FVG. "
        f"Price {price:.5f} is reacting to the zone. Trend {trend.upper()} "
        f"(EMA20 {ema20:.5f} vs EMA50 {ema50:.5f}), RSI14 {rsi_v:.1f}, "
        f"ATR14 {a:.5f}. Plan: entry {entry:.5f}, SL {sl:.5f}, TP {tp:.5f}."
    )

    return StrategySignal(
        symbol=symbol, timeframe=timeframe, decision=decision,
        confidence=confidence, price=price,
        entry=entry, sl=sl, tp=tp,
        ob=candidate, fvg=paired_fvg, rationale=rationale,
        indicators=indicators,
    )

from __future__ import annotations
from typing import Any, Optional, Literal
from pydantic import BaseModel, Field

Decision = Literal["BUY", "SELL", "WAIT"]
Mode = Literal["demo", "live"]
Side = Literal["BUY", "SELL"]


class Candle(BaseModel):
    epoch: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class FVG(BaseModel):
    kind: Literal["bullish", "bearish"]
    top: float
    bottom: float
    index: int          # index of middle candle in series
    filled: bool = False


class OrderBlock(BaseModel):
    kind: Literal["bullish", "bearish"]
    top: float
    bottom: float
    index: int          # index of OB candle
    fvg_index: int      # the FVG this OB anchors
    mitigated: bool = False


class StrategySignal(BaseModel):
    symbol: str
    timeframe: str
    decision: Decision
    confidence: float = Field(ge=0, le=1)
    price: float
    entry: Optional[float] = None
    sl: Optional[float] = None
    tp: Optional[float] = None
    ob: Optional[OrderBlock] = None
    fvg: Optional[FVG] = None
    rationale: str
    indicators: dict[str, Any] = {}


class PredictRequest(BaseModel):
    symbol: str = "R_10"
    timeframe: str = "1m"
    lookback: int = 200


class ReasonRequest(BaseModel):
    symbol: str
    timeframe: str = "1m"
    indicators: dict[str, Any]
    prediction: dict[str, Any]
    market_state: dict[str, Any] = {}


class ReasonResponse(BaseModel):
    decision: Decision
    confidence: float
    risk_score: float
    success_probability: float
    reasoning: str
    trade_plan: dict[str, Any]


class PaperTradeRequest(BaseModel):
    symbol: str
    side: Side
    size: float
    entry: Optional[float] = None
    sl: Optional[float] = None
    tp: Optional[float] = None
    prediction_id: Optional[str] = None


class TradeRequest(PaperTradeRequest):
    pass


class TradeResponse(BaseModel):
    ok: bool
    trade_id: Optional[str] = None
    contract_id: Optional[str] = None
    message: str
    pnl: Optional[float] = None


class FeedbackRequest(BaseModel):
    prediction_id: str
    rating: int = Field(ge=1, le=5)
    comment: Optional[str] = None


class RetrainRequest(BaseModel):
    model_name: str
    reason: Optional[str] = None

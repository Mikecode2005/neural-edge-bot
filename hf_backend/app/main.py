"""
AI Trading Backend — FastAPI entry point with auto-trading loop.
"""
from __future__ import annotations
import asyncio, json, logging
from datetime import datetime, timezone
from typing import Optional
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from . import supabase_client as sb
from .config import get_settings
from .deriv_client import DerivClient, DerivError
from .paper_trader import open_paper_trade, close_paper_trade, get_or_create_portfolio
from .prediction_engine import ensemble, heuristic_forecast
from .qwen_reasoner import reason as qwen_reason
from .risk import validate_trade
from .schemas import (PredictRequest, ReasonRequest, PaperTradeRequest,
    TradeRequest, TradeResponse, FeedbackRequest, RetrainRequest, StrategySignal)
from .strategy_ob_fvg import generate_signal

log = logging.getLogger("uvicorn.error")
settings = get_settings()
app = FastAPI(title="AI Trading Backend", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

_bot_running = False
_bot_task: Optional[asyncio.Task] = None
_bot_config = {"symbol":"R_10","timeframe":"1m","max_trades":10,"risk_percent":2.0,
    "mode":"demo","trade_count":0,"last_signal":None,"started_at":None}
_ws_connections: dict[str,set] = {}


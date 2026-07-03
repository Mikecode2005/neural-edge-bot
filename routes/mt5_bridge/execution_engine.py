"""
MT5 Execution Engine (Step 8).

The central orchestrator that:
- Connects/disconnects from MT5
- Manages symbol specs, filling modes, prices, stops
- Validates every trade before sending
- Runs order_check() before order_send()
- Retries with alternative filling modes on failure
- Logs every stage
- Converts MT5 errors to human-readable responses

All FastAPI endpoints MUST use this engine. The frontend never constructs MT5 requests directly.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .symbol_manager import SymbolManager, SymbolSpec
from .filling_detector import FillingModeDetector, FILLING_MODE_NAMES
from .price_manager import PriceManager
from .stop_calculator import StopCalculator
from .trade_validator import TradeValidator, ValidationResult, VALID
from .error_codes import translate_retcode, retcode_to_http_exception, TRADE_RETCODE_CODES

log = logging.getLogger("uvicorn.error")

# MT5 order type constants
ORDER_TYPE_BUY = 0
ORDER_TYPE_SELL = 1
ORDER_TYPE_BUY_LIMIT = 2
ORDER_TYPE_SELL_LIMIT = 3
ORDER_TYPE_BUY_STOP = 4
ORDER_TYPE_SELL_STOP = 5

# Trade actions
TRADE_ACTION_DEAL = 1
TRADE_ACTION_PENDING = 5
TRADE_ACTION_SLTP = 6
TRADE_ACTION_MODIFY = 7
TRADE_ACTION_REMOVE = 8

# Order time
ORDER_TIME_GTC = 0
ORDER_TIME_DAY = 1
ORDER_TIME_SPECIFIED = 2
ORDER_TIME_SPECIFIED_DAY = 3

# Filling modes
ORDER_FILLING_FOK = 0
ORDER_FILLING_IOC = 1
ORDER_FILLING_RETURN = 2


@dataclass
class TradeRequest:
    """Normalized trade request from the AI/frontend."""
    symbol: str
    side: str  # "buy" or "sell"
    volume: float
    sl: float = 0.0
    tp: float = 0.0
    comment: str = ""
    magic: int = 0
    deviation: int = 20


@dataclass
class TradeResult:
    """Result of a trade execution attempt."""
    success: bool
    retcode: int
    ticket: int = 0
    volume: float = 0.0
    price: float = 0.0
    message: str = ""
    comment: str = ""
    filling_mode_used: int = 0
    sl: float = 0.0
    tp: float = 0.0
    entry_price: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "retcode": self.retcode,
            "ticket": self.ticket,
            "volume": self.volume,
            "price": self.price,
            "message": self.message,
            "comment": self.comment,
            "fillingModeUsed": FILLING_MODE_NAMES.get(self.filling_mode_used, str(self.filling_mode_used)),
            "sl": self.sl,
            "tp": self.tp,
            "entryPrice": self.entry_price,
        }


class MT5ExecutionEngine:
    """Complete execution engine for MetaTrader 5.

    Usage:
        engine = MT5ExecutionEngine(mt5_module)
        engine.connect()
        result = engine.send_order(TradeRequest(symbol="Volatility 10 Index", side="buy", volume=0.5, sl=9770.0, tp=9790.0))
    """

    def __init__(self, mt5_module: Any):
        self._mt5 = mt5_module
        self._symbol_manager = SymbolManager(mt5_module)
        self._filling_detector = FillingModeDetector(mt5_module)
        self._price_manager = PriceManager()
        self._stop_calculator = StopCalculator()
        self._validator = TradeValidator()
        self._initialized = False
        self._login = 0
        self._server = ""

    # ── Connection Management ──

    def connect(self, login: int = 0, password: str = "", server: str = "") -> dict[str, Any]:
        """Initialize MT5 and optionally log in."""
        mt5 = self._mt5

        if self._initialized:
            self.disconnect()

        log.info("ExecutionEngine: initializing MT5...")
        initialized = mt5.initialize()
        if not initialized:
            error = mt5.last_error()
            log.error("ExecutionEngine: MT5 initialize() failed: %s", error)
            return {"success": False, "error": f"MT5 initialize() failed: {error}"}

        self._initialized = True
        log.info("ExecutionEngine: MT5 initialized successfully")

        if login > 0:
            log.info("ExecutionEngine: logging in as %s@%s", login, server)
            authorized = mt5.login(login, password=password, server=server)
            if not authorized:
                error = mt5.last_error()
                mt5.shutdown()
                self._initialized = False
                log.error("ExecutionEngine: MT5 login failed: %s", error)
                return {"success": False, "error": f"MT5 login failed: {error}"}
            self._login = login
            self._server = server
            log.info("ExecutionEngine: logged in as %s@%s", login, server)
        else:
            self._login = 0
            self._server = ""
            log.info("ExecutionEngine: initialized without login")

        return {"success": True, "login": self._login, "server": self._server}

    def disconnect(self) -> None:
        """Shut down MT5 connection."""
        if self._initialized:
            self._mt5.shutdown()
            self._initialized = False
            self._login = 0
            self._server = ""
            self._symbol_manager.clear()
            self._filling_detector.clear()
            log.info("ExecutionEngine: disconnected")

    def is_connected(self) -> bool:
        return self._initialized

    # ── Account Info ──

    def get_account(self) -> Optional[dict[str, Any]]:
        """Get account information as a dict."""
        if not self._initialized:
            return None
        mt5 = self._mt5
        info = mt5.account_info()
        if info is None:
            return None
        return {
            "login": info.login,
            "balance": info.balance,
            "equity": info.equity,
            "margin": info.margin,
            "marginFree": info.margin_free,
            "marginLevel": info.margin_level,
            "currency": info.currency,
            "server": info.server,
            "name": info.name,
            "company": info.company,
            "leverage": info.leverage,
        }

    # ── Symbol Info ──

    def get_symbol(self, symbol: str) -> Optional[dict[str, Any]]:
        """Get symbol information as a dict."""
        spec = self._symbol_manager.get(symbol)
        if spec is None:
            return None
        return {
            "symbol": spec.name,
            "digits": spec.digits,
            "point": spec.point,
            "tickSize": spec.tick_size,
            "bid": spec.bid,
            "ask": spec.ask,
            "volumeMin": spec.volume_min,
            "volumeMax": spec.volume_max,
            "volumeStep": spec.volume_step,
            "tradeStopsLevel": spec.trade_stops_level,
            "tradeFreezeLevel": spec.trade_freeze_level,
            "spread": spec.spread,
            "tradeMode": spec.trade_mode,
            "tradeExemode": spec.trade_exemode,
            "fillingMode": spec.filling_mode,
            "visible": spec.visible,
        }

    # ── Positions ──

    def positions(self, symbol: str = "") -> list[dict[str, Any]]:
        """Get all open positions, optionally filtered by symbol."""
        if not self._initialized:
            return []
        mt5 = self._mt5
        if symbol:
            pos_list = mt5.positions_get(symbol=symbol)
        else:
            pos_list = mt5.positions_get()
        if pos_list is None:
            return []
        return [self._position_to_dict(p) for p in pos_list]

    def _position_to_dict(self, pos: Any) -> dict[str, Any]:
        return {
            "ticket": pos.ticket,
            "symbol": pos.symbol,
            "type": "buy" if pos.type == 0 else "sell",
            "volume": pos.volume,
            "priceOpen": pos.price_open,
            "priceCurrent": pos.price_current,
            "sl": pos.sl,
            "tp": pos.tp,
            "profit": pos.profit,
            "swap": pos.swap,
            "comment": pos.comment,
            "magic": pos.magic,
            "time": int(pos.time),
        }

    # ── History ──

    def history(self, from_date: int = 0, to_date: int = 0) -> list[dict[str, Any]]:
        """Get trade history."""
        if not self._initialized:
            return []
        mt5 = self._mt5
        if from_date == 0:
            from_date = int(time.time()) - 86400 * 7  # last 7 days
        if to_date == 0:
            to_date = int(time.time())
        deals = mt5.history_deals_get(from_date, to_date)
        if deals is None:
            return []
        return [{
            "ticket": d.ticket,
            "symbol": d.symbol,
            "type": d.type,
            "volume": d.volume,
            "price": d.price,
            "profit": d.profit,
            "time": int(d.time),
            "comment": d.comment,
            "magic": d.magic,
        } for d in deals]

    # ── Orders (pending) ──

    def orders(self) -> list[dict[str, Any]]:
        """Get pending orders."""
        if not self._initialized:
            return []
        mt5 = self._mt5
        orders_list = mt5.orders_get()
        if orders_list is None:
            return []
        return [{
            "ticket": o.ticket,
            "symbol": o.symbol,
            "type": o.type,
            "volume": o.volume,
            "price": o.price_open,
            "sl": o.sl,
            "tp": o.tp,
            "time": int(o.time_setup),
            "expiration": int(o.time_expiration),
            "comment": o.comment,
            "magic": o.magic,
        } for o in orders_list]

    # ── Core: Send Order ──

    def send_order(self, request: TradeRequest) -> TradeResult:
        """The main entry point for executing a trade.

        This method:
        1. Gets symbol spec
        2. Validates the trade
        3. Calculates correct prices (BUY=ask, SELL=bid)
        4. Calculates valid SL/TP
        5. Detects supported filling mode
        6. Runs order_check()
        7. Runs order_send()
        8. Retries with alternative filling modes if needed
        9. Returns a detailed TradeResult
        """
        log.info("=" * 60)
        log.info("ExecutionEngine: NEW TRADE REQUEST")
        log.info("  symbol=%s side=%s volume=%s sl=%s tp=%s",
                 request.symbol, request.side, request.volume, request.sl, request.tp)
        log.info("=" * 60)

        # Step 1: Get symbol spec
        spec = self._symbol_manager.get(request.symbol)
        if spec is None:
            log.error("ExecutionEngine: Symbol %s not found", request.symbol)
            return TradeResult(
                success=False, retcode=-1,
                message=f"Symbol '{request.symbol}' not found in MT5",
            )

        # Ensure symbol is selected in Market Watch
        mt5 = self._mt5
        mt5.symbol_select(request.symbol, True)

        # Refresh spec after selection
        spec = self._symbol_manager.get(request.symbol)
        if spec is None:
            return TradeResult(success=False, retcode=-1, message=f"Symbol '{request.symbol}' not available")

        # Step 2: Determine order type
        order_type = ORDER_TYPE_BUY if request.side.lower() == "buy" else ORDER_TYPE_SELL
        log.info("ExecutionEngine: order_type = %s", "BUY" if order_type == ORDER_TYPE_BUY else "SELL")

        # Step 3: Get correct entry price
        entry_price = self._price_manager.get_entry_price(spec, order_type)
        if entry_price <= 0:
            return TradeResult(
                success=False, retcode=-1,
                message=f"Cannot get valid entry price for {request.symbol}. "
                        f"bid={spec.bid} ask={spec.ask}",
            )
        log.info("ExecutionEngine: entry_price = %.5f", entry_price)

        # Step 4: Normalize volume
        volume = self._validator.normalize_volume(spec, request.volume)
        log.info("ExecutionEngine: volume = %s (normalized from %s)", volume, request.volume)

        # Step 5: Validate trade
        validation = self._validator.validate(spec, order_type, volume, entry_price)
        if not validation:
            log.error("ExecutionEngine: VALIDATION FAILED: %s", validation.reason)
            return TradeResult(
                success=False, retcode=-1,
                message=f"Trade validation failed: {validation.reason}",
            )
        log.info("ExecutionEngine: validation PASSED")

        # Step 6: Calculate valid SL and TP
        valid_sl = self._stop_calculator.calculate_valid_sl(
            spec, order_type, entry_price, request.sl,
        )
        valid_tp = self._stop_calculator.calculate_valid_tp(
            spec, order_type, entry_price, request.tp, valid_sl,
        )
        log.info("ExecutionEngine: valid_sl=%.5f valid_tp=%.5f", valid_sl, valid_tp)

        # Step 7: Detect supported filling mode
        filling_mode = self._filling_detector.get_best(
            request.symbol, volume, order_type, entry_price,
        )
        log.info("ExecutionEngine: selected filling_mode = %s",
                 FILLING_MODE_NAMES.get(filling_mode, str(filling_mode)))

        # Step 8: Build the MT5 request
        mt5_request = self._build_request(
            spec=spec,
            order_type=order_type,
            volume=volume,
            price=entry_price,
            sl=valid_sl,
            tp=valid_tp,
            filling_mode=filling_mode,
            deviation=request.deviation,
            magic=request.magic,
            comment=request.comment,
        )
        log.info("ExecutionEngine: MT5 request built: %s", mt5_request)

        # Step 9: Run order_check()
        check_result = self._check_order(mt5_request)
        if check_result is not None:
            # order_check failed
            log.error("ExecutionEngine: order_check FAILED: retcode=%d %s",
                      check_result.retcode, check_result.comment)
            return TradeResult(
                success=False,
                retcode=check_result.retcode,
                message=TRADE_RETCODE_CODES.get(check_result.retcode, f"Order check failed (retcode={check_result.retcode})"),
                comment=str(check_result.comment),
            )
        log.info("ExecutionEngine: order_check PASSED")

        # Step 10: Send the order
        result = self._send_with_retry(mt5_request, filling_mode, spec, order_type, volume, entry_price)

        log.info("ExecutionEngine: FINAL RESULT: success=%s retcode=%d ticket=%d message=%s",
                 result.success, result.retcode, result.ticket, result.message)
        log.info("=" * 60)

        return result

    def _build_request(
        self,
        spec: SymbolSpec,
        order_type: int,
        volume: float,
        price: float,
        sl: float,
        tp: float,
        filling_mode: int,
        deviation: int = 20,
        magic: int = 0,
        comment: str = "",
    ) -> dict[str, Any]:
        """Build a complete MT5 trade request dict."""
        mt5 = self._mt5
        return {
            "action": TRADE_ACTION_DEAL,
            "symbol": spec.name,
            "volume": volume,
            "type": order_type,
            "price": price,
            "sl": sl,
            "tp": tp,
            "deviation": deviation,
            "magic": magic,
            "comment": comment or "",
            "type_time": ORDER_TIME_GTC,
            "type_filling": filling_mode,
        }

    def _check_order(self, request: dict[str, Any]) -> Optional[Any]:
        """Run order_check(). Returns None if OK, or the check result if failed."""
        mt5 = self._mt5
        try:
            check = mt5.order_check(request)
            if check is None:
                log.warning("ExecutionEngine: order_check returned None")
                return None  # Some brokers don't support order_check
            if check.retcode != 0:
                log.warning(
                    "ExecutionEngine: order_check retcode=%d comment=%s",
                    check.retcode, check.comment,
                )
                return check
            return None  # retcode == 0 means OK
        except Exception as e:
            log.warning("ExecutionEngine: order_check exception: %s", e)
            return None  # Don't block the trade if order_check itself fails

    def _send_with_retry(
        self,
        request: dict[str, Any],
        initial_filling_mode: int,
        spec: SymbolSpec,
        order_type: int,
        volume: float,
        entry_price: float,
    ) -> TradeResult:
        """Send the order, retrying with alternative filling modes on failure."""
        mt5 = self._mt5

        # Try the initial request
        result = self._try_send(request)
        if result is not None and result.retcode == 10009:
            return self._result_from_mt5(result, request, entry_price, True)

        # If the failure is "unsupported filling mode", retry with alternatives
        if result is not None and result.retcode == 10030:
            log.info("ExecutionEngine: retrying with alternative filling modes...")
            alternatives = self._get_alternative_filling_modes(initial_filling_mode)

            for alt_mode in alternatives:
                log.info("ExecutionEngine: trying filling_mode = %s",
                         FILLING_MODE_NAMES.get(alt_mode, str(alt_mode)))
                request["type_filling"] = alt_mode
                result = self._try_send(request)
                if result is not None and result.retcode == 10009:
                    return self._result_from_mt5(result, request, entry_price, True)

            # Last resort: try without type_filling
            log.info("ExecutionEngine: trying without type_filling...")
            request.pop("type_filling", None)
            result = self._try_send(request)
            if result is not None and result.retcode == 10009:
                return self._result_from_mt5(result, request, entry_price, True)

        # If the failure is "invalid stops", recalculate and retry once
        if result is not None and result.retcode == 10016:
            log.info("ExecutionEngine: retrying with recalculated stops...")
            # Recalculate SL/TP more conservatively
            new_sl = self._stop_calculator.calculate_valid_sl(
                spec, order_type, entry_price, request.get("sl", 0),
            )
            new_tp = self._stop_calculator.calculate_valid_tp(
                spec, order_type, entry_price, request.get("tp", 0), new_sl,
            )
            # Make the stop distance even larger
            min_dist = spec.trade_stops_level * spec.point if spec.trade_stops_level > 0 else spec.spread * spec.point * 3
            if order_type == ORDER_TYPE_BUY:
                if new_sl > 0:
                    new_sl = entry_price - max(min_dist, entry_price - new_sl + spec.point * 5)
                if new_tp > 0:
                    new_tp = entry_price + max(min_dist, new_tp - entry_price + spec.point * 5)
            else:
                if new_sl > 0:
                    new_sl = entry_price + max(min_dist, new_sl - entry_price + spec.point * 5)
                if new_tp > 0:
                    new_tp = entry_price - max(min_dist, entry_price - new_tp + spec.point * 5)

            request["sl"] = self._price_manager.normalize_price(spec, new_sl)
            request["tp"] = self._price_manager.normalize_price(spec, new_tp)
            log.info("ExecutionEngine: retry with sl=%.5f tp=%.5f", request["sl"], request["tp"])

            result = self._try_send(request)
            if result is not None and result.retcode == 10009:
                return self._result_from_mt5(result, request, entry_price, True)

        # All retries exhausted
        if result is None:
            err = mt5.last_error()
            log.error("ExecutionEngine: order_send returned None: %s", err)
            return TradeResult(
                success=False, retcode=-1,
                message=f"Order send failed: {err}",
            )

        return self._result_from_mt5(result, request, entry_price, False)

    def _try_send(self, request: dict[str, Any]) -> Optional[Any]:
        """Execute mt5.order_send() and return the result."""
        mt5 = self._mt5
        try:
            result = mt5.order_send(request)
            if result is not None:
                log.info(
                    "ExecutionEngine: order_send retcode=%d ticket=%s volume=%s price=%s comment=%s",
                    result.retcode,
                    getattr(result, "order", getattr(result, "ticket", "N/A")),
                    result.volume,
                    result.price,
                    result.comment,
                )
            return result
        except Exception as e:
            log.error("ExecutionEngine: order_send exception: %s", e)
            return None

    def _get_alternative_filling_modes(self, current_mode: int) -> list[int]:
        """Get alternative filling modes to try, ordered by preference."""
        all_modes = [ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN]
        return [m for m in all_modes if m != current_mode]

    def _result_from_mt5(
        self,
        mt5_result: Any,
        request: dict[str, Any],
        entry_price: float,
        success: bool,
    ) -> TradeResult:
        """Convert an MT5 order_send result to a TradeResult."""
        retcode = mt5_result.retcode
        ticket = getattr(mt5_result, "order", getattr(mt5_result, "ticket", 0))
        message = TRADE_RETCODE_CODES.get(retcode, f"Unknown retcode {retcode}")

        return TradeResult(
            success=success,
            retcode=retcode,
            ticket=ticket,
            volume=request.get("volume", 0),
            price=request.get("price", 0),
            message=message,
            comment=str(mt5_result.comment) if hasattr(mt5_result, "comment") else "",
            filling_mode_used=request.get("type_filling", 0),
            sl=request.get("sl", 0),
            tp=request.get("tp", 0),
            entry_price=entry_price,
        )

    # ── Modify Position ──

    def modify_position(self, ticket: int, sl: float = 0.0, tp: float = 0.0) -> TradeResult:
        """Modify SL/TP on an existing position."""
        if not self._initialized:
            return TradeResult(success=False, retcode=-1, message="MT5 not initialized")

        mt5 = self._mt5
        pos_list = mt5.positions_get(ticket=ticket)
        if pos_list is None or len(pos_list) == 0:
            return TradeResult(success=False, retcode=-1, message=f"Position #{ticket} not found")

        position = pos_list[0]
        spec = self._symbol_manager.get(position.symbol)
        if spec is None:
            return TradeResult(success=False, retcode=-1, message=f"Symbol {position.symbol} not found")

        order_type = position.type  # 0=BUY, 1=SELL
        entry_price = position.price_open

        valid_sl = self._stop_calculator.calculate_valid_sl(spec, order_type, entry_price, sl) if sl != 0 else 0.0
        valid_tp = self._stop_calculator.calculate_valid_tp(spec, order_type, entry_price, tp, valid_sl) if tp != 0 else 0.0

        request = {
            "action": TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol": position.symbol,
            "sl": valid_sl,
            "tp": valid_tp,
            "magic": position.magic,
            "comment": "Modified by ExecutionEngine",
        }

        log.info("ExecutionEngine: modifying position %d sl=%.5f tp=%.5f", ticket, valid_sl, valid_tp)
        result = mt5.order_send(request)
        if result is None:
            err = mt5.last_error()
            return TradeResult(success=False, retcode=-1, message=f"Modify failed: {err}")

        return self._result_from_mt5(result, request, entry_price, result.retcode == 10009)

    # ── Close Position ──

    def close_position(self, ticket: int) -> TradeResult:
        """Close a position by ticket number."""
        if not self._initialized:
            return TradeResult(success=False, retcode=-1, message="MT5 not initialized")

        mt5 = self._mt5
        pos_list = mt5.positions_get(ticket=ticket)
        if pos_list is None or len(pos_list) == 0:
            return TradeResult(success=False, retcode=-1, message=f"Position #{ticket} not found")

        position = pos_list[0]
        spec = self._symbol_manager.get(position.symbol)
        if spec is None:
            return TradeResult(success=False, retcode=-1, message=f"Symbol {position.symbol} not found")

        # Determine close direction
        close_type = ORDER_TYPE_SELL if position.type == 0 else ORDER_TYPE_BUY
        close_price = spec.bid if position.type == 0 else spec.ask

        # Detect filling mode
        filling_mode = self._filling_detector.get_best(
            position.symbol, position.volume, close_type, close_price,
        )

        request = {
            "action": TRADE_ACTION_DEAL,
            "symbol": position.symbol,
            "volume": position.volume,
            "type": close_type,
            "position": ticket,
            "price": close_price,
            "deviation": 20,
            "magic": position.magic,
            "comment": "Closed by ExecutionEngine",
            "type_time": ORDER_TIME_GTC,
            "type_filling": filling_mode,
        }

        log.info("ExecutionEngine: closing position %d %s volume=%s price=%.5f",
                 ticket, position.symbol, position.volume, close_price)

        result = mt5.order_send(request)
        if result is None:
            err = mt5.last_error()
            return TradeResult(success=False, retcode=-1, message=f"Close failed: {err}")

        return self._result_from_mt5(result, request, close_price, result.retcode == 10009)

    # ── Close Partial ──

    def close_partial(self, ticket: int, volume: float) -> TradeResult:
        """Close part of a position."""
        if not self._initialized:
            return TradeResult(success=False, retcode=-1, message="MT5 not initialized")

        mt5 = self._mt5
        pos_list = mt5.positions_get(ticket=ticket)
        if pos_list is None or len(pos_list) == 0:
            return TradeResult(success=False, retcode=-1, message=f"Position #{ticket} not found")

        position = pos_list[0]
        spec = self._symbol_manager.get(position.symbol)
        if spec is None:
            return TradeResult(success=False, retcode=-1, message=f"Symbol {position.symbol} not found")

        # Normalize volume
        volume = self._validator.normalize_volume(spec, volume)
        if volume > position.volume:
            volume = position.volume

        close_type = ORDER_TYPE_SELL if position.type == 0 else ORDER_TYPE_BUY
        close_price = spec.bid if position.type == 0 else spec.ask

        filling_mode = self._filling_detector.get_best(
            position.symbol, volume, close_type, close_price,
        )

        request = {
            "action": TRADE_ACTION_DEAL,
            "symbol": position.symbol,
            "volume": volume,
            "type": close_type,
            "position": ticket,
            "price": close_price,
            "deviation": 20,
            "magic": position.magic,
            "comment": "Partial close by ExecutionEngine",
            "type_time": ORDER_TIME_GTC,
            "type_filling": filling_mode,
        }

        log.info("ExecutionEngine: partial close position %d volume=%s price=%.5f",
                 ticket, volume, close_price)

        result = mt5.order_send(request)
        if result is None:
            err = mt5.last_error()
            return TradeResult(success=False, retcode=-1, message=f"Partial close failed: {err}")

        return self._result_from_mt5(result, request, close_price, result.retcode == 10009)

    # ── Utility ──

    def get_supported_filling(self, symbol: str) -> list[str]:
        """Get human-readable list of supported filling modes for a symbol."""
        spec = self._symbol_manager.get(symbol)
        if spec is None:
            return []
        mt5 = self._mt5
        # Use a dummy request to detect
        modes = self._filling_detector.get_supported(
            symbol, spec.volume_min, ORDER_TYPE_BUY, spec.ask if spec.ask > 0 else 1.0,
        )
        return [FILLING_MODE_NAMES.get(m, str(m)) for m in modes]

    def validate_trade(self, symbol: str, side: str, volume: float, sl: float = 0.0, tp: float = 0.0) -> dict[str, Any]:
        """Validate a trade without executing it. Returns validation result."""
        spec = self._symbol_manager.get(symbol)
        if spec is None:
            return {"valid": False, "reason": f"Symbol '{symbol}' not found"}

        order_type = ORDER_TYPE_BUY if side.lower() == "buy" else ORDER_TYPE_SELL
        entry_price = self._price_manager.get_entry_price(spec, order_type)
        volume = self._validator.normalize_volume(spec, volume)

        validation = self._validator.validate(spec, order_type, volume, entry_price)
        if not validation:
            return {"valid": False, "reason": validation.reason}

        valid_sl = self._stop_calculator.calculate_valid_sl(spec, order_type, entry_price, sl)
        valid_tp = self._stop_calculator.calculate_valid_tp(spec, order_type, entry_price, tp, valid_sl)

        return {
            "valid": True,
            "symbol": symbol,
            "side": side,
            "volume": volume,
            "entryPrice": entry_price,
            "sl": valid_sl,
            "tp": valid_tp,
            "bid": spec.bid,
            "ask": spec.ask,
            "digits": spec.digits,
            "point": spec.point,
            "tickSize": spec.tick_size,
            "volumeMin": spec.volume_min,
            "volumeMax": spec.volume_max,
            "volumeStep": spec.volume_step,
            "tradeStopsLevel": spec.trade_stops_level,
        }
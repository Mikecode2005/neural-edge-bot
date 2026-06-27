"""
Qwen reasoning engine via Hugging Face Inference API (chat completions).

Qwen is NOT a forecaster — it ingests structured market context and emits
a trading decision with rationale.
"""
from __future__ import annotations
import json
import re
from typing import Any
import httpx

from .config import get_settings
from .schemas import ReasonResponse


SYSTEM_PROMPT = """You are the reasoning engine of an autonomous trading system.
You receive structured market context (indicators, prediction model output,
detected Order Blocks / Fair Value Gaps) and must decide BUY, SELL, or WAIT.

Be conservative. WAIT is always a valid output. Never invent prices.

Respond ONLY with a single minified JSON object matching this schema:

{
  "decision": "BUY" | "SELL" | "WAIT",
  "confidence": <float 0..1>,
  "risk_score": <float 0..1>,        // 0 = low risk, 1 = high risk
  "success_probability": <float 0..1>,
  "reasoning": "<concise plain-English rationale, 1-3 sentences>",
  "trade_plan": {
    "entry": <float>, "sl": <float>, "tp": <float>,
    "size_hint": <float 0..1>        // fraction of risk budget
  }
}
"""


def _build_user_prompt(symbol: str, timeframe: str,
                       indicators: dict, prediction: dict,
                       market_state: dict) -> str:
    payload = {
        "symbol": symbol,
        "timeframe": timeframe,
        "indicators": indicators,
        "prediction_model_output": prediction,
        "market_state": market_state,
    }
    return (
        "Market context:\n"
        f"{json.dumps(payload, default=str)}\n\n"
        "Return the JSON decision now."
    )


def _fallback(prediction: dict, indicators: dict) -> ReasonResponse:
    """Deterministic fallback when the LLM call fails or returns garbage."""
    direction = prediction.get("direction", "flat")
    decision = "BUY" if direction == "up" else "SELL" if direction == "down" else "WAIT"
    conf = float(prediction.get("confidence", 0.3))
    return ReasonResponse(
        decision=decision if conf > 0.4 else "WAIT",
        confidence=conf,
        risk_score=1.0 - conf,
        success_probability=conf,
        reasoning=("Qwen unavailable — fell back to deterministic rule using "
                   f"prediction direction={direction}, conf={conf:.2f}."),
        trade_plan={
            "entry": indicators.get("price", 0),
            "sl": 0, "tp": 0, "size_hint": min(conf, 0.5),
        },
    )


def _extract_json(text: str) -> dict[str, Any] | None:
    # Try direct
    try:
        return json.loads(text)
    except Exception:
        pass
    # Try first {...} block
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


async def reason(symbol: str, timeframe: str,
                 indicators: dict, prediction: dict,
                 market_state: dict) -> ReasonResponse:
    s = get_settings()
    if not s.HF_TOKEN:
        return _fallback(prediction, indicators)

    url = f"https://api-inference.huggingface.co/models/{s.QWEN_MODEL}/v1/chat/completions"
    headers = {"Authorization": f"Bearer {s.HF_TOKEN}",
               "Content-Type": "application/json"}
    body = {
        "model": s.QWEN_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _build_user_prompt(
                symbol, timeframe, indicators, prediction, market_state)},
        ],
        "temperature": 0.2,
        "max_tokens": 400,
        "response_format": {"type": "json_object"},
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, headers=headers, json=body)
            r.raise_for_status()
            data = r.json()
            content = data["choices"][0]["message"]["content"]
        parsed = _extract_json(content)
        if not parsed:
            return _fallback(prediction, indicators)
        return ReasonResponse(
            decision=parsed.get("decision", "WAIT"),
            confidence=float(parsed.get("confidence", 0.3)),
            risk_score=float(parsed.get("risk_score", 0.5)),
            success_probability=float(parsed.get("success_probability", 0.5)),
            reasoning=str(parsed.get("reasoning", "")),
            trade_plan=parsed.get("trade_plan", {}) or {},
        )
    except Exception as e:
        fb = _fallback(prediction, indicators)
        fb.reasoning = f"[Qwen error: {type(e).__name__}] " + fb.reasoning
        return fb

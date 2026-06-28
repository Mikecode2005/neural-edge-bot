import type { DerivCandle } from "@/lib/deriv/ws";
import type { LiveAnalysis } from "@/lib/ob-fvg";

const DEFAULT_HF_MODEL = "Qwen/Qwen2.5-7B-Instruct:together";

const DOCTRINE = `You are an expert Smart Money Concepts (SMC) trader specialising in synthetic indices on Deriv.
The strategy is Order Block + Fair Value Gap (OB + FVG).

CORE RULES (apply strictly):
1. FAIR VALUE GAP (FVG / imbalance): a three-candle pattern where candle1.high < candle3.low (bullish FVG) or candle1.low > candle3.high (bearish FVG). The gap is between candle1's extreme and candle3's opposite extreme.
2. ORDER BLOCK (OB): the last opposite-colour candle BEFORE the impulse leg that created the FVG. Bullish OB = last bearish candle before a strong bullish move; bearish OB = last bullish candle before a strong bearish move.
3. ENTRY: only when current price has returned into the OB zone AND price action shows rejection (wick rejection, or a small reversal candle). Never chase price away from the OB.
4. STOP LOSS: just beyond the OB extreme (low for bullish, high for bearish) + small buffer (~1 pip-equivalent).
5. TAKE PROFIT: next liquidity pool — recent swing high (for longs) or swing low (for shorts). Aim for at least 1.5R.
6. INVALIDATION: skip the setup if (a) the FVG has already been mitigated (price closed through it), (b) the OB has been broken, (c) higher-timeframe trend opposes the trade direction.
7. RISK: stake should be conservative and must not exceed 2% of balance.
8. If no clean setup is present, return direction=NONE with confidence < 0.4. DO NOT FORCE TRADES.

OUTPUT: respond with ONLY a JSON object (no markdown, no prose outside JSON) matching:
{
 "direction": "CALL" | "PUT" | "NONE",
 "confidence": 0..1,
 "stake": number,
 "duration": integer,
 "duration_unit": "t"|"s"|"m"|"h",
 "take_profit": number | null,
 "stop_loss": number | null,
 "reasoning": string,
 "lesson": string | null
}`;

export interface ClientAIResult {
  decision_id?: string;
  direction: "CALL" | "PUT" | "NONE";
  confidence: number;
  stake: number | null;
  duration: number | null;
  duration_unit: "t" | "s" | "m" | "h" | null;
  take_profit: number | null;
  stop_loss: number | null;
  reasoning: string;
  lesson_added: boolean;
  model: string;
}

interface AnalyzeWithHfRouterInput {
  symbol: string;
  timeframe: string;
  candles: DerivCandle[];
  analysis: LiveAnalysis;
  currentPrice: number;
  balance: number;
}

function getHfConfig() {
  const apiKey = import.meta.env.VITE_HF_API_KEY as string | undefined;
  const routerUrl = (import.meta.env.VITE_HF_ROUTER_URL as string | undefined) ?? "https://router.huggingface.co/v1";
  const model = (import.meta.env.VITE_HF_MODEL as string | undefined) ?? DEFAULT_HF_MODEL;

  if (!apiKey) {
    throw new Error("VITE_HF_API_KEY is not configured. Add it to .env and restart the Vite dev server.");
  }

  return {
    apiKey,
    model,
    chatCompletionsUrl: `${routerUrl.replace(/\/$/, "")}/chat/completions`,
  };
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("HF response did not contain a JSON object");
  return match[0];
}

function asNumberOrNull(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function analyzeMarketWithHfRouter({
  symbol,
  timeframe,
  candles,
  analysis,
  currentPrice,
  balance,
}: AnalyzeWithHfRouterInput): Promise<ClientAIResult> {
  const { apiKey, chatCompletionsUrl, model } = getHfConfig();
  const recent = candles.slice(-60);

  const userPrompt = JSON.stringify({
    symbol,
    timeframe,
    current_price: currentPrice,
    balance,
    local_signal: {
      decision: analysis.decision,
      confidence: analysis.confidence,
      rationale: analysis.rationale,
      trend: analysis.trend,
      ema20: analysis.ema20,
      ema50: analysis.ema50,
      rsi14: analysis.rsi14,
      atr14: analysis.atr14,
      suggested_entry: analysis.entry ?? null,
      suggested_stop_loss: analysis.sl ?? null,
      suggested_take_profit: analysis.tp ?? null,
    },
    recent_candles: recent.map((c) => ({
      t: c.epoch,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
    })),
    order_blocks: analysis.activeOB
      ? [{ type: "OB", kind: analysis.activeOB.kind, top: analysis.activeOB.top, bottom: analysis.activeOB.bottom }]
      : [],
    fair_value_gaps: analysis.activeFVG
      ? [{ type: "FVG", kind: analysis.activeFVG.kind, top: analysis.activeFVG.top, bottom: analysis.activeFVG.bottom }]
      : [],
  });

  const res = await fetch(chatCompletionsUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: DOCTRINE },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 700,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HF Router ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("HF Router returned an empty AI message");

  const parsed = JSON.parse(extractJsonObject(content));
  const direction: ClientAIResult["direction"] = ["CALL", "PUT", "NONE"].includes(parsed.direction)
    ? parsed.direction
    : "NONE";
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const durationUnit = ["t", "s", "m", "h"].includes(parsed.duration_unit) ? parsed.duration_unit : "t";

  return {
    direction,
    confidence,
    stake: asNumberOrNull(parsed.stake),
    duration: asNumberOrNull(parsed.duration),
    duration_unit: durationUnit,
    take_profit: asNumberOrNull(parsed.take_profit),
    stop_loss: asNumberOrNull(parsed.stop_loss),
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No explanation returned by the model.",
    lesson_added: false,
    model,
  };
}
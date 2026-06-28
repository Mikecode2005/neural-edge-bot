/**
 * Qwen 2.5 7B Instruct via HuggingFace Inference API.
 * Analyzes OB+FVG setups, recalls strategy memory, returns structured decision.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const Candle = z.object({
  epoch: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
});

const Zone = z.object({
  type: z.string(),
  top: z.number(),
  bottom: z.number(),
  epoch: z.number().optional(),
});

const AnalyzeInput = z.object({
  symbol: z.string(),
  timeframe: z.string().default("1m"),
  candles: z.array(Candle).min(10),
  ob_zones: z.array(Zone).default([]),
  fvg_zones: z.array(Zone).default([]),
  current_price: z.number(),
  balance: z.number().default(1000),
});

const DOCTRINE = `You are an expert Smart Money Concepts (SMC) trader specialising in synthetic indices on Deriv.
The strategy is Order Block + Fair Value Gap (OB + FVG).

CORE RULES (apply strictly):
1. FAIR VALUE GAP (FVG / imbalance): a three-candle pattern where candle1.high < candle3.low (bullish FVG) or candle1.low > candle3.high (bearish FVG). The gap is between candle1's extreme and candle3's opposite extreme.
2. ORDER BLOCK (OB): the last opposite-colour candle BEFORE the impulse leg that created the FVG. Bullish OB = last bearish candle before a strong bullish move; bearish OB = last bullish candle before a strong bearish move.
3. ENTRY: only when current price has returned into the OB zone AND price action shows rejection (wick rejection, or a small reversal candle). Never chase price away from the OB.
4. STOP LOSS: just beyond the OB extreme (low for bullish, high for bearish) + small buffer (~1 pip-equivalent).
5. TAKE PROFIT: next liquidity pool — recent swing high (for longs) or swing low (for shorts). Aim for at least 1.5R.
6. INVALIDATION: skip the setup if (a) the FVG has already been mitigated (price closed through it), (b) the OB has been broken, (c) higher-timeframe trend opposes the trade direction.
7. RISK: stake must respect risk_percent of balance, hard-capped server-side.
8. If no clean setup is present, return direction=NONE with confidence < 0.4. DO NOT FORCE TRADES.

You are also given LESSONS LEARNED from prior trades. Treat them as priority guidance.

OUTPUT: respond with ONLY a JSON object (no markdown, no prose outside JSON) matching:
{
 "direction": "CALL" | "PUT" | "NONE",
 "confidence": 0..1,
 "stake": number,
 "duration": integer,
 "duration_unit": "t"|"s"|"m"|"h",
 "take_profit": number | null,   // absolute price
 "stop_loss":   number | null,   // absolute price
 "reasoning":   string,           // 1-3 sentences, plain English, cite the OB/FVG you used
 "lesson":      string | null     // optional new lesson to remember if this setup is novel
}`;

async function callQwen(systemPrompt: string, userPrompt: string): Promise<string> {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error("HF_TOKEN not configured");

  // HF Router (OpenAI-compatible)
  const res = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.HF_MODEL ?? "Qwen/Qwen2.5-7B-Instruct:together",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 700,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HF ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "{}";
}

export const analyzeMarket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AnalyzeInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. Recall lessons
    const { data: memory } = await supabaseAdmin
      .from("strategy_memory")
      .select("id, lesson, outcome, symbol, setup_type, usefulness_score")
      .eq("user_id", context.userId)
      .or(`symbol.eq.${data.symbol},symbol.is.null`)
      .order("usefulness_score", { ascending: false })
      .limit(8);

    const lessons = (memory ?? [])
      .map((m, i) => `${i + 1}. [${m.outcome ?? "obs"}] ${m.lesson}`)
      .join("\n");

    // 2. Build user prompt with compact market state
    const recent = data.candles.slice(-30);
    const userPrompt = JSON.stringify({
      symbol: data.symbol,
      timeframe: data.timeframe,
      current_price: data.current_price,
      balance: data.balance,
      recent_candles: recent.map((c) => ({
        t: c.epoch,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
      })),
      order_blocks: data.ob_zones.slice(-5),
      fair_value_gaps: data.fvg_zones.slice(-5),
      lessons_learned: lessons || "(none yet)",
    });

    // 3. Call Qwen
    let parsed: any;
    let raw = "";
    try {
      raw = await callQwen(DOCTRINE, userPrompt);
      parsed = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(`AI call failed: ${e.message}`);
    }

    const direction = ["CALL", "PUT", "NONE"].includes(parsed.direction)
      ? parsed.direction
      : "NONE";
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));

    // 4. Persist decision
    const { data: saved, error } = await supabaseAdmin
      .from("ai_decisions")
      .insert({
        user_id: context.userId,
        symbol: data.symbol,
        timeframe: data.timeframe,
        direction,
        stake: Number(parsed.stake) || null,
        duration: Number(parsed.duration) || null,
        duration_unit: parsed.duration_unit || null,
        take_profit: parsed.take_profit ?? null,
        stop_loss: parsed.stop_loss ?? null,
        confidence,
        reasoning: parsed.reasoning ?? "",
        model: process.env.HF_MODEL ?? "Qwen/Qwen2.5-7B-Instruct:together",
        candles_snapshot: recent,
        ob_zones: data.ob_zones,
        fvg_zones: data.fvg_zones,
        recalled_memory: memory ?? [],
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    // 5. Save new lesson if provided
    if (parsed.lesson && typeof parsed.lesson === "string" && parsed.lesson.length > 10) {
      await supabaseAdmin.from("strategy_memory").insert({
        user_id: context.userId,
        symbol: data.symbol,
        timeframe: data.timeframe,
        setup_type: "OB+FVG",
        lesson: parsed.lesson,
        outcome: "observation",
        tags: ["ai-generated", "pre-trade"],
        usefulness_score: 1.0,
      });
    }

    // Mark recalled memory as used
    if (memory?.length) {
      const ids = memory.map((m) => m.id);
      await supabaseAdmin
        .from("strategy_memory")
        .update({ last_used_at: new Date().toISOString() })
        .in("id", ids);
    }

    return {
      decision_id: saved.id,
      direction,
      confidence,
      stake: saved.stake,
      duration: saved.duration,
      duration_unit: saved.duration_unit,
      take_profit: saved.take_profit,
      stop_loss: saved.stop_loss,
      reasoning: saved.reasoning,
      lesson_added: !!parsed.lesson,
    };
  });

const OutcomeInput = z.object({
  decision_id: z.string().uuid(),
  outcome: z.enum(["win", "loss", "breakeven"]),
  pnl: z.number(),
  contract_id: z.string().optional(),
});

export const recordOutcome = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => OutcomeInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: decision } = await supabaseAdmin
      .from("ai_decisions")
      .select("*")
      .eq("id", data.decision_id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!decision) throw new Error("decision not found");

    // Write lesson based on outcome
    const lesson = `On ${decision.symbol} ${decision.timeframe}, the model chose ${decision.direction} (conf ${decision.confidence}). Outcome: ${data.outcome} (${data.pnl >= 0 ? "+" : ""}${data.pnl}). Reasoning was: ${decision.reasoning?.slice(0, 200)}`;

    await supabaseAdmin.from("strategy_memory").insert({
      user_id: context.userId,
      symbol: decision.symbol,
      timeframe: decision.timeframe,
      setup_type: "OB+FVG",
      lesson,
      outcome: data.outcome,
      pnl: data.pnl,
      tags: ["post-trade", data.outcome],
      usefulness_score: data.outcome === "win" ? 1.5 : data.outcome === "loss" ? 1.2 : 1.0,
    });

    // Bump confidence-of-prior recalled lessons up/down by tiny amount
    const recalled = (decision.recalled_memory as any[]) ?? [];
    for (const m of recalled) {
      const delta = data.outcome === "win" ? 0.05 : data.outcome === "loss" ? -0.03 : 0;
      if (delta !== 0) {
        await supabaseAdmin
          .from("strategy_memory")
          .update({
            usefulness_score: Math.max(0.1, (m.usefulness_score ?? 1) + delta),
            times_recalled: (m.times_recalled ?? 0) + 1,
          })
          .eq("id", m.id);
      }
    }

    return { ok: true };
  });

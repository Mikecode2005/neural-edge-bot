/**
 * Qwen 2.5 7B Instruct via HuggingFace Inference API.
 * Upgraded to institutional-grade with setup classification (A+, A, B, C, D),
 * calibrated confidence, and comprehensive technical features.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { analyze, analyzeMulti, analyzeMeanReversion, analyzeMomentum } from "../ob-fvg";

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

const DOCTRINE = `You are an institutional-grade quantitative trading AI. You have THREE strategies available and pick the highest-conviction one for the current regime.

STRATEGY 1 — OB + FVG (Smart Money Concepts, TRENDING markets):
  Hard gates (ALL must pass, else WAIT):
    • Unmitigated Order Block + unfilled Fair Value Gap
    • Price has retraced INTO the OB zone (not merely near it)
    • 1m trend AND 15m HTF trend align with the trade direction
    • RSI: BUY < 68, SELL > 32
    • ADX ≥ 18 (no dead chop)
    • Either liquidity sweep OR a displacement candle (>55% body) in last 5 bars
    • Volatility regime = normal (ATR % of price between 0.02% and 2.5%)
  Risk plan: SL = entry ± 1.5 × ATR. TP = swing liquidity capped at 3R, floor 1.67R.

STRATEGY 2 — MOMENTUM CONTINUATION (STRONG TRENDING markets):
  Hard gates:
    • ADX ≥ 22 AND HTF 15m trend matches 1m trend
    • EMA20/50/200 stacked in trade direction
    • Price pulled back within 0.6 × ATR of EMA20
    • Displacement candle in trade direction within last 3 bars
    • Volatility regime = normal
  Risk plan: SL = 1.5 × ATR, TP = 2.5 × ATR (RR ≈ 1.67).

STRATEGY 3 — MEAN REVERSION (RANGING markets):
  Hard gates:
    • ADX < 22 (ranging, not trending)
    • Volatility regime ≠ high
    • BUY: price at/below Bollinger lower band AND RSI < 32
    • SELL: price at/above Bollinger upper band AND RSI > 68
  Risk plan: SL = 1.2 × ATR, TP = Bollinger midline.

CLASSIFY the setup:
  A+: All hard gates pass + extra confluence (sweep + displacement + BOS). Trade immediately.
  A:  All hard gates pass. Good trade.
  B:  Missing one confirmation. SKIP.
  C:  Counter-trend or extreme RSI. AVOID.
  D:  Fails structural gates. REJECT.

Only output CALL/PUT for A+ or A. Otherwise NONE.

CONFIDENCE:
  A+: 0.90-0.95 (target 75%+ win rate)
  A:  0.75-0.89 (target 60%+ win rate)
  B:  0.50-0.74 (skip zone)
  C/D: < 0.50

OUTPUT: strict JSON only, no markdown, no prose:
{
  "strategy": "ob-fvg" | "momentum" | "mean-reversion",
  "classification": "A+"|"A"|"B"|"C"|"D",
  "direction": "CALL"|"PUT"|"NONE",
  "confidence": 0..1,
  "stake": number,
  "duration": integer,
  "duration_unit": "t"|"s"|"m"|"h",
  "take_profit": number|null,
  "stop_loss": number|null,
  "reasoning": string,
  "lesson": string|null
}`;

async function callQwen(systemPrompt: string, userPrompt: string): Promise<string> {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error("HF_TOKEN not configured");

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
      temperature: 0.15,
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

    // 1. Calculate institutional indicators and structure server-side
    const analysis = analyze(data.candles);
    const multi = analyzeMulti(data.candles);
    const mr = analyzeMeanReversion(data.candles);
    const mo = analyzeMomentum(data.candles);

    // 2. Recall lessons learned
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

    // 3. Construct feature-rich user prompt
    const recent = data.candles.slice(-30);
    const userPrompt = JSON.stringify({
      symbol: data.symbol,
      timeframe: data.timeframe,
      current_price: data.current_price,
      balance: data.balance,
      technical_features: {
        trend_1m: analysis.trend,
        ema20: analysis.ema20,
        ema50: analysis.ema50,
        ema200: analysis.ema200,
        rsi14: analysis.rsi14,
        atr14: analysis.atr14,
        adx14: analysis.adx14,
        bos: analysis.bos,
        choch: analysis.choch,
        liquidity_sweep: analysis.liquiditySweep,
        displacement: analysis.displacement,
        volatility_regime: analysis.volatilityRegime,
        htf_trend_15m: analysis.htfTrend15m,
        htf_structure_5m: analysis.htfStructure5m,
        active_ob: analysis.activeOB ? {
          kind: analysis.activeOB.kind,
          top: analysis.activeOB.top,
          bottom: analysis.activeOB.bottom,
          volume_proxy: analysis.activeOB.volumeProxy
        } : null,
        active_fvg: analysis.activeFVG ? {
          kind: analysis.activeFVG.kind,
          top: analysis.activeFVG.top,
          bottom: analysis.activeFVG.bottom,
          size: analysis.activeFVG.size
        } : null,
      },
      recent_candles: recent.map((c) => ({
        t: c.epoch,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
      })),
      lessons_learned: lessons || "(none yet)",
    });

    // 4. Call Qwen
    let parsed: any;
    let raw = "";
    try {
      raw = await callQwen(DOCTRINE, userPrompt);
      parsed = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(`AI call failed: ${e.message}`);
    }

    const classification = parsed.classification || "B";
    const rawDirection = parsed.direction || "NONE";
    
    // Execute trade only if class A+ or A
    const direction = ["A+", "A"].includes(classification) && ["CALL", "PUT"].includes(rawDirection)
      ? rawDirection
      : "NONE";
      
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));

    // Save explaining reasoning prefix
    const structuredReasoning = `[Setup Class ${classification}] ${parsed.reasoning || ""}`;

    // 5. Persist decision
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
        take_profit: direction !== "NONE" ? parsed.take_profit : null,
        stop_loss: direction !== "NONE" ? parsed.stop_loss : null,
        confidence,
        reasoning: structuredReasoning,
        model: process.env.HF_MODEL ?? "Qwen/Qwen2.5-7B-Instruct:together",
        candles_snapshot: recent,
        ob_zones: data.ob_zones,
        fvg_zones: data.fvg_zones,
        recalled_memory: memory ?? [],
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    // 6. Save new lesson if provided
    if (parsed.lesson && typeof parsed.lesson === "string" && parsed.lesson.length > 10) {
      await supabaseAdmin.from("strategy_memory").insert({
        user_id: context.userId,
        symbol: data.symbol,
        timeframe: data.timeframe,
        setup_type: "OB+FVG",
        lesson: parsed.lesson,
        outcome: "observation",
        tags: ["ai-generated", "pre-trade", `class-${classification}`],
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

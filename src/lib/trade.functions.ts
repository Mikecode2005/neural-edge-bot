import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const OpenPaperTradeSchema = z.object({
  symbol: z.string(),
  side: z.enum(["BUY", "SELL"]),
  entry: z.number(),
  sl: z.number().nullable().optional(),
  tp: z.number().nullable().optional(),
  size: z.number().default(100),
  confidence: z.number(),
  reasoning: z.string().optional(),
  ob_zone: z.any().optional(),
  fvg_zone: z.any().optional(),
});

const STARTING_BALANCE = 10_000;

/**
 * Opens a paper trade end-to-end using the service-role admin client so demo
 * usage works without auth. Also records the predication + live_signal row.
 */
export const openPaperTrade = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => OpenPaperTradeSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // ensure portfolio exists
    const { data: existing } = await supabaseAdmin
      .from("portfolio")
      .select("*")
      .eq("mode", "demo")
      .is("user_id", null)
      .limit(1)
      .maybeSingle();

    let portfolio = existing;
    if (!portfolio) {
      const { data: created } = await supabaseAdmin
        .from("portfolio")
        .insert({
          mode: "demo",
          balance: STARTING_BALANCE,
          equity: STARTING_BALANCE,
        })
        .select("*")
        .single();
      portfolio = created;
    }

    // Risk: cap to 5 open positions, 2% of balance
    const open = portfolio?.open_positions ?? 0;
    if (open >= 5) {
      return { ok: false, message: "Max 5 open paper positions." };
    }
    const balance = Number(portfolio?.balance ?? STARTING_BALANCE);
    const size = Math.min(data.size, balance * 0.02);
    if (size <= 0) {
      return { ok: false, message: "Balance too low." };
    }

    const { data: pred } = await supabaseAdmin
      .from("predictions")
      .insert({
        symbol: data.symbol,
        timeframe: "1m",
        decision: data.side,
        confidence: data.confidence,
        risk_score: 1 - data.confidence,
        success_probability: data.confidence,
        reasoning: data.reasoning ?? null,
        trade_plan: { entry: data.entry, sl: data.sl, tp: data.tp },
        suggested_entry: data.entry,
        suggested_sl: data.sl ?? null,
        suggested_tp: data.tp ?? null,
        model_version: "ob_fvg-client-v1",
      })
      .select("id")
      .single();

    await supabaseAdmin.from("live_signals").insert({
      symbol: data.symbol,
      decision: data.side,
      confidence: data.confidence,
      price: data.entry,
      ob_zone: data.ob_zone ?? null,
      fvg_zone: data.fvg_zone ?? null,
      reasoning: data.reasoning ?? null,
    });

    const { data: trade } = await supabaseAdmin
      .from("trade_history")
      .insert({
        mode: "demo",
        symbol: data.symbol,
        side: data.side,
        entry_price: data.entry,
        size,
        stop_loss: data.sl ?? null,
        take_profit: data.tp ?? null,
        status: "open",
        reason_opened: data.reasoning ?? "AI OB+FVG signal",
        prediction_id: pred?.id ?? null,
      })
      .select("*")
      .single();

    if (portfolio?.id) {
      await supabaseAdmin
        .from("portfolio")
        .update({ open_positions: open + 1 })
        .eq("id", portfolio.id);
    }

    return { ok: true, trade_id: trade?.id, message: "Paper trade opened" };
  });

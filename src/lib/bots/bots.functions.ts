import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const StartInput = z.object({
  symbol: z.string(),
  timeframe: z.string().default("1m"),
  account_type: z.enum(["demo", "real"]),
  account_loginid: z.string().optional(),
  market_mode: z.string().default("synthetic"),
  interval_seconds: z.number().int().min(10).max(3600).default(60),
  min_confidence: z.number().min(0).max(1).default(0.7),
  max_stake_per_trade: z.number().positive().default(1),
  min_stake_per_trade: z.number().positive().default(0.35),
  strategy_mode: z.enum(["qwen", "ob-fvg"]).default("qwen"),
  account_balance: z.number().positive().default(1000),
});

export const startBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => StartInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("bot_runs")
      .insert({
        user_id: context.userId,
        symbol: data.symbol,
        timeframe: data.timeframe,
        mode: "auto",
        account_type: data.account_type,
        account_loginid: data.account_loginid ?? null,
        market_mode: data.market_mode,
        interval_seconds: data.interval_seconds,
        min_confidence: data.min_confidence,
        max_stake_per_trade: data.max_stake_per_trade,
        min_stake_per_trade: data.min_stake_per_trade,
        strategy_mode: data.strategy_mode,
        account_balance: data.account_balance,
        server_loop_enabled: true,
        status: "running",
      } as any)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const stopBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("bot_runs")
      .update({ status: "stopped", stopped_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listBots = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("bot_runs")
      .select("*")
      .eq("user_id", context.userId)
      .order("started_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listBotActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        bot_id: z.string().uuid(),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await (supabaseAdmin as any)
      .from("bot_activity")
      .select("*")
      .eq("user_id", context.userId)
      .eq("bot_run_id", data.bot_id)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const listOpenBotPositions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ bot_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await (supabaseAdmin as any)
      .from("bot_positions")
      .select("*")
      .eq("user_id", context.userId)
      .eq("bot_run_id", data.bot_id)
      .eq("status", "open")
      .order("opened_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const analyzeBotDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        candles: z.array(
          z.object({
            epoch: z.number(),
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
          }),
        ),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: bot, error } = await supabaseAdmin
      .from("bot_runs")
      .select("id")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!bot) throw new Error("Bot not found");
    const { analyzeBotDecision: analyze } = await import("./bot-loop.server");
    return analyze(data.id, data.candles as any);
  });

export const recordBotDerivTrade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        direction: z.enum(["CALL", "PUT"]),
        stake: z.number().positive(),
        entry_price: z.number(),
        contract_id: z.string(),
        payout: z.number(),
        reasoning: z.string(),
        confidence: z.number(),
        ob_zone: z.string().nullable().optional(),
        fvg_zone: z.string().nullable().optional(),
        trend: z.string().nullable().optional(),
        ema20: z.number().nullable().optional(),
        ema50: z.number().nullable().optional(),
        rsi14: z.number().nullable().optional(),
        atr14: z.number().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: bot } = await supabaseAdmin
      .from("bot_runs")
      .select("id, locked_stake, total_trades, total_pnl, wins, losses")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!bot) throw new Error("Bot not found");

    const { data: tradeRow } = await supabaseAdmin
      .from("trade_history")
      .insert({
        user_id: context.userId,
        symbol: "deriv-bot",
        side: data.direction === "CALL" ? "BUY" : "SELL",
        entry_price: data.entry_price,
        size: data.stake,
        status: "open",
        mode: "live",
        deriv_contract_id: data.contract_id,
        reason_opened: data.reasoning,
        opened_at: new Date().toISOString(),
      } as any)
      .select("id")
      .single();

    const { data: pos } = await supabaseAdmin
      .from("bot_positions")
      .insert({
        user_id: context.userId,
        bot_run_id: data.id,
        symbol: "deriv-bot",
        direction: data.direction,
        account_type: "real",
        market_mode: "live",
        stake: data.stake,
        payout: data.payout,
        entry_price: data.entry_price,
        status: "open",
        trade_history_id: tradeRow?.id ?? null,
        reasoning: data.reasoning,
      } as any)
      .select("id")
      .single();

    await supabaseAdmin
      .from("bot_runs")
      .update({
        locked_stake: Number(bot.locked_stake ?? 0) + data.stake,
        last_tick_at: new Date().toISOString(),
        last_error: null,
      } as any)
      .eq("id", data.id);

    await supabaseAdmin.from("bot_activity").insert({
      user_id: context.userId,
      bot_run_id: data.id,
      action: "ENTRY",
      symbol: "deriv-bot",
      direction: data.direction,
      confidence: data.confidence,
      entry_price: data.entry_price,
      stake: data.stake,
      pnl: null,
      reasoning: data.reasoning,
      ob_zone: data.ob_zone ?? null,
      fvg_zone: data.fvg_zone ?? null,
      risk_check: `Live Deriv trade — contract ${data.contract_id}`,
      indicators: {
        trend: data.trend ?? null,
        ema20: data.ema20 ?? null,
        ema50: data.ema50 ?? null,
        rsi14: data.rsi14 ?? null,
        atr14: data.atr14 ?? null,
      },
    } as any);

    return { ok: true, position_id: pos?.id, trade_id: tradeRow?.id };
  });

export const runBotServerTick = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        candles: z
          .array(
            z.object({
              epoch: z.number(),
              open: z.number(),
              high: z.number(),
              low: z.number(),
              close: z.number(),
            }),
          )
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: bot, error } = await supabaseAdmin
      .from("bot_runs")
      .select("id")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!bot) throw new Error("Bot not found");
    const { processBotTick } = await import("./bot-loop.server");
    return processBotTick(data.id, data.candles as any);
  });

export const tickBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        executed: z.boolean().default(false),
        pnl_delta: z.number().default(0),
        error: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("bot_runs")
      .select("total_trades,total_pnl")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!row) return { ok: false };
    await supabaseAdmin
      .from("bot_runs")
      .update({
        last_tick_at: new Date().toISOString(),
        total_trades: (row.total_trades ?? 0) + (data.executed ? 1 : 0),
        total_pnl: Number(row.total_pnl ?? 0) + (data.pnl_delta ?? 0),
        last_error: data.error ?? null,
      })
      .eq("id", data.id);
    return { ok: true };
  });

export const updateBotBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        account_balance: z.number().positive(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("bot_runs")
      .update({
        account_balance: data.account_balance,
        total_pnl: 0,
        total_trades: 0,
        wins: 0,
        losses: 0,
        locked_stake: 0,
        floating_pnl: 0,
      } as any) // reset statistics when updating balance
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const pushCandlesToStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        symbol: z.string(),
        timeframe: z.string().default("1m"),
        candles: z.array(
          z.object({
            epoch: z.number(),
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
          }),
        ),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { setCandles } = await import("./candle-store");
    setCandles(data.symbol, data.timeframe, data.candles);
    return { ok: true };
  });

export const resetBotStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("bot_runs")
      .update({
        total_pnl: 0,
        total_trades: 0,
        wins: 0,
        losses: 0,
        locked_stake: 0,
        floating_pnl: 0,
        last_error: null,
      } as any)
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

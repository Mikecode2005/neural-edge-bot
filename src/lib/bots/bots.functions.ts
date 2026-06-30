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
      .update({ account_balance: data.account_balance, total_pnl: 0, total_trades: 0 }) // reset statistics when updating balance
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
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
      .update({ total_pnl: 0, total_trades: 0, last_error: null })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
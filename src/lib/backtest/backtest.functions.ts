import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const SaveInput = z.object({
  symbol: z.string(),
  timeframe: z.string().default("1m"),
  start_epoch: z.number(),
  end_epoch: z.number(),
  starting_balance: z.number().default(1000),
  final_balance: z.number(),
  final_pnl: z.number(),
  win_rate: z.number(),
  trades_count: z.number(),
  equity_curve: z.array(z.object({ t: z.number(), equity: z.number() })),
  trades: z.array(z.any()),
  params: z.record(z.any()).default({}),
});

export const saveBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("backtest_runs")
      .insert({
        user_id: context.userId,
        symbol: data.symbol,
        timeframe: data.timeframe,
        start_epoch: data.start_epoch,
        end_epoch: data.end_epoch,
        starting_balance: data.starting_balance,
        final_balance: data.final_balance,
        final_pnl: data.final_pnl,
        win_rate: data.win_rate,
        trades_count: data.trades_count,
        equity_curve: data.equity_curve,
        trades: data.trades,
        params: data.params,
        status: "done",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const listBacktests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("backtest_runs")
      .select("id, symbol, timeframe, final_pnl, win_rate, trades_count, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

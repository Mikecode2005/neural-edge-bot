/**
 * Server-side trade logging. The browser places the actual Deriv buy
 * (using the user's authorized WS) because Workers WS-client outbound
 * support for ws.derivws.com is constrained; we keep audit in the DB.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const LogTradeInput = z.object({
  decision_id: z.string().uuid().optional(),
  symbol: z.string(),
  side: z.enum(["CALL", "PUT", "MULTUP", "MULTDOWN"]),
  stake: z.number().positive(),
  contract_id: z.string(),
  buy_price: z.number(),
  payout: z.number().optional(),
  take_profit: z.number().nullable().optional(),
  stop_loss: z.number().nullable().optional(),
  account_type: z.enum(["demo", "real"]),
});

export const logTradeOpen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => LogTradeInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("trade_history")
      .insert({
        user_id: context.userId,
        symbol: data.symbol,
        side: data.side === "CALL" ? "BUY" : data.side === "PUT" ? "SELL" : data.side,
        entry_price: data.buy_price,
        size: data.stake,
        status: "open",
        mode: data.account_type,
        ai_decision_id: data.decision_id ?? null,
        deriv_contract_id: data.contract_id,
        take_profit: data.take_profit ?? null,
        stop_loss: data.stop_loss ?? null,
        opened_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    if (data.decision_id) {
      await supabaseAdmin
        .from("ai_decisions")
        .update({ executed: true, contract_id: data.contract_id })
        .eq("id", data.decision_id);
    }
    return { id: row.id };
  });

const CloseInput = z.object({
  trade_id: z.string().uuid(),
  exit_price: z.number(),
  pnl: z.number(),
  outcome: z.enum(["win", "loss", "breakeven"]),
});

export const logTradeClose = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => CloseInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("trade_history")
      .update({
        exit_price: data.exit_price,
        pnl: data.pnl,
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", data.trade_id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Server-side hard-cap check; never trust client. */
const RiskInput = z.object({
  proposed_stake: z.number().positive(),
  account_type: z.enum(["demo", "real"]),
});

export const checkRisk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RiskInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: s } = await supabaseAdmin
      .from("settings")
      .select("max_stake, max_daily_loss, max_trades_per_day")
      .eq("user_id", context.userId)
      .maybeSingle();

    const maxStake = s?.max_stake ?? 10;
    const maxDailyLoss = s?.max_daily_loss ?? 10;
    const maxTrades = s?.max_trades_per_day ?? 5;

    if (data.proposed_stake > maxStake) {
      return { ok: false, reason: `Stake $${data.proposed_stake} exceeds max stake $${maxStake}` };
    }

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const { data: today } = await supabaseAdmin
      .from("trade_history")
      .select("pnl, id")
      .eq("user_id", context.userId)
      .eq("mode", data.account_type)
      .gte("opened_at", since.toISOString());

    const tradesToday = today?.length ?? 0;
    if (tradesToday >= maxTrades) {
      return { ok: false, reason: `Daily trade cap reached (${maxTrades})` };
    }
    const lossToday = -(today ?? []).reduce((a, t) => a + (t.pnl ?? 0), 0);
    if (lossToday >= maxDailyLoss) {
      return { ok: false, reason: `Daily loss cap reached ($${maxDailyLoss})` };
    }
    return { ok: true, maxStake, maxDailyLoss, tradesToday };
  });

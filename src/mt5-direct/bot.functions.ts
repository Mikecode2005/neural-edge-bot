/**
 * MT5 Bot server functions — reuses the OB+FVG engine from src/lib/bots
 * to execute autonomous trades through the MT5 python-bridge with SL/TP.
 *
 * Bots are stored in `bot_runs` with `market_mode='mt5'` so the same tables
 * (bot_runs, bot_positions, bot_activity) power the UI as the Deriv bots.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { getMt5Client } from "./client";
import type { Mt5LibraryMode, Mt5Rate, Mt5SymbolInfo } from "./types";
import type { Candle } from "@/lib/deriv-ws";
import {
  makeObFvgBotDecision,
  markOpenPosition,
  BOT_MAX_HOLD_CANDLES,
  formatObZone,
  formatFvgZone,
  type OpenBotPositionLike,
} from "@/lib/bots/bot-engine";
import { analyze } from "@/lib/ob-fvg";

// ── Helpers ──────────────────────────────────────────────────────────────

function client() {
  const mode = (process.env.MT5_LIB_MODE as Mt5LibraryMode) ?? "python-bridge";
  return getMt5Client(mode);
}

function getCreds() {
  const login = Number(process.env.MT5_ACCOUNT_LOGIN ?? 0);
  const password = process.env.MT5_ACCOUNT_PASSWORD ?? "";
  const server = process.env.MT5_ACCOUNT_SERVER ?? "";
  if (!login || !password || !server) return null;
  return { login, password, server };
}

async function ensureConnected() {
  const c = client();
  if (c.connected) return c;
  const creds = getCreds();
  if (!creds) throw new Error("MT5 credentials not configured (MT5_ACCOUNT_*)");
  await c.initialize(creds);
  return c;
}

function ratesToCandles(rates: Mt5Rate[]): Candle[] {
  return rates.map((r) => ({
    epoch: Number(r.time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));
}

function secondsToMt5Timeframe(
  s: number,
): "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" {
  if (s <= 60) return "1m";
  if (s <= 300) return "5m";
  if (s <= 900) return "15m";
  if (s <= 1800) return "30m";
  if (s <= 3600) return "1h";
  if (s <= 14400) return "4h";
  return "1d";
}

function roundToDigits(value: number, digits: number) {
  const p = Math.pow(10, digits);
  return Math.round(value * p) / p;
}

function normalizeVolume(vol: number, info: Mt5SymbolInfo) {
  const min = info.volumeMin || 0.01;
  const max = info.volumeMax || 100;
  const step = info.volumeStep || 0.01;
  const clamped = Math.min(max, Math.max(min, vol));
  const steps = Math.max(1, Math.round(clamped / step));
  return Number((steps * step).toFixed(2));
}

// ── Schemas ──────────────────────────────────────────────────────────────

const StartInput = z.object({
  symbol: z.string(),
  interval_seconds: z.number().int().min(10).max(3600).default(60),
  min_confidence: z.number().min(0).max(1).default(0.65),
  max_stake_per_trade: z.number().positive().default(50),
  min_stake_per_trade: z.number().positive().default(1),
  account_balance: z.number().positive().default(1000),
  volume: z.number().positive().default(0.01),
  account_type: z.enum(["demo", "real"]).default("demo"),
  strategy_mode: z.enum(["qwen", "ob-fvg"]).default("ob-fvg"),
});

// ── Public server functions ──────────────────────────────────────────────

export const mt5StartBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => StartInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("bot_runs")
      .insert({
        user_id: context.userId,
        symbol: data.symbol,
        timeframe: secondsToMt5Timeframe(data.interval_seconds),
        mode: "auto",
        account_type: data.account_type,
        market_mode: "mt5",
        interval_seconds: data.interval_seconds,
        min_confidence: data.min_confidence,
        max_stake_per_trade: data.max_stake_per_trade,
        min_stake_per_trade: data.min_stake_per_trade,
        strategy_mode: data.strategy_mode,
        account_balance: data.account_balance,
        // stash MT5 volume in ai_config so we don't need a schema change
        ai_config: { volume: data.volume },
        server_loop_enabled: false,
        status: "running",
      } as any)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const mt5ListBots = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("bot_runs")
      .select("*")
      .eq("user_id", context.userId)
      .eq("market_mode", "mt5")
      .order("started_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/**
 * One bot tick — mark open positions, then decide + place a new order.
 * Called from the browser on an interval while the user is on the page.
 */
export const mt5RunBotTick = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: bot, error: botErr } = await supabaseAdmin
      .from("bot_runs")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (botErr) throw new Error(botErr.message);
    if (!bot) throw new Error("Bot not found");
    if ((bot as any).market_mode !== "mt5") throw new Error("Not an MT5 bot");

    const tfSec = Number((bot as any).interval_seconds ?? 60);
    const timeframe = secondsToMt5Timeframe(tfSec);

    let mt5;
    try {
      mt5 = await ensureConnected();
    } catch (e: any) {
      await supabaseAdmin
        .from("bot_runs")
        .update({ last_error: e?.message ?? "MT5 not connected", last_tick_at: new Date().toISOString() } as any)
        .eq("id", data.id);
      await supabaseAdmin.from("bot_activity").insert({
        user_id: context.userId,
        bot_run_id: data.id,
        action: "ERROR",
        symbol: (bot as any).symbol,
        reasoning: e?.message ?? "MT5 bridge unreachable",
        risk_check: "Bridge connect failed",
      } as any);
      return { ok: false, error: e?.message ?? "MT5 bridge unreachable" };
    }

    const rates = await mt5.rates((bot as any).symbol, timeframe, 220);
    const candles = ratesToCandles(rates);
    const last = candles.at(-1);
    if (!last) return { ok: false, error: "No candles" };

    let symInfo: Mt5SymbolInfo | null = null;
    try {
      symInfo = await mt5.symbolInfo((bot as any).symbol);
    } catch {
      /* ignore — we can still mark positions */
    }

    // 1) Mark any open positions and close via MT5 when SL/TP hit
    const { data: openRows } = await supabaseAdmin
      .from("bot_positions")
      .select("*")
      .eq("user_id", context.userId)
      .eq("bot_run_id", data.id)
      .eq("status", "open");

    for (const pos of openRows ?? []) {
      const like: OpenBotPositionLike = {
        id: (pos as any).id,
        direction: (pos as any).direction,
        entry_price: Number((pos as any).entry_price),
        stop_loss: (pos as any).stop_loss == null ? null : Number((pos as any).stop_loss),
        take_profit: (pos as any).take_profit == null ? null : Number((pos as any).take_profit),
        stake: Number((pos as any).stake),
        opened_epoch: Number((pos as any).opened_epoch ?? 0),
        expires_epoch: (pos as any).expires_epoch == null ? null : Number((pos as any).expires_epoch),
      };
      const mark = markOpenPosition(like, last);

      if (mark.closed) {
        const externalTicket = (pos as any).external_contract_id
          ? Number((pos as any).external_contract_id)
          : null;
        if (externalTicket) {
          try {
            await mt5.positionsClose(externalTicket);
          } catch (e) {
            // continue — we still record the settlement locally
            console.error("mt5 close failed", e);
          }
        }
        await supabaseAdmin
          .from("bot_positions")
          .update({
            status: "closed",
            outcome: mark.outcome,
            exit_price: mark.exitPrice,
            pnl: mark.pnl,
            floating_pnl: 0,
            current_price: last.close,
            closed_at: new Date().toISOString(),
          } as any)
          .eq("id", (pos as any).id);

        await supabaseAdmin.from("bot_activity").insert({
          user_id: context.userId,
          bot_run_id: data.id,
          action: "EXIT",
          symbol: (bot as any).symbol,
          direction: (pos as any).direction,
          entry_price: Number((pos as any).entry_price),
          stake: Number((pos as any).stake),
          pnl: mark.pnl,
          reasoning: `MT5 ${mark.outcome?.toUpperCase()} — ${mark.reason}`,
          risk_check: externalTicket ? `MT5 ticket ${externalTicket} closed` : "Local settlement",
        } as any);

        await supabaseAdmin
          .from("bot_runs")
          .update({
            total_pnl: Number((bot as any).total_pnl ?? 0) + mark.pnl,
            total_trades: Number((bot as any).total_trades ?? 0) + 1,
            wins: Number((bot as any).wins ?? 0) + (mark.outcome === "win" ? 1 : 0),
            losses: Number((bot as any).losses ?? 0) + (mark.outcome === "loss" ? 1 : 0),
            locked_stake: Math.max(0, Number((bot as any).locked_stake ?? 0) - Number((pos as any).stake)),
          } as any)
          .eq("id", data.id);
      } else {
        await supabaseAdmin
          .from("bot_positions")
          .update({ current_price: last.close, floating_pnl: mark.floatingPnl } as any)
          .eq("id", (pos as any).id);
      }
    }

    // Refresh bot after settlements to compute available balance
    const { data: botFresh } = await supabaseAdmin
      .from("bot_runs")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    const balance = Number((botFresh as any)?.account_balance ?? 1000);
    const totalPnl = Number((botFresh as any)?.total_pnl ?? 0);
    const locked = Number((botFresh as any)?.locked_stake ?? 0);
    const available = balance + totalPnl - locked;

    // 2) Analyze new decision - choose strategy based on bot's strategy_mode
    const strategyMode = (botFresh as any)?.strategy_mode ?? "ob-fvg";
    const obFvgAnalysis = analyze(candles); // Always get OB+FVG analysis for indicators

    let decision;
    if (strategyMode === "qwen") {
      // Use Qwen AI for decision
      try {
        const { analyzeMarket } = await import("@/lib/ai/qwen.functions");
        const qwenResult = await analyzeMarket({
          data: {
            symbol: (bot as any).symbol,
            timeframe: bot.timeframe ?? "1m",
            candles: candles.slice(-60),
            ob_zones: obFvgAnalysis.activeOB ? [{ type: obFvgAnalysis.activeOB.kind, top: obFvgAnalysis.activeOB.top, bottom: obFvgAnalysis.activeOB.bottom }] : [],
            fvg_zones: obFvgAnalysis.activeFVG ? [{ type: obFvgAnalysis.activeFVG.kind, top: obFvgAnalysis.activeFVG.top, bottom: obFvgAnalysis.activeFVG.bottom }] : [],
            current_price: last.close,
            balance: available,
          },
        });
        const qwen = qwenResult as any;
        const direction = qwen.direction === "CALL" ? "CALL" : qwen.direction === "PUT" ? "PUT" : "NONE";
        decision = {
          shouldTrade: direction !== "NONE" && Number(qwen.confidence ?? 0) >= Number((bot as any).min_confidence ?? 0.65),
          direction: direction as "CALL" | "PUT" | "NONE",
          confidence: Number(qwen.confidence ?? 0),
          entryPrice: last.close,
          stake: Math.min((botFresh as any)?.max_stake_per_trade ?? 50, available),
          stopLoss: qwen.stop_loss ?? null,
          takeProfit: qwen.take_profit ?? null,
          duration: BOT_MAX_HOLD_CANDLES,
          durationUnit: "m" as const,
          analysis: obFvgAnalysis,
          reasoning: `Qwen AI: ${qwen.reasoning ?? "No reasoning provided"}`,
          obZone: formatObZone(obFvgAnalysis),
          fvgZone: formatFvgZone(obFvgAnalysis),
        };
      } catch (e: any) {
        // Fallback to OB+FVG if Qwen fails
        decision = makeObFvgBotDecision(candles, {
          minConfidence: Number((bot as any).min_confidence ?? 0.65),
          availableBalance: available,
          minStake: Number((bot as any).min_stake_per_trade ?? 1),
          maxStake: Number((bot as any).max_stake_per_trade ?? 50),
        });
      }
    } else {
      // Use OB+FVG strategy
      decision = makeObFvgBotDecision(candles, {
        minConfidence: Number((bot as any).min_confidence ?? 0.65),
        availableBalance: available,
        minStake: Number((bot as any).min_stake_per_trade ?? 1),
        maxStake: Number((bot as any).max_stake_per_trade ?? 50),
      });
    }

    const commonLog = {
      user_id: context.userId,
      bot_run_id: data.id,
      symbol: (bot as any).symbol,
      confidence: decision.confidence,
      ob_zone: decision.obZone,
      fvg_zone: decision.fvgZone,
      indicators: {
        trend: decision.analysis.trend,
        ema20: decision.analysis.ema20,
        ema50: decision.analysis.ema50,
        rsi14: decision.analysis.rsi14,
        atr14: decision.analysis.atr14,
      },
    } as any;

    if (!decision.shouldTrade) {
      await supabaseAdmin.from("bot_activity").insert({
        ...commonLog,
        action: "SCAN",
        direction: decision.direction === "NONE" ? null : decision.direction,
        entry_price: decision.entryPrice,
        stake: null,
        stop_loss: decision.stopLoss,
        take_profit: decision.takeProfit,
        pnl: null,
        reasoning: decision.reasoning,
        risk_check: `Available ${available.toFixed(2)} USD | Confidence ${(decision.confidence * 100).toFixed(0)}%`,
      });
      await supabaseAdmin
        .from("bot_runs")
        .update({ last_tick_at: new Date().toISOString(), current_price: last.close } as any)
        .eq("id", data.id);
      return { ok: true, traded: false, decision };
    }

    // 3) Execute — MT5 market order with SL/TP
    // Adjust direction based on symbol trade mode if needed
    const tradeMode = symInfo?.tradeMode ?? "enabled";
    const isBuy = decision.direction === "CALL";
    const isSell = decision.direction === "PUT";
    
    // For shortonly symbols (only SELL allowed), flip BUY to SELL
    // For longonly symbols (only BUY allowed), flip SELL to BUY
    let adjustedDirection = decision.direction;
    let adjustedIsBuy = isBuy;
    let adjustedIsSell = isSell;
    
    if (tradeMode === "shortonly" && isBuy) {
      adjustedDirection = "PUT";
      adjustedIsBuy = false;
      adjustedIsSell = true;
    } else if (tradeMode === "longonly" && isSell) {
      adjustedDirection = "CALL";
      adjustedIsBuy = true;
      adjustedIsSell = false;
    }
    
    const volume = symInfo
      ? normalizeVolume(Number(((bot as any).ai_config?.volume) ?? 0.01), symInfo)
      : Number(((bot as any).ai_config?.volume) ?? 0.01);
    const digits = symInfo?.digits ?? 5;
    const sl = decision.stopLoss == null ? undefined : roundToDigits(decision.stopLoss, digits);
    const tp = decision.takeProfit == null ? undefined : roundToDigits(decision.takeProfit, digits);

    // Use adjusted direction for the order
    let ticket = 0;
    let fillPrice = decision.entryPrice;
    let orderErr: string | null = null;
    try {
      const result = await mt5.orderSend({
        symbol: (bot as any).symbol,
        type: adjustedIsSell ? "sell" : "buy",
        volume,
        sl,
        tp,
        comment: `AI OB+FVG ${(decision.confidence * 100).toFixed(0)}%`,
      });
      ticket = Number(result.ticket ?? 0);
      fillPrice = Number(result.price ?? decision.entryPrice);
    } catch (e: any) {
      orderErr = e?.message ?? "MT5 order failed";
    }

    if (orderErr || !ticket) {
      await supabaseAdmin.from("bot_activity").insert({
        ...commonLog,
        action: "ERROR",
        direction: decision.direction === "NONE" ? null : decision.direction,
        entry_price: decision.entryPrice,
        stake: decision.stake,
        reasoning: orderErr ?? "MT5 rejected the order",
        risk_check: "orderSend failed",
      });
      await supabaseAdmin
        .from("bot_runs")
        .update({ last_error: orderErr, last_tick_at: new Date().toISOString() } as any)
        .eq("id", data.id);
      return { ok: false, error: orderErr };
    }

    // Use adjusted direction for the position and activity log
    const finalDirection = adjustedDirection;
    const expiresEpoch = last.epoch + BOT_MAX_HOLD_CANDLES * tfSec;
    await supabaseAdmin.from("bot_positions").insert({
      user_id: context.userId,
      bot_run_id: data.id,
      symbol: (bot as any).symbol,
      direction: finalDirection,
      account_type: (bot as any).account_type,
      market_mode: "mt5",
      stake: decision.stake,
      payout: 0,
      entry_price: fillPrice,
      current_price: fillPrice,
      stop_loss: sl ?? null,
      take_profit: tp ?? null,
      duration: BOT_MAX_HOLD_CANDLES,
      duration_unit: "m",
      opened_epoch: last.epoch,
      expires_epoch: expiresEpoch,
      status: "open",
      external_contract_id: String(ticket),
      reasoning: `${tradeMode === "enabled" ? "" : "[Adjusted for tradeMode] "}${decision.reasoning}`,
    } as any);

    await supabaseAdmin.from("bot_activity").insert({
      ...commonLog,
      action: "ENTRY",
      direction: finalDirection,
      entry_price: fillPrice,
      stake: decision.stake,
      stop_loss: sl ?? null,
      take_profit: tp ?? null,
      pnl: null,
      reasoning: `MT5 ${finalDirection} ${volume} lots @ ${fillPrice} — ${decision.reasoning}${tradeMode === "enabled" ? "" : ` (adjusted from ${decision.direction} for ${tradeMode})`}`,
      risk_check: `MT5 ticket ${ticket}`,
    });

    await supabaseAdmin
      .from("bot_runs")
      .update({
        last_tick_at: new Date().toISOString(),
        current_price: last.close,
        last_error: null,
        locked_stake: Number((botFresh as any)?.locked_stake ?? 0) + decision.stake,
      } as any)
      .eq("id", data.id);

    return { ok: true, traded: true, ticket, decision };
  });

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

function secondsToMt5Timeframe(s: number): "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" {
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

function validateMt5TradeSetup(args: {
  decision: any;
  symInfo: Mt5SymbolInfo | null;
  account: { equity?: number; marginFree?: number; marginLevel?: number } | null;
  volume: number;
  sl?: number;
  tp?: number;
  entryPrice: number;
  isSell: boolean;
}) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { decision, symInfo, account, volume, sl, tp, entryPrice, isSell } = args;
  const risk = sl == null ? null : Math.abs(entryPrice - sl);
  const reward = tp == null ? null : Math.abs(tp - entryPrice);
  const rr = risk && reward ? reward / risk : 0;
  const spreadPrice = symInfo ? Number(symInfo.spread ?? 0) * Number(symInfo.point ?? 0) : 0;
  const atr = Number(decision.analysis?.atr14 ?? 0);
  const trend = String(decision.analysis?.trend ?? "").toLowerCase();

  if (Number(decision.confidence ?? 0) < 0.5) errors.push("confidence below MT5 safety floor 50%");
  if (!sl || !tp) errors.push("missing SL/TP");
  if (risk == null || reward == null || risk <= 0 || reward <= 0)
    errors.push("invalid risk/reward distance");
  if (rr > 0 && rr < 0.95) errors.push(`RR ${rr.toFixed(2)} below minimum 0.95`);
  if (isSell && sl != null && sl <= entryPrice) errors.push("SELL stop loss must be above entry");
  if (isSell && tp != null && tp >= entryPrice) errors.push("SELL take profit must be below entry");
  if (!isSell && sl != null && sl >= entryPrice) errors.push("BUY stop loss must be below entry");
  if (!isSell && tp != null && tp <= entryPrice) errors.push("BUY take profit must be above entry");
  if (atr > 0 && spreadPrice > atr * 0.25) errors.push("spread is too large relative to ATR");
  if (atr > 0 && risk != null && risk < atr * 0.35)
    warnings.push("stop may be too tight for current volatility");
  if (trend.includes("bear") && !isSell) errors.push("BUY rejected: trend alignment is bearish");
  if (trend.includes("bull") && isSell) errors.push("SELL rejected: trend alignment is bullish");
  if (account?.marginFree != null && account.marginFree <= 0)
    errors.push("no free margin available");
  if (account?.marginLevel != null && account.marginLevel > 0 && account.marginLevel < 250) {
    errors.push(`margin level ${account.marginLevel.toFixed(0)}% below safety floor 250%`);
  }
  if (volume <= 0) errors.push("invalid volume");

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    risk,
    reward,
    rr: rr ? Number(rr.toFixed(2)) : null,
    spreadPrice,
  };
}

async function fetchMarsHigherTimeframes(
  mt5: Awaited<ReturnType<typeof ensureConnected>>,
  symbol: string,
) {
  const [m5, m15, m30, h1, h4] = await Promise.all([
    mt5.rates(symbol, "5m", 220).then(ratesToCandles),
    mt5.rates(symbol, "15m", 220).then(ratesToCandles),
    mt5.rates(symbol, "30m", 220).then(ratesToCandles),
    mt5.rates(symbol, "1h", 220).then(ratesToCandles),
    mt5.rates(symbol, "4h", 220).then(ratesToCandles),
  ]);
  return { m5, m15, m30, h1, h4 };
}

function netDealProfit(deal: { profit?: number; commission?: number; swap?: number }) {
  return Number(deal.profit ?? 0) + Number(deal.commission ?? 0) + Number(deal.swap ?? 0);
}

async function getRealizedMt5Profit(
  mt5: Awaited<ReturnType<typeof ensureConnected>>,
  ticket: number,
) {
  try {
    const history = await mt5.history(
      Math.floor(Date.now() / 1000) - 86400 * 7,
      Math.floor(Date.now() / 1000),
    );
    const related = history.filter((deal: any) => {
      const positionId = Number(deal.positionId ?? 0);
      const order = Number(deal.order ?? 0);
      const dealTicket = Number(deal.ticket ?? 0);
      return positionId === ticket || order === ticket || dealTicket === ticket;
    });
    if (!related.length) return null;
    return Number(
      related.reduce((sum: number, deal: any) => sum + netDealProfit(deal), 0).toFixed(2),
    );
  } catch {
    return null;
  }
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
  strategy_mode: z.string().default("mars1"),

  selected_strategies: z.array(z.string()).optional().default([]),

  // Position-management overlays (Mars1/Mars3 aware)
  profit_target_usd: z.number().min(0).default(0), // 0 = disabled; e.g. 2 → auto-close at +$2
  early_exit_on_reversal: z.boolean().default(true), // in-profit + reversal signal → close now
  extend_on_high_confidence: z.boolean().default(true), // in-profit + same-side high conf → extend expiry
  balance_conscious_volume: z.boolean().default(true), // scale lots by available / balance
  time_exit_enabled: z.boolean().default(false), // false = SL/TP/basket only; true = 10-candle expiry overlay
  mars4_max_positions: z.number().int().min(1).max(20).default(10),
  mars4_basket_profit_usd: z.number().min(0).default(0),
  mars4_basket_stop_usd: z.number().min(0).default(0),
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
        // stash MT5 volume + overlays in ai_config so we don't need a schema change
        ai_config: {
          volume: data.volume,
          profit_target_usd: data.profit_target_usd,
          early_exit_on_reversal: data.early_exit_on_reversal,
          extend_on_high_confidence: data.extend_on_high_confidence,
          balance_conscious_volume: data.balance_conscious_volume,
          time_exit_enabled: data.time_exit_enabled,
          mars4_max_positions: data.mars4_max_positions,
          mars4_basket_profit_usd: data.mars4_basket_profit_usd,
          mars4_basket_stop_usd: data.mars4_basket_stop_usd,
        },
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
        .update({
          last_error: e?.message ?? "MT5 not connected",
          last_tick_at: new Date().toISOString(),
        } as any)
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

    // Prefer externally supplied candles when available. This lets Deriv-derived
    // synthetic index data drive the analysis while MT5 remains the execution venue.
    const candles =
      data.candles && data.candles.length >= 61
        ? (data.candles as Candle[])
        : ratesToCandles(await mt5.rates((bot as any).symbol, timeframe, 220));
    const last = candles.at(-1);
    if (!last) return { ok: false, error: "No candles" };

    let symInfo: Mt5SymbolInfo | null = null;
    try {
      symInfo = await mt5.symbolInfo((bot as any).symbol);
    } catch {
      /* ignore — we can still mark positions */
    }

    // 1) Mark any open positions using MT5 broker truth.
    // IMPORTANT: MT5 is CFD-style, not binary options. Do not use the Deriv
    // simulator payout (+stake*0.85 / -stake) for MT5 results; use MT5's
    // position.profit / deal history so spread, bid/ask fill and slippage are reflected.

    // Position-management overlay config (per-bot ai_config)
    const aiCfg = (bot as any).ai_config ?? {};
    const profitTargetUsd = Number(aiCfg.profit_target_usd ?? 0);
    const earlyExitOnReversal = aiCfg.early_exit_on_reversal !== false;
    const extendOnHighConf = aiCfg.extend_on_high_confidence !== false;
    const timeExitEnabled = aiCfg.time_exit_enabled === true;
    const mars4ConfiguredMaxPositions = Math.max(
      1,
      Math.min(20, Number(aiCfg.mars4_max_positions ?? 10)),
    );

    // Quick reversal read using Mars1 (cheap, deterministic) — used ONLY for
    // in-profit position management, never to override the main strategy pick.
    let quickAnalysis: Awaited<
      ReturnType<typeof import("@/lib/strategies/mars").analyzeMars1>
    > | null = null;
    try {
      const { analyzeMars1 } = await import("@/lib/strategies/mars");
      quickAnalysis = analyzeMars1(candles);
    } catch {
      quickAnalysis = null;
    }

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
        expires_epoch:
          (pos as any).expires_epoch == null ? null : Number((pos as any).expires_epoch),
      };
      const mark = markOpenPosition(
        timeExitEnabled ? like : { ...like, expires_epoch: null },
        last,
      );
      const externalTicket = (pos as any).external_contract_id
        ? Number((pos as any).external_contract_id)
        : null;
      let mt5Position: any = null;
      if (externalTicket) {
        try {
          mt5Position =
            (await mt5.positions()).find((p: any) => Number(p.ticket) === externalTicket) ?? null;
        } catch {
          mt5Position = null;
        }
      }

      // ── Position-management overlays (only when broker hasn't closed & mark didn't fire) ──
      const brokerFloatingPnl = mt5Position ? Number(mt5Position.profit ?? 0) : mark.floatingPnl;
      const posDirIsBuy = like.direction === "CALL";
      const q = quickAnalysis;
      const reversalOpposes =
        !!q &&
        q.decision !== "WAIT" &&
        ((posDirIsBuy && q.decision === "SELL") || (!posDirIsBuy && q.decision === "BUY"));
      const sameSideHighConf =
        !!q &&
        q.decision !== "WAIT" &&
        ((posDirIsBuy && q.decision === "BUY") || (!posDirIsBuy && q.decision === "SELL")) &&
        q.confidence >= 0.75;

      let forceCloseReason: string | null = null;
      if (!mark.closed) {
        // A) Profit-target lock-in ($ ceiling per trade)
        if (profitTargetUsd > 0 && brokerFloatingPnl >= profitTargetUsd) {
          forceCloseReason = `Profit target $${profitTargetUsd.toFixed(2)} reached (floating $${brokerFloatingPnl.toFixed(2)}) — locking gains`;
        }
        // B) In-profit reversal → don't give it back
        else if (earlyExitOnReversal && brokerFloatingPnl > 0 && reversalOpposes) {
          forceCloseReason = `Reversal signal (${q!.strategy} → ${q!.decision}) while +$${brokerFloatingPnl.toFixed(2)} — closing to lock profit`;
        }

        // C) Extend expiry when in profit and same-side high confidence
        if (
          !forceCloseReason &&
          extendOnHighConf &&
          brokerFloatingPnl > 0 &&
          sameSideHighConf &&
          like.expires_epoch
        ) {
          const remaining = Number(like.expires_epoch) - Number(last.epoch);
          // Only extend if we're nearing expiry (< 3 candles left)
          if (remaining < tfSec * 3) {
            const newExpires = Number(last.epoch) + BOT_MAX_HOLD_CANDLES * tfSec;
            await supabaseAdmin
              .from("bot_positions")
              .update({ expires_epoch: newExpires } as any)
              .eq("id", (pos as any).id);
            like.expires_epoch = newExpires;
            await supabaseAdmin.from("bot_activity").insert({
              user_id: context.userId,
              bot_run_id: data.id,
              action: "SCAN",
              symbol: (bot as any).symbol,
              direction: like.direction,
              entry_price: like.entry_price,
              reasoning: `Hold extended: in profit $${brokerFloatingPnl.toFixed(2)} + high-conf continuation (${(q!.confidence * 100).toFixed(0)}%)`,
              risk_check: `Expiry pushed by ${BOT_MAX_HOLD_CANDLES}×${tfSec}s`,
            } as any);
          }
        }
      }

      if (forceCloseReason && !mark.closed) {
        (mark as any).closed = true;
        (mark as any).exitPrice = last.close;
        (mark as any).outcome = brokerFloatingPnl > 0 ? "win" : "loss";
        (mark as any).reason = forceCloseReason;
      }

      if (mark.closed) {
        let brokerPnl = mt5Position ? Number(mt5Position.profit ?? 0) : null;
        let closeNote = externalTicket ? `MT5 ticket ${externalTicket}` : "Local settlement";
        if (externalTicket) {
          try {
            await mt5.positionsClose(externalTicket);
            const realized = await getRealizedMt5Profit(mt5, externalTicket);
            if (realized != null) brokerPnl = realized;
            closeNote = `MT5 ticket ${externalTicket} closed`;
          } catch (e) {
            // continue — if MT5 already closed the position via TP/SL, history may still contain truth
            const realized = await getRealizedMt5Profit(mt5, externalTicket);
            if (realized != null) brokerPnl = realized;
            closeNote =
              realized != null
                ? `MT5 ticket ${externalTicket} already closed by broker`
                : `MT5 close failed for ticket ${externalTicket}`;
            console.error("mt5 close failed", e);
          }
        }
        const pnl = Number((brokerPnl ?? 0).toFixed(2));
        const outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven";
        await supabaseAdmin
          .from("bot_positions")
          .update({
            status: "closed",
            outcome,
            exit_price: mark.exitPrice,
            pnl,
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
          pnl,
          reasoning: `MT5 ${outcome.toUpperCase()} — ${mark.reason}. Broker P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
          risk_check: closeNote,
        } as any);

        await supabaseAdmin
          .from("bot_runs")
          .update({
            total_pnl: Number((bot as any).total_pnl ?? 0) + pnl,
            total_trades: Number((bot as any).total_trades ?? 0) + 1,
            wins: Number((bot as any).wins ?? 0) + (outcome === "win" ? 1 : 0),
            losses: Number((bot as any).losses ?? 0) + (outcome === "loss" ? 1 : 0),
            locked_stake: Math.max(
              0,
              Number((bot as any).locked_stake ?? 0) - Number((pos as any).stake),
            ),
          } as any)
          .eq("id", data.id);
      } else {
        const floatingPnl = mt5Position
          ? Number(Number(mt5Position.profit ?? 0).toFixed(2))
          : mark.floatingPnl;
        await supabaseAdmin
          .from("bot_positions")
          .update({
            current_price: mt5Position?.priceCurrent ?? last.close,
            floating_pnl: floatingPnl,
          } as any)
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

    // Compute consecutive losses from the last 10 EXIT rows (loss-streak brake)
    const { data: recentExits } = await supabaseAdmin
      .from("bot_activity")
      .select("action, pnl, created_at")
      .eq("user_id", context.userId)
      .eq("bot_run_id", data.id)
      .eq("action", "EXIT")
      .order("created_at", { ascending: false })
      .limit(10);
    let consecutiveLosses = 0;
    for (const row of recentExits ?? []) {
      if (Number((row as any).pnl ?? 0) < 0) consecutiveLosses += 1;
      else break;
    }

    // 2) Analyze new decision — route STRICTLY by the bot's strategy_mode.
    //    - "qwen"          → Qwen AI decision (Mars1 features supplied for context)
    //    - "ob-fvg-strict" → analyze() only (hard-gated OB+FVG)
    //    - "mars1"         → analyzeMars1 (classic 3-detector best-of)
    //    - "mars2"         → analyzeMars2 (tuned for V25(1s) / V15(1s))
    //    - "titan1"        → analyzeTitan1
    //    - "titan2"        → analyzeTitan2
    //    - "multi" / "all" → analyzeStrictConsensus (≥5 strategies must agree)
    //    - specific catalog id (msnr-crt, apa, …) → analyzeEnsemble locked to
    //      just that strategy — no fall-through to multi.
    const strategyMode = String((botFresh as any)?.strategy_mode ?? "mars1");
    const minConfidence = Number((bot as any).min_confidence ?? 0.65);
    const streakThreshold =
      consecutiveLosses >= 3 ? Math.min(0.98, minConfidence + 0.1) : minConfidence;
    const symbol = (bot as any).symbol as string;
    const spreadPrice = symInfo ? Number(symInfo.spread ?? 0) * Number(symInfo.point ?? 0) : 0;

    // Always compute base OB/FVG so activity logs still get zone info
    const obFvgAnalysis = analyze(candles);

    const runStrategy = async () => {
      if (strategyMode === "qwen") {
        const [{ analyzeMarket }, { analyzeMars1 }] = await Promise.all([
          import("@/lib/ai/qwen.functions"),
          import("@/lib/strategies/mars"),
        ]);
        const marsCtx = analyzeMars1(candles);
        const qwenResult = await analyzeMarket({
          data: {
            symbol,
            timeframe: bot.timeframe ?? "1m",
            candles: candles.slice(-60),
            ob_zones: obFvgAnalysis.activeOB
              ? [
                  {
                    type: obFvgAnalysis.activeOB.kind,
                    top: obFvgAnalysis.activeOB.top,
                    bottom: obFvgAnalysis.activeOB.bottom,
                  },
                ]
              : [],
            fvg_zones: obFvgAnalysis.activeFVG
              ? [
                  {
                    type: obFvgAnalysis.activeFVG.kind,
                    top: obFvgAnalysis.activeFVG.top,
                    bottom: obFvgAnalysis.activeFVG.bottom,
                  },
                ]
              : [],
            current_price: last.close,
            balance: available,
          },
        });
        const qwen = qwenResult as any;
        const direction =
          qwen.direction === "CALL" ? "CALL" : qwen.direction === "PUT" ? "PUT" : "NONE";
        return {
          shouldTrade: direction !== "NONE" && Number(qwen.confidence ?? 0) >= streakThreshold,
          direction: direction as "CALL" | "PUT" | "NONE",
          confidence: Number(qwen.confidence ?? 0),
          entryPrice: last.close,
          stake: Math.min((botFresh as any)?.max_stake_per_trade ?? 50, available),
          stopLoss: qwen.stop_loss ?? null,
          takeProfit: qwen.take_profit ?? null,
          duration: BOT_MAX_HOLD_CANDLES,
          durationUnit: "m" as const,
          analysis: marsCtx,
          reasoning: `Qwen AI: ${qwen.reasoning ?? "n/a"}${consecutiveLosses >= 3 ? ` | Loss-streak brake +10% (${consecutiveLosses})` : ""}`,
          obZone: formatObZone(obFvgAnalysis),
          fvgZone: formatFvgZone(obFvgAnalysis),
          strategy: "qwen" as any,
        };
      }

      // Resolve a LiveAnalysis according to mode, then adapt to bot decision.
      let livePromise;
      if (strategyMode === "ob-fvg-strict") {
        livePromise = Promise.resolve(obFvgAnalysis);
      } else if (strategyMode === "mars1") {
        livePromise = import("@/lib/strategies/mars").then((m) => m.analyzeMars1(candles));
      } else if (strategyMode === "mars2") {
        livePromise = import("@/lib/strategies/mars").then((m) => m.analyzeMars2(candles, symbol));
      } else if (strategyMode === "mars3") {
        livePromise = import("@/lib/strategies/mars").then((m) =>
          fetchMarsHigherTimeframes(mt5, symbol).then((higherTimeframes) =>
            m.analyzeMars3(candles, { balance: available, symbolHint: symbol, higherTimeframes }),
          ),
        );
      } else if (strategyMode === "mars4") {
        livePromise = import("@/lib/strategies/mars").then((m) =>
          fetchMarsHigherTimeframes(mt5, symbol).then((higherTimeframes) =>
            m.analyzeMars4(candles, {
              balance: available,
              symbolHint: symbol,
              higherTimeframes,
              spreadPrice,
              nowEpoch: Math.floor(Date.now() / 1000),
              minConfidence: streakThreshold,
            }),
          ),
        );
      } else if (strategyMode === "titan1") {
        livePromise = import("@/lib/strategies/titan1").then((m) => {
          const t = m.analyzeTitan1(candles);
          return {
            ...obFvgAnalysis,
            decision: t.decision,
            confidence: t.confidence,
            entry: t.entry,
            sl: t.sl,
            tp: t.tp,
            strategy: "titan1" as const,
            rationale: t.rationale,
          };
        });
      } else if (strategyMode === "titan2") {
        livePromise = import("@/lib/strategies/titan2").then((m) => {
          const t = m.analyzeTitan2(candles);
          return {
            ...obFvgAnalysis,
            decision: t.decision,
            confidence: t.confidence,
            entry: t.entry,
            sl: t.sl,
            tp: t.tp,
            strategy: "titan2" as const,
            rationale: t.rationale,
          };
        });
      } else if (strategyMode === "multi" || strategyMode === "all") {
        livePromise = import("@/lib/strategies/confluence").then((m) =>
          m.analyzeStrictConsensus(candles, 5),
        );
      } else {
        // Specific strategy id → lock ensemble to just that one
        livePromise = import("@/lib/strategies/confluence").then((m) =>
          m.analyzeEnsemble(candles, 70, [strategyMode as any]),
        );
      }
      const analysis = await livePromise;

      const direction: "CALL" | "PUT" | "NONE" =
        analysis.decision === "BUY" ? "CALL" : analysis.decision === "SELL" ? "PUT" : "NONE";
      const stake = Math.min((botFresh as any)?.max_stake_per_trade ?? 50, available);
      const shouldTrade =
        direction !== "NONE" && analysis.confidence >= streakThreshold && stake > 0;
      const brake =
        consecutiveLosses >= 3 ? ` | Loss-streak brake +10% (streak ${consecutiveLosses})` : "";
      return {
        shouldTrade,
        direction,
        confidence: analysis.confidence,
        entryPrice: analysis.entry ?? last.close,
        stake,
        stopLoss: analysis.sl ?? null,
        takeProfit: analysis.tp ?? null,
        duration: BOT_MAX_HOLD_CANDLES,
        durationUnit: "m" as const,
        analysis,
        reasoning: `[${strategyMode}] ${analysis.rationale}${!shouldTrade && direction !== "NONE" ? ` | Confidence ${(analysis.confidence * 100).toFixed(0)}% below ${(streakThreshold * 100).toFixed(0)}%` : ""}${brake}`,
        obZone: formatObZone(obFvgAnalysis),
        fvgZone: formatFvgZone(obFvgAnalysis),
        strategy: (analysis.strategy ?? strategyMode) as any,
      };
    };

    let decision: Awaited<ReturnType<typeof runStrategy>>;
    try {
      decision = await runStrategy();
    } catch (err) {
      // Fall back to Mars1 on any strategy error so the bot keeps ticking.
      const { analyzeMars1 } = await import("@/lib/strategies/mars");
      const a = analyzeMars1(candles);
      const dir: "CALL" | "PUT" | "NONE" =
        a.decision === "BUY" ? "CALL" : a.decision === "SELL" ? "PUT" : "NONE";
      decision = {
        shouldTrade: false,
        direction: dir,
        confidence: a.confidence,
        entryPrice: a.entry ?? last.close,
        stake: 0,
        stopLoss: a.sl ?? null,
        takeProfit: a.tp ?? null,
        duration: BOT_MAX_HOLD_CANDLES,
        durationUnit: "m" as const,
        analysis: a,
        reasoning: `[${strategyMode}] Error running strategy, fell back to Mars1 diagnostics: ${err instanceof Error ? err.message : String(err)}`,
        obZone: formatObZone(obFvgAnalysis),
        fvgZone: formatFvgZone(obFvgAnalysis),
        strategy: strategyMode as any,
      };
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

    if (strategyMode === "mars4") {
      const currentOpen = (openRows ?? []).filter(
        (p: any) => String(p.status ?? "open") === "open",
      );
      const maxFromAnalysis = Number(
        (decision as any).analysis?.maxScalePositions ?? mars4ConfiguredMaxPositions,
      );
      const maxMars4Positions = Math.min(mars4ConfiguredMaxPositions, maxFromAnalysis);
      const sameSideOpen = currentOpen.filter((p: any) => p.direction === decision.direction);
      const oppositeOpen = currentOpen.filter((p: any) => p.direction !== decision.direction);
      const scaleAllowed = (decision as any).analysis?.scaleAllowed !== false;
      if (!scaleAllowed || oppositeOpen.length > 0 || sameSideOpen.length >= maxMars4Positions) {
        await supabaseAdmin.from("bot_activity").insert({
          ...commonLog,
          action: "SKIP",
          direction: decision.direction,
          entry_price: decision.entryPrice,
          stake: null,
          stop_loss: decision.stopLoss,
          take_profit: decision.takeProfit,
          pnl: null,
          reasoning: `Mars4 scaling blocked — scale=${scaleAllowed}, same-side ${sameSideOpen.length}/${maxMars4Positions}, opposite ${oppositeOpen.length}. ${decision.reasoning}`,
          risk_check: `Mars4 controlled basket guard | Available ${available.toFixed(2)} USD`,
        } as any);
        await supabaseAdmin
          .from("bot_runs")
          .update({ last_tick_at: new Date().toISOString(), current_price: last.close } as any)
          .eq("id", data.id);
        return { ok: true, traded: false, skipped: "mars4_basket_guard", decision };
      }
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

    // Base volume from ai_config, then apply Mars3 rescale (wider SL → smaller lots)
    // and balance-conscious scaling (available/balance ratio, clamped 0.3..1.2).
    const baseVol = Number((bot as any).ai_config?.volume ?? 0.01);
    const mars3Mult = Number((decision as any)?.analysis?.volumeMultiplier ?? 1);
    const balConscious = (bot as any).ai_config?.balance_conscious_volume !== false;
    const balanceRatio = balance > 0 ? Math.max(0.3, Math.min(1.2, available / balance)) : 1;
    const balMult = balConscious ? balanceRatio : 1;
    const rawVol = baseVol * mars3Mult * balMult;
    const volume = symInfo ? normalizeVolume(rawVol, symInfo) : Number(rawVol.toFixed(2));
    const digits = symInfo?.digits ?? 5;
    const sl = decision.stopLoss == null ? undefined : roundToDigits(decision.stopLoss, digits);
    const tp = decision.takeProfit == null ? undefined : roundToDigits(decision.takeProfit, digits);

    let accountInfo: any = null;
    try {
      accountInfo = await mt5.accountInfo();
    } catch {
      accountInfo = null;
    }

    const guard = validateMt5TradeSetup({
      decision,
      symInfo,
      account: accountInfo,
      volume,
      sl,
      tp,
      entryPrice: decision.entryPrice,
      isSell: adjustedIsSell,
    });

    if (!guard.ok) {
      await supabaseAdmin.from("bot_activity").insert({
        ...commonLog,
        action: "SKIP",
        direction: adjustedDirection,
        entry_price: decision.entryPrice,
        stake: decision.stake,
        stop_loss: sl ?? null,
        take_profit: tp ?? null,
        pnl: null,
        reasoning: `MT5 trade rejected by execution guard: ${guard.errors.join("; ")}`,
        risk_check: `RR ${guard.rr ?? "—"} | Risk ${guard.risk?.toFixed(5) ?? "—"} | Reward ${guard.reward?.toFixed(5) ?? "—"} | Spread ${guard.spreadPrice.toFixed(5)}${guard.warnings.length ? ` | Warnings: ${guard.warnings.join("; ")}` : ""}`,
      } as any);
      await supabaseAdmin
        .from("bot_runs")
        .update({ last_tick_at: new Date().toISOString(), current_price: last.close } as any)
        .eq("id", data.id);
      return { ok: true, traded: false, rejected: true, guard };
    }

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
    const expiresEpoch = timeExitEnabled ? last.epoch + BOT_MAX_HOLD_CANDLES * tfSec : null;
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

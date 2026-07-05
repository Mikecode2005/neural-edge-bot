import type { Candle } from "@/lib/deriv-ws";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  BOT_MAX_HOLD_CANDLES,
  BOT_PAYOUT_RATE,
  makeObFvgBotDecision,
  markOpenPosition,
  timeframeToGranularity,
  calculateBotStake,
} from "./bot-engine";
import type { BotDecision, BotDirection } from "./bot-engine";

type AdminClient = typeof supabaseAdmin;

async function addActivity(supabase: AdminClient, row: Record<string, unknown>) {
  await supabase.from("bot_activity").insert(row as any);
}

async function closePosition(args: {
  supabase: AdminClient;
  bot: any;
  position: any;
  candle: Candle;
  mark: ReturnType<typeof markOpenPosition>;
}) {
  const { supabase, bot, position, candle, mark } = args;
  const pnl = Number(mark.pnl.toFixed(2));
  const outcome = mark.outcome ?? (pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven");

  await supabase
    .from("bot_positions")
    .update({
      status: "closed",
      current_price: candle.close,
      exit_price: mark.exitPrice ?? candle.close,
      pnl,
      floating_pnl: 0,
      outcome,
      closed_at: new Date().toISOString(),
    } as any)
    .eq("id", position.id);

  if (position.trade_history_id) {
    await supabase
      .from("trade_history")
      .update({
        exit_price: mark.exitPrice ?? candle.close,
        pnl,
        status: "closed",
        reason_closed: mark.reason,
        closed_at: new Date().toISOString(),
      } as any)
      .eq("id", position.trade_history_id);
  }

  await supabase.from("strategy_memory").insert({
    user_id: bot.user_id,
    symbol: bot.symbol,
    timeframe: bot.timeframe,
    setup_type: "OB+FVG",
    lesson: `Bot ${outcome} on ${bot.symbol}: ${position.direction} at ${Number(position.entry_price).toFixed(4)} closed ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}. Exit reason: ${mark.reason}. Original setup: ${String(position.reasoning ?? "").slice(0, 220)}`,
    outcome,
    pnl,
    tags: ["bot-loop", "post-trade", outcome],
    usefulness_score: outcome === "win" ? 1.35 : 1.2,
  } as any);

  await addActivity(supabase, {
    user_id: bot.user_id,
    bot_run_id: bot.id,
    action: "EXIT",
    symbol: bot.symbol,
    direction: position.direction,
    confidence: null,
    entry_price: position.entry_price,
    stake: position.stake,
    stop_loss: position.stop_loss,
    take_profit: position.take_profit,
    pnl,
    reasoning: `Contract ${outcome.toUpperCase()} — ${mark.reason}. Exit ${Number(mark.exitPrice ?? candle.close).toFixed(4)}, P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
    risk_check: "Settled by broker simulator",
    indicators: {},
  });

  const { data: openPositions } = await supabase
    .from("bot_positions")
    .select("stake, floating_pnl")
    .eq("bot_run_id", bot.id)
    .eq("status", "open");
  const locked = (openPositions ?? []).reduce(
    (sum: number, p: any) => sum + Number(p.stake ?? 0),
    0,
  );
  const floating = (openPositions ?? []).reduce(
    (sum: number, p: any) => sum + Number(p.floating_pnl ?? 0),
    0,
  );

  await supabase
    .from("bot_runs")
    .update({
      total_trades: Number(bot.total_trades ?? 0) + 1,
      total_pnl: Number(bot.total_pnl ?? 0) + pnl,
      wins: Number(bot.wins ?? 0) + (outcome === "win" ? 1 : 0),
      losses: Number(bot.losses ?? 0) + (outcome === "loss" ? 1 : 0),
      locked_stake: locked,
      floating_pnl: floating,
      current_price: candle.close,
      last_tick_at: new Date().toISOString(),
      last_server_loop_at: new Date().toISOString(),
      last_error: null,
    } as any)
    .eq("id", bot.id);
}

async function openSimulatedPosition(args: {
  supabase: AdminClient;
  bot: any;
  decision: ReturnType<typeof makeObFvgBotDecision>;
  candle: Candle;
}) {
  const { supabase, bot, decision, candle } = args;
  const expiresEpoch = candle.epoch + BOT_MAX_HOLD_CANDLES * timeframeToGranularity(bot.timeframe);

  const { data: tradeRow } = await supabase
    .from("trade_history")
    .insert({
      user_id: bot.user_id,
      symbol: bot.symbol,
      side: decision.direction === "CALL" ? "BUY" : "SELL",
      entry_price: decision.entryPrice,
      size: decision.stake,
      status: "open",
      mode: "demo",
      deriv_contract_id: `sim-${bot.id}-${Date.now()}`,
      take_profit: decision.takeProfit,
      stop_loss: decision.stopLoss,
      reason_opened: decision.reasoning,
      opened_at: new Date().toISOString(),
    } as any)
    .select("id")
    .single();

  const { data: pos } = await supabase
    .from("bot_positions")
    .insert({
      user_id: bot.user_id,
      bot_run_id: bot.id,
      symbol: bot.symbol,
      direction: decision.direction,
      account_type: bot.account_type,
      market_mode: bot.market_mode,
      stake: decision.stake,
      payout: Number((decision.stake * (1 + BOT_PAYOUT_RATE)).toFixed(2)),
      entry_price: decision.entryPrice,
      current_price: candle.close,
      stop_loss: decision.stopLoss,
      take_profit: decision.takeProfit,
      duration: BOT_MAX_HOLD_CANDLES,
      duration_unit: "m",
      opened_epoch: candle.epoch,
      expires_epoch: expiresEpoch,
      status: "open",
      trade_history_id: tradeRow?.id ?? null,
      reasoning: decision.reasoning,
    } as any)
    .select("id")
    .single();

  await addActivity(supabase, {
    user_id: bot.user_id,
    bot_run_id: bot.id,
    action: "ENTRY",
    symbol: bot.symbol,
    direction: decision.direction,
    confidence: decision.confidence,
    entry_price: decision.entryPrice,
    stake: decision.stake,
    stop_loss: decision.stopLoss,
    take_profit: decision.takeProfit,
    pnl: null,
    reasoning: decision.reasoning,
    ob_zone: decision.obZone,
    fvg_zone: decision.fvgZone,
    risk_check: `Passed — simulated stake $${decision.stake.toFixed(2)}`,
    indicators: {
      trend: decision.analysis.trend,
      ema20: decision.analysis.ema20,
      ema50: decision.analysis.ema50,
      rsi14: decision.analysis.rsi14,
      atr14: decision.analysis.atr14,
    },
  });

  const lockedStake = Number(bot.locked_stake ?? 0) + decision.stake;
  await supabase
    .from("bot_runs")
    .update({
      locked_stake: lockedStake,
      current_price: candle.close,
      last_tick_at: new Date().toISOString(),
      last_server_loop_at: new Date().toISOString(),
      last_error: null,
    } as any)
    .eq("id", bot.id);

  return pos;
}

export async function analyzeBotDecision(botId: string, candles: Candle[]) {
  const supabase = supabaseAdmin;
  const { data: bot, error } = await supabase
    .from("bot_runs")
    .select("*")
    .eq("id", botId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!bot || bot.status !== "running") return { ok: false, reason: "bot_not_running" };

  if (!candles || candles.length < 61) {
    throw new Error(
      "No real candle data available. Open the dashboard first to stream market data.",
    );
  }

  const latest = candles.at(-1);
  if (!latest) throw new Error("No candle data available");

  const availableBalance =
    Number(bot.account_balance ?? 1000) +
    Number(bot.total_pnl ?? 0) -
    Number(bot.locked_stake ?? 0);

  // If strategy_mode is "qwen", call Qwen AI for the decision
  if (bot.strategy_mode === "qwen") {
    try {
      const { analyze } = await import("@/lib/ob-fvg");
      const analysis = analyze(candles);
      const { analyzeMarket } = await import("@/lib/ai/qwen.functions");
      const qwenResult = await analyzeMarket({
        data: {
          symbol: bot.symbol,
          timeframe: bot.timeframe ?? "1m",
          candles: candles.slice(-60),
          ob_zones: analysis.activeOB
            ? [
                {
                  type: analysis.activeOB.kind,
                  top: analysis.activeOB.top,
                  bottom: analysis.activeOB.bottom,
                },
              ]
            : [],
          fvg_zones: analysis.activeFVG
            ? [
                {
                  type: analysis.activeFVG.kind,
                  top: analysis.activeFVG.top,
                  bottom: analysis.activeFVG.bottom,
                },
              ]
            : [],
          current_price: latest.close,
          balance: availableBalance,
        },
      });

      const qwen = qwenResult as any;
      const direction =
        qwen.direction === "CALL" ? "CALL" : qwen.direction === "PUT" ? "PUT" : "NONE";
      const confidence = Number(qwen.confidence ?? 0);
      const stake = calculateBotStake({
        availableBalance,
        minStake: Number(bot.min_stake_per_trade ?? 0.35),
        maxStake: Number(bot.max_stake_per_trade ?? 1),
      });
      const confidenceOk = confidence >= Number(bot.min_confidence ?? 0.65);
      const shouldTrade = direction !== "NONE" && confidenceOk && stake > 0;

      const decision: BotDecision = {
        shouldTrade,
        direction: direction as BotDirection | "NONE",
        confidence,
        entryPrice: latest.close,
        stake,
        stopLoss: qwen.stop_loss ?? null,
        takeProfit: qwen.take_profit ?? null,
        duration: Number(qwen.duration ?? BOT_MAX_HOLD_CANDLES),
        durationUnit: "m",
        analysis: analysis as any,
        reasoning: `Qwen AI: ${qwen.reasoning ?? "No reasoning provided"}`,
        obZone: analysis.activeOB
          ? `${analysis.activeOB.kind} OB [${analysis.activeOB.bottom.toFixed(4)}, ${analysis.activeOB.top.toFixed(4)}]`
          : null,
        fvgZone: analysis.activeFVG
          ? `${analysis.activeFVG.kind} FVG [${analysis.activeFVG.bottom.toFixed(4)}, ${analysis.activeFVG.top.toFixed(4)}]`
          : null,
        strategy: "ob-fvg",
      };

      return {
        ok: true,
        decision,
        latestClose: latest.close,
        latestEpoch: latest.epoch,
        symbol: bot.symbol,
        timeframe: bot.timeframe,
        accountBalance: Number(bot.account_balance ?? 1000),
        totalPnl: Number(bot.total_pnl ?? 0),
      };
    } catch (e: any) {
      // Fallback to OB+FVG if Qwen fails
      console.error("Qwen AI failed, falling back to OB+FVG:", e?.message);
    }
  }

  // Default: OB+FVG strategy
  const decision = makeObFvgBotDecision(candles, {
    minConfidence: Number(bot.min_confidence ?? 0.65),
    availableBalance,
    minStake: Number(bot.min_stake_per_trade ?? 0.35),
    maxStake: Number(bot.max_stake_per_trade ?? 1),
  });

  return {
    ok: true,
    decision,
    latestClose: latest.close,
    latestEpoch: latest.epoch,
    symbol: bot.symbol,
    timeframe: bot.timeframe,
    accountBalance: Number(bot.account_balance ?? 1000),
    totalPnl: Number(bot.total_pnl ?? 0),
  };
}

export async function processBotTick(botId: string, candles?: Candle[]) {
  const supabase = supabaseAdmin;
  const { data: bot, error } = await supabase
    .from("bot_runs")
    .select("*")
    .eq("id", botId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!bot || bot.status !== "running") return { ok: false, reason: "bot_not_running" };

  try {
    // If candles were not passed from the browser, try to read from the in-memory store
    if (!candles || candles.length < 61) {
      const { getCandles } = await import("./candle-store");
      candles = getCandles(bot.symbol, bot.timeframe ?? "1m", 61);
    }

    if (!candles || candles.length < 61) {
      throw new Error(
        "No real candle data available. Open the dashboard first to stream market data.",
      );
    }

    const latest = candles.at(-1);
    if (!latest) throw new Error("No candle data available");

    const { data: openPositions } = await supabase
      .from("bot_positions")
      .select("*")
      .eq("bot_run_id", bot.id)
      .eq("status", "open")
      .order("opened_at", { ascending: true });

    if ((openPositions ?? []).length) {
      for (const position of openPositions ?? []) {
        const mark = markOpenPosition(position as any, latest);
        if (mark.closed) {
          await closePosition({ supabase, bot, position, candle: latest, mark });
        } else {
          await supabase
            .from("bot_positions")
            .update({ current_price: latest.close, floating_pnl: mark.floatingPnl } as any)
            .eq("id", position.id);
        }
      }
      const { data: remaining } = await supabase
        .from("bot_positions")
        .select("stake, floating_pnl")
        .eq("bot_run_id", bot.id)
        .eq("status", "open");
      await supabase
        .from("bot_runs")
        .update({
          current_price: latest.close,
          locked_stake: (remaining ?? []).reduce(
            (s: number, p: any) => s + Number(p.stake ?? 0),
            0,
          ),
          floating_pnl: (remaining ?? []).reduce(
            (s: number, p: any) => s + Number(p.floating_pnl ?? 0),
            0,
          ),
          last_tick_at: new Date().toISOString(),
          last_server_loop_at: new Date().toISOString(),
          last_error: null,
        } as any)
        .eq("id", bot.id);
      return { ok: true, action: "marked_open_positions", open: remaining?.length ?? 0 };
    }

    const availableBalance =
      Number(bot.account_balance ?? 1000) +
      Number(bot.total_pnl ?? 0) -
      Number(bot.locked_stake ?? 0);
    const decision = makeObFvgBotDecision(candles, {
      minConfidence: Number(bot.min_confidence ?? 0.65),
      availableBalance,
      minStake: Number(bot.min_stake_per_trade ?? 0.35),
      maxStake: Number(bot.max_stake_per_trade ?? 1),
    });

    if (!decision.shouldTrade) {
      await addActivity(supabase, {
        user_id: bot.user_id,
        bot_run_id: bot.id,
        action: "SCAN",
        symbol: bot.symbol,
        direction: decision.direction,
        confidence: decision.confidence,
        entry_price: decision.entryPrice,
        stake: null,
        stop_loss: decision.stopLoss,
        take_profit: decision.takeProfit,
        pnl: null,
        reasoning: decision.reasoning,
        ob_zone: decision.obZone,
        fvg_zone: decision.fvgZone,
        risk_check: "No trade",
        indicators: {
          trend: decision.analysis.trend,
          ema20: decision.analysis.ema20,
          ema50: decision.analysis.ema50,
          rsi14: decision.analysis.rsi14,
          atr14: decision.analysis.atr14,
        },
      });
      await supabase
        .from("bot_runs")
        .update({
          current_price: latest.close,
          floating_pnl: 0,
          last_tick_at: new Date().toISOString(),
          last_server_loop_at: new Date().toISOString(),
          last_error: null,
        } as any)
        .eq("id", bot.id);
      return { ok: true, action: "scan", confidence: decision.confidence };
    }

    await openSimulatedPosition({ supabase, bot, decision, candle: latest });
    return { ok: true, action: "entry", direction: decision.direction, stake: decision.stake };
  } catch (e: any) {
    await supabase
      .from("bot_runs")
      .update({
        last_error: e?.message ?? "Bot loop failed",
        last_server_loop_at: new Date().toISOString(),
      } as any)
      .eq("id", bot.id);
    await addActivity(supabase, {
      user_id: bot.user_id,
      bot_run_id: bot.id,
      action: "ERROR",
      symbol: bot.symbol,
      direction: "—",
      confidence: 0,
      reasoning: e?.message ?? "Bot loop failed",
      indicators: {},
    });
    return { ok: false, reason: e?.message ?? "Bot loop failed" };
  }
}

export async function processDueBots(limit = 10) {
  const supabase = supabaseAdmin;
  const { data: bots, error } = await supabase
    .from("bot_runs")
    .select("id, interval_seconds, last_server_loop_at, last_tick_at")
    .eq("status", "running")
    .eq("server_loop_enabled", true)
    .order("last_server_loop_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  const now = Date.now();
  const due = (bots ?? []).filter((bot: any) => {
    const last = bot.last_server_loop_at || bot.last_tick_at;
    if (!last) return true;
    return now - new Date(last).getTime() >= Number(bot.interval_seconds ?? 60) * 1000;
  });

  const results = [];
  for (const bot of due) {
    results.push({ bot_id: bot.id, ...(await processBotTick(bot.id)) });
  }
  return { processed: results.length, results };
}

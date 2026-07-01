import type { Candle } from "@/lib/deriv-ws";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  BOT_MAX_HOLD_CANDLES,
  BOT_PAYOUT_RATE,
  makeObFvgBotDecision,
  markOpenPosition,
  timeframeToGranularity,
} from "./bot-engine";
import { getCandlesWithFallback } from "./candle-feed";

type AdminClient = typeof supabaseAdmin;

function appId() {
  return process.env.DERIV_APP_ID || process.env.VITE_DERIV_APP_ID || "1089";
}

async function derivWsRequest<T>(payload: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error("Server WebSocket is unavailable in this runtime");

  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocketCtor(`wss://ws.derivws.com/websockets/v3?app_id=${appId()}`);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error("Deriv request timeout"));
    }, timeoutMs);

    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Deriv WebSocket error"));
    };
    ws.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data));
      if (msg.error) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* noop */
        }
        reject(new Error(msg.error.message || "Deriv error"));
        return;
      }
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve(msg as T);
    };
  });
}

async function fetchCandles(symbol: string, granularity: number, count = 200): Promise<Candle[]> {
  const res = await derivWsRequest<{ candles?: Array<Record<string, unknown>> }>({
    ticks_history: symbol,
    adjust_start_time: 1,
    count,
    end: "latest",
    granularity,
    style: "candles",
  });
  return (res.candles ?? []).map((c: any) => ({
    epoch: Number(c.epoch),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
  }));
}

async function fetchCandlesForBot(bot: any, granularity: number, count = 220): Promise<Candle[]> {
  const startPrice = Number(bot.current_price ?? bot.account_balance ?? 1000);
  return getCandlesWithFallback(
    () => fetchCandles(bot.symbol, granularity, count),
    startPrice,
    count,
  );
}

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
  const locked = (openPositions ?? []).reduce((sum: number, p: any) => sum + Number(p.stake ?? 0), 0);
  const floating = (openPositions ?? []).reduce((sum: number, p: any) => sum + Number(p.floating_pnl ?? 0), 0);

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

export async function processBotTick(botId: string) {
  const supabase = supabaseAdmin;
  const { data: bot, error } = await supabase.from("bot_runs").select("*").eq("id", botId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!bot || bot.status !== "running") return { ok: false, reason: "bot_not_running" };

  try {
    const granularity = timeframeToGranularity(bot.timeframe);
    const candles = await fetchCandlesForBot(bot, granularity, 220);
    const latest = candles.at(-1);
    if (!latest || candles.length < 61) throw new Error("Not enough candles for OB+FVG bot loop");

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
          locked_stake: (remaining ?? []).reduce((s: number, p: any) => s + Number(p.stake ?? 0), 0),
          floating_pnl: (remaining ?? []).reduce((s: number, p: any) => s + Number(p.floating_pnl ?? 0), 0),
          last_tick_at: new Date().toISOString(),
          last_server_loop_at: new Date().toISOString(),
          last_error: null,
        } as any)
        .eq("id", bot.id);
      return { ok: true, action: "marked_open_positions", open: remaining?.length ?? 0 };
    }

    const availableBalance = Number(bot.account_balance ?? 1000) + Number(bot.total_pnl ?? 0) - Number(bot.locked_stake ?? 0);
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

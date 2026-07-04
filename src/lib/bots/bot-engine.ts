import type { Candle } from "@/lib/deriv-ws";
import { analyze, analyzeMulti, type LiveAnalysis, type StrategyKind } from "@/lib/ob-fvg";

export const BOT_PAYOUT_RATE = 0.85;
export const BOT_MAX_HOLD_CANDLES = 10;

export type BotDirection = "CALL" | "PUT";

export interface BotDecision {
  shouldTrade: boolean;
  direction: BotDirection | "NONE";
  confidence: number;
  entryPrice: number;
  stake: number;
  stopLoss: number | null;
  takeProfit: number | null;
  duration: number;
  durationUnit: "m";
  analysis: LiveAnalysis;
  reasoning: string;
  obZone: string | null;
  fvgZone: string | null;
  strategy: StrategyKind;
}

export interface OpenBotPositionLike {
  id?: string;
  direction: BotDirection;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  stake: number;
  opened_epoch: number;
  expires_epoch: number | null;
}

export interface PositionMark {
  closed: boolean;
  outcome?: "win" | "loss" | "breakeven";
  exitPrice?: number;
  pnl: number;
  floatingPnl: number;
  reason: string;
}

export function timeframeToGranularity(timeframe?: string | null) {
  const raw = timeframe ?? "1m";
  const n = Number.parseInt(raw, 10) || 1;
  if (raw.endsWith("s")) return Math.max(1, n);
  if (raw.endsWith("h")) return n * 3600;
  return n * 60;
}

export function formatObZone(analysis: LiveAnalysis) {
  return analysis.activeOB
    ? `${analysis.activeOB.kind} OB [${analysis.activeOB.bottom.toFixed(4)}, ${analysis.activeOB.top.toFixed(4)}]`
    : null;
}

export function formatFvgZone(analysis: LiveAnalysis) {
  return analysis.activeFVG
    ? `${analysis.activeFVG.kind} FVG [${analysis.activeFVG.bottom.toFixed(4)}, ${analysis.activeFVG.top.toFixed(4)}]`
    : null;
}

export function calculateBotStake(args: {
  availableBalance: number;
  minStake: number;
  maxStake: number;
}) {
  const available = Math.max(0, args.availableBalance);
  if (available < args.minStake) return 0;
  const bounded = Math.min(args.maxStake, available * 0.5, available);
  return Math.max(args.minStake, Number(bounded.toFixed(2)));
}

export function makeObFvgBotDecision(
  candles: Candle[],
  opts: {
    minConfidence: number;
    availableBalance: number;
    minStake: number;
    maxStake: number;
    consecutiveLosses?: number;
    useMultiStrategy?: boolean;
  },
): BotDecision {
  const window = candles.slice(-200);
  const analysis = opts.useMultiStrategy === false ? analyze(window) : analyzeMulti(window);
  const last = window.at(-1);
  const obZone = formatObZone(analysis);
  const fvgZone = formatFvgZone(analysis);

  const entryPrice = analysis.entry ?? last?.close ?? 0;

  let direction: BotDirection | "NONE" = "NONE";
  if (analysis.decision === "BUY") direction = "CALL";
  else if (analysis.decision === "SELL") direction = "PUT";

  const stopLoss = analysis.sl ?? null;
  const takeProfit = analysis.tp ?? null;

  const stake = calculateBotStake({
    availableBalance: opts.availableBalance,
    minStake: opts.minStake,
    maxStake: opts.maxStake,
  });

  // Loss-streak brake: bump required confidence by +0.10 after 3+ consecutive losses.
  const streak = Math.max(0, opts.consecutiveLosses ?? 0);
  const effectiveThreshold = streak >= 3 ? Math.min(0.98, opts.minConfidence + 0.10) : opts.minConfidence;
  const confidenceOk = analysis.confidence >= effectiveThreshold;

  const shouldTrade = direction !== "NONE" && confidenceOk && stake > 0;

  const brake = streak >= 3
    ? ` | Loss-streak brake active (${streak} losses) — threshold raised to ${(effectiveThreshold * 100).toFixed(0)}%`
    : "";
  const below = confidenceOk
    ? ""
    : ` | Confidence ${(analysis.confidence * 100).toFixed(0)}% below threshold ${(effectiveThreshold * 100).toFixed(0)}%`;
  const noFunds = stake > 0 ? "" : " | Available balance is below minimum stake";
  const strat = analysis.strategy ?? "ob-fvg";

  return {
    shouldTrade,
    direction,
    confidence: analysis.confidence,
    entryPrice,
    stake,
    stopLoss,
    takeProfit,
    duration: BOT_MAX_HOLD_CANDLES,
    durationUnit: "m",
    analysis,
    reasoning: `[${strat}] ${analysis.rationale}${below}${brake}${noFunds}`,
    obZone,
    fvgZone,
    strategy: strat,
  };
}

export function markOpenPosition(
  position: OpenBotPositionLike,
  candle: Candle,
): PositionMark {
  const directionSign = position.direction === "CALL" ? 1 : -1;
  const entry = Number(position.entry_price);
  const stake = Number(position.stake);
  const tp = position.take_profit == null ? null : Number(position.take_profit);
  const sl = position.stop_loss == null ? null : Number(position.stop_loss);

  const hitTP =
    tp != null && (position.direction === "CALL" ? candle.high >= tp : candle.low <= tp);
  const hitSL =
    sl != null && (position.direction === "CALL" ? candle.low <= sl : candle.high >= sl);
  const expired = position.expires_epoch != null && candle.epoch >= Number(position.expires_epoch);

  if (hitTP || hitSL || expired) {
    const exitPrice = hitTP ? tp! : hitSL ? sl! : candle.close;
    const won = hitTP || (!hitSL && (exitPrice - entry) * directionSign > 0);
    const pnl = won ? stake * BOT_PAYOUT_RATE : -stake;
    return {
      closed: true,
      outcome: won ? "win" : "loss",
      exitPrice,
      pnl,
      floatingPnl: 0,
      reason: hitTP
        ? "Take-profit boundary touched"
        : hitSL
          ? "Stop-loss boundary touched"
          : "Maximum hold window reached",
    };
  }

  const target = position.direction === "CALL" ? tp : sl;
  const risk = position.direction === "CALL" ? sl : tp;
  const favorableDistance = target == null ? 0 : Math.abs(target - entry);
  const adverseDistance = risk == null ? 0 : Math.abs(entry - risk);
  const moved = (candle.close - entry) * directionSign;
  const floatingPnl = moved >= 0
    ? Math.min(stake * BOT_PAYOUT_RATE, favorableDistance > 0 ? (moved / favorableDistance) * stake * BOT_PAYOUT_RATE : 0)
    : Math.max(-stake, adverseDistance > 0 ? (moved / adverseDistance) * stake : -stake);

  return {
    closed: false,
    pnl: 0,
    floatingPnl: Number(floatingPnl.toFixed(2)),
    reason: "Open contract marked to latest candle",
  };
}

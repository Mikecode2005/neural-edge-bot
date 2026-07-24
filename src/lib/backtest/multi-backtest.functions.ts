/**
 * Multi-strategy backtester.
 *
 * Walks candles through the selected strategy bar-by-bar, opens simulated trades
 * when the strategy returns BUY/SELL with confidence ≥ minScore/100, and
 * settles on SL/TP or a max-hold window. Returns per-strategy performance
 * metrics + an equity curve so the Strategy Lab UI can render them.
 *
 * Supports direct Mars1–Mars5 routing, individual catalog strategies,
 * and the full ensemble.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { Candle } from "@/lib/deriv-ws";
import type { LiveAnalysis } from "@/lib/ob-fvg";

const CandleZ = z.object({
  epoch: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
});

const RunInput = z.object({
  symbol: z.string(),
  timeframe: z.string().default("1m"),
  candles: z.array(CandleZ).min(200),
  minScore: z.number().default(70),
  riskPerTrade: z.number().default(1), // 1R units
  maxHold: z.number().default(20),
  selectedStrategies: z.array(z.string()).optional(),
  /** Strategy mode from the UI — "all", "mars1", "mars2", etc. */
  strategyMode: z.string().optional(),
});

interface SimTrade {
  strategy: string;
  regime: string;
  dir: "BUY" | "SELL";
  entryEpoch: number;
  exitEpoch: number;
  entry: number;
  exit: number;
  sl: number;
  tp: number;
  score: number;
  rMultiple: number;
  outcome: "win" | "loss" | "expired";
}

/**
 * Aggregate candles to a higher timeframe for Mars3/Mars4/Mars5 backtesting.
 */
function aggregateCandles(candles: Candle[], size: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += size) {
    const chunk = candles.slice(i, i + size);
    if (!chunk.length) continue;
    out.push({
      epoch: chunk[0].epoch,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
    });
  }
  return out;
}

/**
 * Build higher-timeframe candle maps from a single base candle stream.
 * Used by Mars3/Mars4/Mars5 backtesting when no MT5 is available.
 */
function buildHigherTimeframes(candles: Candle[], baseTfSec: number) {
  const tfMap: Record<string, number> = {
    m5: 5,
    m15: 15,
    m30: 30,
    h1: 60,
    h4: 240,
  };
  const result: Record<string, Candle[]> = {};
  for (const [key, mult] of Object.entries(tfMap)) {
    const aggSize = Math.max(1, Math.round((mult * 60) / baseTfSec));
    result[key] = aggregateCandles(candles, aggSize);
  }
  return result as import("@/lib/strategies/mars").MarsHigherTimeframes;
}

export const runMultiBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RunInput.parse(d))
  .handler(async ({ data }) => {
    const { analyzeEnsemble } = await import("../strategies/confluence");
    const { normalizeStrategySelection } = await import("../strategies/catalog");
    const candles = data.candles;
    const selectedStrategies = normalizeStrategySelection(data.selectedStrategies);
    const strategyMode = data.strategyMode ?? "all";
    const trades: SimTrade[] = [];
    const equity: { t: number; equity: number }[] = [{ t: candles[0].epoch, equity: 0 }];
    let equityR = 0;

    // Determine the base timeframe in seconds from candle spacing
    const baseTfSec = candles.length > 1
      ? Math.max(1, candles[candles.length - 1].epoch - candles[candles.length - 2].epoch)
      : 60;

    // Pre-build higher timeframes for Mars3/Mars4/Mars5
    const higherTimeframes = buildHigherTimeframes(candles, baseTfSec);

    // Resolve the analysis function for a given candle window
    const getAnalysis = async (window: Candle[]): Promise<LiveAnalysis> => {
      switch (strategyMode) {
        case "mars1": {
          const { analyzeMars1 } = await import("../strategies/mars");
          return analyzeMars1(window);
        }
        case "mars2": {
          const { analyzeMars2 } = await import("../strategies/mars");
          return analyzeMars2(window, data.symbol);
        }
        case "mars3": {
          const { analyzeMars3 } = await import("../strategies/mars");
          return analyzeMars3(window, {
            symbolHint: data.symbol,
            higherTimeframes,
          });
        }
        case "mars4": {
          const { analyzeMars4 } = await import("../strategies/mars");
          return analyzeMars4(window, {
            symbolHint: data.symbol,
            higherTimeframes,
            nowEpoch: window.at(-1)?.epoch ?? Math.floor(Date.now() / 1000),
            minConfidence: data.minScore / 100,
          });
        }
        case "mars5": {
          const { analyzeMars5 } = await import("../strategies/mars");
          const m5 = analyzeMars5(window, {
            symbolHint: data.symbol,
            nowEpoch: window.at(-1)?.epoch ?? Math.floor(Date.now() / 1000),
          });
          return {
            ...m5,
            regime: m5.detectedRegime === "volatility_expansion" ? "trend_up" :
                    m5.detectedRegime === "strong_bull_trend" ? "trend_up" :
                    m5.detectedRegime === "strong_bear_trend" ? "trend_down" :
                    m5.detectedRegime === "breakout" ? "trend_up" :
                    m5.detectedRegime === "consolidation" ? "compression" : undefined,
          } as LiveAnalysis;
        }
        default:
          return analyzeEnsemble(window, data.minScore, selectedStrategies);
      }
    };

    let activeTrade: null | {
      strategy: string;
      regime: string;
      dir: "BUY" | "SELL";
      entry: number;
      sl: number;
      tp: number;
      score: number;
      entryEpoch: number;
      entryIdx: number;
    } = null;

    for (let i = 200; i < candles.length; i++) {
      const c = candles[i];

      if (activeTrade) {
        const hitTp = activeTrade.dir === "BUY" ? c.high >= activeTrade.tp : c.low <= activeTrade.tp;
        const hitSl = activeTrade.dir === "BUY" ? c.low <= activeTrade.sl : c.high >= activeTrade.sl;
        const expired = i - activeTrade.entryIdx >= data.maxHold;
        if (hitTp || hitSl || expired) {
          const exit = hitTp ? activeTrade.tp : hitSl ? activeTrade.sl : c.close;
          const risk = Math.abs(activeTrade.entry - activeTrade.sl) || 1e-9;
          const rMult = ((exit - activeTrade.entry) * (activeTrade.dir === "BUY" ? 1 : -1)) / risk;
          equityR += rMult * data.riskPerTrade;
          trades.push({
            strategy: activeTrade.strategy,
            regime: activeTrade.regime,
            dir: activeTrade.dir,
            entryEpoch: activeTrade.entryEpoch,
            exitEpoch: c.epoch,
            entry: activeTrade.entry,
            exit,
            sl: activeTrade.sl,
            tp: activeTrade.tp,
            score: activeTrade.score,
            rMultiple: rMult,
            outcome: rMult > 0 ? "win" : rMult < 0 ? "loss" : "expired",
          });
          equity.push({ t: c.epoch, equity: equityR });
          activeTrade = null;
        }
      }

      if (!activeTrade) {
        const win = candles.slice(Math.max(0, i - 199), i + 1);
        const a = await getAnalysis(win);
        if (a.decision !== "WAIT" && a.entry && a.sl && a.tp) {
          activeTrade = {
            strategy: a.strategy ?? strategyMode,
            regime: a.regime ?? "trend_up",
            dir: a.decision === "BUY" ? "BUY" : "SELL",
            entry: c.close,
            sl: a.sl,
            tp: a.tp,
            score: Math.round(a.confidence * 100),
            entryEpoch: c.epoch,
            entryIdx: i,
          };
        }
      }
    }

    // Per-strategy aggregation
    const byStrategy: Record<
      string,
      {
        trades: number;
        wins: number;
        losses: number;
        grossR: number;
        grossLossR: number;
        netR: number;
        avgR: number;
        winRate: number;
        profitFactor: number | null;
      }
    > = {};
    for (const t of trades) {
      const s = (byStrategy[t.strategy] ??= {
        trades: 0,
        wins: 0,
        losses: 0,
        grossR: 0,
        grossLossR: 0,
        netR: 0,
        avgR: 0,
        winRate: 0,
        profitFactor: null,
      });
      s.trades++;
      if (t.rMultiple > 0) {
        s.wins++;
        s.grossR += t.rMultiple;
      } else {
        s.losses++;
        s.grossLossR += Math.abs(t.rMultiple);
      }
      s.netR += t.rMultiple;
    }
    for (const s of Object.values(byStrategy)) {
      s.avgR = s.trades ? s.netR / s.trades : 0;
      s.winRate = s.trades ? s.wins / s.trades : 0;
      s.profitFactor = s.grossLossR > 0 ? s.grossR / s.grossLossR : s.grossR > 0 ? Infinity : null;
    }

    let peak = 0, maxDd = 0;
    for (const p of equity) {
      if (p.equity > peak) peak = p.equity;
      if (peak - p.equity > maxDd) maxDd = peak - p.equity;
    }
    const totalWins = trades.filter((t) => t.rMultiple > 0).length;

    return {
      symbol: data.symbol,
      timeframe: data.timeframe,
      totalTrades: trades.length,
      totalWins,
      totalLosses: trades.length - totalWins,
      winRate: trades.length ? totalWins / trades.length : 0,
      netR: equityR,
      maxDrawdownR: maxDd,
      byStrategy,
      equity,
      trades: trades.slice(-500),
      selectedStrategies,
      strategyMode,
    } as any;
  });
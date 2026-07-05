/**
 * Multi-strategy backtester.
 *
 * Walks candles through analyzeEnsemble bar-by-bar, opens simulated trades
 * when the regime-aware scorer returns BUY/SELL with score ≥ minScore, and
 * settles on SL/TP or a max-hold window. Returns per-strategy performance
 * metrics + an equity curve so the Strategy Lab UI can render them.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

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

export const runMultiBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RunInput.parse(d))
  .handler(async ({ data }) => {
    const { analyzeEnsemble } = await import("../strategies/confluence");
    const { normalizeStrategySelection } = await import("../strategies/catalog");
    const candles = data.candles;
    const selectedStrategies = normalizeStrategySelection(data.selectedStrategies);
    const trades: SimTrade[] = [];
    const equity: { t: number; equity: number }[] = [{ t: candles[0].epoch, equity: 0 }];
    let equityR = 0;

    let open: null | {
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

      // Settle open
      if (open) {
        const hitTp = open.dir === "BUY" ? c.high >= open.tp : c.low <= open.tp;
        const hitSl = open.dir === "BUY" ? c.low <= open.sl : c.high >= open.sl;
        const expired = i - open.entryIdx >= data.maxHold;
        if (hitTp || hitSl || expired) {
          const exit = hitTp ? open.tp : hitSl ? open.sl : c.close;
          const risk = Math.abs(open.entry - open.sl) || 1e-9;
          const rMult = ((exit - open.entry) * (open.dir === "BUY" ? 1 : -1)) / risk;
          equityR += rMult * data.riskPerTrade;
          trades.push({
            strategy: open.strategy,
            regime: open.regime,
            dir: open.dir,
            entryEpoch: open.entryEpoch,
            exitEpoch: c.epoch,
            entry: open.entry,
            exit,
            sl: open.sl,
            tp: open.tp,
            score: open.score,
            rMultiple: rMult,
            outcome: rMult > 0 ? "win" : rMult < 0 ? "loss" : "expired",
          });
          equity.push({ t: c.epoch, equity: equityR });
          open = null;
        }
      }

      // Open new
      if (!open) {
        const window = candles.slice(Math.max(0, i - 199), i + 1);
        const a = analyzeEnsemble(window, data.minScore, selectedStrategies);
        if (a.decision !== "WAIT" && a.entry && a.sl && a.tp) {
          open = {
            strategy: a.strategy ?? "ob-fvg",
            regime: a.regime ?? "trend_up",
            dir: a.decision === "BUY" ? "BUY" : "SELL",
            entry: c.close,
            sl: a.sl,
            tp: a.tp,
            score: a.confluenceScore ?? 0,
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

    // Aggregate + max drawdown (in R)
    let peak = 0,
      maxDd = 0;
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
      trades: trades.slice(-500), // cap for wire
      selectedStrategies,
    };
  });

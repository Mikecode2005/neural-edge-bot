/**
 * MT5 Direct – Server-side API functions
 *
 * These functions are called from the client route and perform MT5 operations
 * through the Mt5Client (which uses node SDK or Python bridge fallback).
 */

import { createServerFn } from "@tanstack/react-start";
import { getMt5Client } from "./client";
import type {
  Mt5Credentials,
  Mt5AccountInfo,
  Mt5Deal,
  Mt5HistoryOrder,
  Mt5PerformanceReport,
  Mt5Position,
  Mt5OrderRequest,
  Mt5OrderResult,
  Mt5SymbolInfo,
  Mt5Tick,
  Mt5Rate,
  Mt5ConnectionStatus,
  Mt5LibraryMode,
} from "./types";

// ── Helpers ──

function getCreds(): Mt5Credentials | null {
  const login = Number(process.env.MT5_ACCOUNT_LOGIN ?? 0);
  const password = process.env.MT5_ACCOUNT_PASSWORD ?? "";
  const server = process.env.MT5_ACCOUNT_SERVER ?? "";
  if (!login || !password || !server) return null;
  return { login, password, server };
}

function client() {
  const mode = (process.env.MT5_LIB_MODE as Mt5LibraryMode) ?? "python-bridge";
  return getMt5Client(mode);
}

// ── Server Functions ──

export const mt5Connect = createServerFn({ method: "POST" }).handler(
  async (): Promise<Mt5ConnectionStatus> => {
    const creds = getCreds();
    if (!creds) {
      return {
        connected: false,
        error: "MT5 credentials not configured in .env (MT5_ACCOUNT_*)",
      };
    }
    try {
      const c = client();
      await c.initialize(creds);
      return c.status();
    } catch (e: any) {
      return { connected: false, error: e?.message ?? "Connection failed" };
    }
  },
);

export const mt5Disconnect = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const c = client();
      await c.shutdown();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message };
    }
  },
);

export const mt5AccountInfo = createServerFn({ method: "GET" }).handler(
  async (): Promise<Mt5AccountInfo | { error: string }> => {
    try {
      const c = client();
      return await c.accountInfo();
    } catch (e: any) {
      return { error: e?.message ?? "Failed to get account info" };
    }
  },
);

export const mt5GetPositions = createServerFn({ method: "GET" }).handler(
  async (): Promise<Mt5Position[] | { error: string }> => {
    try {
      const c = client();
      return await c.positions();
    } catch (e: any) {
      return { error: e?.message ?? "Failed to get positions" };
    }
  },
);

export const mt5PlaceOrder = createServerFn({ method: "POST" })
  .validator((data: Mt5OrderRequest) => data)
  .handler(async ({ data }): Promise<Mt5OrderResult | { error: string }> => {
    try {
      const c = client();
      return await c.orderSend(data);
    } catch (e: any) {
      return { error: e?.message ?? "Order failed" };
    }
  });

export const mt5ClosePosition = createServerFn({ method: "POST" })
  .validator((data: { ticket: number }) => data)
  .handler(async ({ data }): Promise<Mt5OrderResult | { error: string }> => {
    try {
      const c = client();
      return await c.positionsClose(data.ticket);
    } catch (e: any) {
      return { error: e?.message ?? "Close failed" };
    }
  });

export const mt5GetRates = createServerFn({ method: "POST" })
  .validator(
    (data: {
      symbol: string;
      timeframe: "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
      count: number;
    }) => data,
  )
  .handler(async ({ data }): Promise<Mt5Rate[] | { error: string }> => {
    try {
      const c = client();
      return await c.rates(data.symbol, data.timeframe, data.count);
    } catch (e: any) {
      return { error: e?.message ?? "Failed to get rates" };
    }
  });

export const mt5Status = createServerFn({ method: "GET" }).handler(
  async (): Promise<Mt5ConnectionStatus> => {
    try {
      const c = client();
      return await c.status();
    } catch (e: any) {
      return { connected: false, error: e?.message ?? "Status check failed" };
    }
  },
);

export const mt5GetSymbolInfo = createServerFn({ method: "POST" })
  .validator((data: { symbol: string }) => data)
  .handler(async ({ data }): Promise<Mt5SymbolInfo | { error: string }> => {
    try {
      const c = client();
      return await c.symbolInfo(data.symbol);
    } catch (e: any) {
      return { error: e?.message ?? "Symbol info failed" };
    }
  });

function netProfit(deal: Mt5Deal) {
  return Number(deal.profit ?? 0) + Number(deal.commission ?? 0) + Number(deal.swap ?? 0);
}

function positionIdOf(deal: Mt5Deal) {
  return Number(deal.positionId || deal.order || deal.ticket || 0);
}

function orderPositionId(order: Mt5HistoryOrder) {
  return Number(order.positionId || order.ticket || 0);
}

function inferExitReason(args: {
  exitPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  type: "BUY" | "SELL";
  profit: number;
}) {
  const tolerance = Math.max(Math.abs(args.exitPrice) * 0.00005, 0.00001);
  if (args.takeProfit != null && Math.abs(args.exitPrice - args.takeProfit) <= tolerance) {
    return "Take Profit";
  }
  if (args.stopLoss != null && Math.abs(args.exitPrice - args.stopLoss) <= tolerance) {
    return "Stop Loss";
  }
  if (args.profit > 0) return "Manual/Broker close in profit";
  if (args.profit < 0) return "Manual/Broker close in loss";
  return "Breakeven/Unknown";
}

function diagnoseTrade(args: {
  profit: number;
  riskRewardRatio: number | null;
  actualRisk: number | null;
  actualReward: number | null;
  exitReason: string;
  durationSeconds: number;
  mfe: number | null;
  mae: number | null;
}) {
  const notes: string[] = [];
  if (args.profit >= 0) {
    notes.push("Winner: broker-reported net profit is positive.");
    return notes;
  }
  if (args.riskRewardRatio != null && args.riskRewardRatio < 1.2) {
    notes.push("Poor RR: reward was too small compared with stop distance.");
  }
  if (args.exitReason === "Stop Loss") notes.push("Loss caused by stop-loss execution.");
  if (args.durationSeconds < 120)
    notes.push("Entry timing/execution delay likely: trade failed quickly.");
  if (args.mfe != null && args.actualReward != null && args.mfe < args.actualReward * 0.35) {
    notes.push("Weak follow-through: price never moved meaningfully toward TP.");
  }
  if (args.mae != null && args.actualRisk != null && args.mae > args.actualRisk * 0.8) {
    notes.push("Adverse excursion was near full stop: market noise or wrong structure.");
  }
  if (!notes.length) notes.push("Likely strategy logic/trend reversal; review signal context.");
  return notes;
}

export const mt5PerformanceReport = createServerFn({ method: "GET" }).handler(
  async (): Promise<Mt5PerformanceReport | { error: string }> => {
    try {
      const c = client();
      const now = Math.floor(Date.now() / 1000);
      const from = now - 86400 * 7;
      const [account, openPositions, deals, orders] = await Promise.all([
        c.accountInfo(),
        c.positions(),
        c.history(from, now),
        c.historyOrders(from, now),
      ]);

      const groups = new Map<number, Mt5Deal[]>();
      for (const deal of deals) {
        if (!deal.symbol || Number(deal.volume ?? 0) <= 0) continue;
        const id = positionIdOf(deal);
        if (!id) continue;
        const list = groups.get(id) ?? [];
        list.push(deal);
        groups.set(id, list);
      }

      const trades = Array.from(groups.entries())
        .map(([positionId, ds]) => {
          const sorted = [...ds].sort((a, b) => Number(a.time) - Number(b.time));
          const entry = sorted[0];
          const exits = sorted
            .slice(1)
            .filter((d) => netProfit(d) !== 0 || Number(d.entry ?? 0) !== 0);
          const exit = exits.at(-1) ?? sorted.at(-1);
          if (!entry || !exit || entry.ticket === exit.ticket) return null;

          const order = orders
            .filter((o) => orderPositionId(o) === positionId)
            .sort((a, b) => Number(a.timeSetup ?? 0) - Number(b.timeSetup ?? 0))[0];
          const type: "BUY" | "SELL" = Number(entry.type) === 1 ? "SELL" : "BUY";
          const entryPrice = Number(entry.price ?? order?.priceOpen ?? 0);
          const exitPrice = Number(exit.price ?? 0);
          const stopLoss = order?.sl ? Number(order.sl) : null;
          const takeProfit = order?.tp ? Number(order.tp) : null;
          const actualRisk = stopLoss == null ? null : Math.abs(entryPrice - stopLoss);
          const actualReward = takeProfit == null ? null : Math.abs(takeProfit - entryPrice);
          const riskRewardRatio =
            actualRisk && actualReward != null && actualRisk > 0
              ? Number((actualReward / actualRisk).toFixed(2))
              : null;
          const profit = Number(sorted.reduce((sum, d) => sum + netProfit(d), 0).toFixed(2));
          const durationSeconds = Math.max(0, Number(exit.time ?? 0) - Number(entry.time ?? 0));
          const exitReason = inferExitReason({ exitPrice, stopLoss, takeProfit, type, profit });
          const favorableMove = type === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;
          const adverseMove = type === "BUY" ? entryPrice - exitPrice : exitPrice - entryPrice;
          const mfe = Number(Math.max(0, favorableMove).toFixed(5));
          const mae = Number(Math.max(0, adverseMove).toFixed(5));
          return {
            positionId,
            symbol: entry.symbol,
            type,
            volume: Number(entry.volume ?? 0),
            entryPrice,
            exitPrice,
            stopLoss,
            takeProfit,
            actualRisk,
            actualReward,
            riskRewardRatio,
            mfe,
            mae,
            durationSeconds,
            exitReason,
            profit,
            diagnosis: diagnoseTrade({
              profit,
              riskRewardRatio,
              actualRisk,
              actualReward,
              exitReason,
              durationSeconds,
              mfe,
              mae,
            }),
          };
        })
        .filter((t): t is NonNullable<typeof t> => Boolean(t));

      const wins = trades.filter((t) => t.profit > 0);
      const losses = trades.filter((t) => t.profit < 0);
      const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
      let peak = 0;
      let curve = 0;
      let drawdown = 0;
      for (const trade of trades) {
        curve += trade.profit;
        peak = Math.max(peak, curve);
        drawdown = Math.max(drawdown, peak - curve);
      }

      return {
        source: "mt5",
        account,
        openPositions,
        trades,
        totalTrades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
        netProfit: Number(trades.reduce((s, t) => s + t.profit, 0).toFixed(2)),
        profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : null,
        averageWin: wins.length ? Number((grossProfit / wins.length).toFixed(2)) : 0,
        averageLoss: losses.length ? Number((-grossLoss / losses.length).toFixed(2)) : 0,
        expectancy: trades.length
          ? Number((trades.reduce((s, t) => s + t.profit, 0) / trades.length).toFixed(2))
          : 0,
        drawdown: Number(drawdown.toFixed(2)),
        averageHoldingSeconds: trades.length
          ? Math.round(trades.reduce((s, t) => s + t.durationSeconds, 0) / trades.length)
          : 0,
        largestWin: wins.length ? Math.max(...wins.map((t) => t.profit)) : 0,
        largestLoss: losses.length ? Math.min(...losses.map((t) => t.profit)) : 0,
      };
    } catch (e: any) {
      return { error: e?.message ?? "Failed to build MT5 report" };
    }
  },
);

// Helper to call the Python bridge directly from server-side functions
function bridgeFetch<T>(endpoint: string, body?: unknown): Promise<T> {
  const url =
    (process.env.MT5_BRIDGE_URL as string | undefined) ??
    (import.meta.env as Record<string, string>).VITE_MT5_BRIDGE_URL ??
    "http://localhost:8765";
  return fetch(`${url}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    if (!r.ok) throw new Error(`Bridge error ${r.status} - ${await r.text()}`);
    return r.json();
  });
}

export const botStart = createServerFn({ method: "POST" }).handler(
  async ({ data }: any): Promise<{ ok: boolean; bot?: any; error?: string }> => {
    try {
      const res = await bridgeFetch<any>("/bot/start", data);
      return res;
    } catch (e: any) {
      return { ok: false, error: e?.message };
    }
  },
);

export const botStop = createServerFn({ method: "POST" }).handler(
  async ({ data }: any): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await bridgeFetch<any>("/bot/stop", data);
      return res;
    } catch (e: any) {
      return { ok: false, error: e?.message };
    }
  },
);

export const botList = createServerFn({ method: "GET" }).handler(async (): Promise<any[]> => {
  try {
    return await bridgeFetch<any[]>("/bot/list");
  } catch (e: any) {
    return [];
  }
});

export const botActivity = createServerFn({ method: "GET" }).handler(
  async ({ data }: any): Promise<any[]> => {
    try {
      const id = data?.id;
      return await bridgeFetch<any[]>(`/bot/activity?bot_id=${encodeURIComponent(id)}`);
    } catch (e: any) {
      return [];
    }
  },
);

export const botOpenPositions = createServerFn({ method: "GET" }).handler(
  async ({ data }: any): Promise<any[]> => {
    try {
      const id = data?.id;
      return await bridgeFetch<any[]>(`/bot/open-positions?bot_id=${encodeURIComponent(id)}`);
    } catch (e: any) {
      return [];
    }
  },
);

export const tunnelRegister = createServerFn({ method: "POST" }).handler(
  async ({ data }: any): Promise<any> => {
    try {
      return await bridgeFetch("/tunnel/register", data);
    } catch (e: any) {
      return { ok: false, error: e?.message };
    }
  },
);

export const tunnelInfo = createServerFn({ method: "GET" }).handler(async (): Promise<any> => {
  try {
    return await bridgeFetch("/tunnel/info");
  } catch (e: any) {
    return { url: null };
  }
});

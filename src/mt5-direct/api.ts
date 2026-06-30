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
  const mode = (process.env.MT5_LIB_MODE as Mt5LibraryMode) ?? "node-sdk";
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
  .handler(
    async ({ data }): Promise<Mt5OrderResult | { error: string }> => {
      try {
        const c = client();
        return await c.positionsClose(data.ticket);
      } catch (e: any) {
        return { error: e?.message ?? "Close failed" };
      }
    },
  );

export const mt5GetRates = createServerFn({ method: "POST" })
  .validator(
    (data: {
      symbol: string;
      timeframe: "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
      count: number;
    }) => data,
  )
  .handler(
    async ({ data }): Promise<Mt5Rate[] | { error: string }> => {
      try {
        const c = client();
        return await c.rates(data.symbol, data.timeframe, data.count);
      } catch (e: any) {
        return { error: e?.message ?? "Failed to get rates" };
      }
    },
  );

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
  .handler(
    async ({ data }): Promise<Mt5SymbolInfo | { error: string }> => {
      try {
        const c = client();
        return await c.symbolInfo(data.symbol);
      } catch (e: any) {
        return { error: e?.message ?? "Symbol info failed" };
      }
    },
  );
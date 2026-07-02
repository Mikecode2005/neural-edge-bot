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

// Helper to call the Python bridge directly from server-side functions
function bridgeFetch<T>(endpoint: string, body?: unknown): Promise<T> {
  const url = (process.env.MT5_BRIDGE_URL as string | undefined) ?? (import.meta.env as Record<string, string>).VITE_MT5_BRIDGE_URL ?? "http://localhost:8765";
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
      const res = await bridgeFetch<any>('/bot/start', data);
      return res;
    } catch (e: any) {
      return { ok: false, error: e?.message };
    }
  },
);

export const botStop = createServerFn({ method: "POST" }).handler(
  async ({ data }: any): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await bridgeFetch<any>('/bot/stop', data);
      return res;
    } catch (e: any) {
      return { ok: false, error: e?.message };
    }
  },
);

export const botList = createServerFn({ method: "GET" }).handler(async (): Promise<any[]> => {
  try {
    return await bridgeFetch<any[]>('/bot/list');
  } catch (e: any) {
    return [];
  }
});

export const botActivity = createServerFn({ method: "GET" }).handler(async ({ data }: any): Promise<any[]> => {
  try {
    const id = data?.id;
    return await bridgeFetch<any[]>(`/bot/activity?bot_id=${encodeURIComponent(id)}`);
  } catch (e: any) {
    return [];
  }
});

export const botOpenPositions = createServerFn({ method: "GET" }).handler(async ({ data }: any): Promise<any[]> => {
  try {
    const id = data?.id;
    return await bridgeFetch<any[]>(`/bot/open-positions?bot_id=${encodeURIComponent(id)}`);
  } catch (e: any) {
    return [];
  }
});

export const tunnelRegister = createServerFn({ method: "POST" }).handler(async ({ data }: any): Promise<any> => {
  try {
    return await bridgeFetch('/tunnel/register', data);
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
});

export const tunnelInfo = createServerFn({ method: "GET" }).handler(async (): Promise<any> => {
  try {
    return await bridgeFetch('/tunnel/info');
  } catch (e: any) {
    return { url: null };
  }
});
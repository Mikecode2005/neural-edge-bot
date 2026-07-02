/**
 * MT5 Direct Client
 *
 * Integration strategy:
 * The native MT5 connectivity is provided by a Python FastAPI bridge service
 * that wraps the official `MetaTrader5` Python package. This Python package
 * requires the MT5 desktop terminal installed on Windows.
 *
 * Why not the npm `metatrader5-sdk` package?
 * The npm package "metatrader5-sdk" (v0.1.4, by altug0) is actually a MetaTrader 5
 * Manager Web API client for broker-level user management — it does NOT provide
 * trading operations like initialize(), login(), accountInfo(), positionsGet(),
 * orderSend(), or copyRatesFrom(). The type declarations in this project previously
 * described a fictional API that doesn't exist on that package.
 *
 * Usage:
 * 1. Install MetaTrader5 Python package: pip install MetaTrader5
 * 2. Start the bridge: python -m routes.mt5_bridge.server
 * 3. Set MT5_LIB_MODE=python-bridge in .env (or keep as default)
 *
 * For cloud deployment (Render, etc.): Host this bridge service on Render
 * and set VITE_MT5_BRIDGE_URL to the public endpoint.
 */

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

// Read env vars — Vite exposes VITE_* vars via import.meta.env,
// and the server-side api.ts reads process.env directly.
const VITE_MT5_BRIDGE_URL =
  (process.env.MT5_BRIDGE_URL as string | undefined) ??
  (import.meta.env as Record<string, string>).VITE_MT5_BRIDGE_URL ??
  "http://localhost:8765";
const VITE_MT5_LIB_MODE =
  ((process.env.MT5_LIB_MODE as Mt5LibraryMode) ??
  (import.meta.env as Record<string, string>).VITE_MT5_LIB_MODE ??
  "python-bridge") as Mt5LibraryMode;

// ── Python Bridge helpers ──

async function bridgeFetch<T>(
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${VITE_MT5_BRIDGE_URL}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MT5 bridge error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Public API ──

export class Mt5Client {
  private creds: Mt5Credentials | null = null;
  private mode: Mt5LibraryMode;
  private _connected = false;

  constructor(mode?: Mt5LibraryMode) {
    this.mode = mode ?? VITE_MT5_LIB_MODE;
  }

  get connected(): boolean {
    return this._connected;
  }

  get libraryMode(): Mt5LibraryMode {
    return this.mode;
  }

  async initialize(creds?: Mt5Credentials): Promise<void> {
    this.creds = creds ?? null;

    const res = await bridgeFetch<{ status: string; login?: number; server?: string }>("/initialize", creds);
    if (res.status !== "ok") throw new Error("Bridge init failed");
    this._connected = true;
  }

  async shutdown(): Promise<void> {
    await bridgeFetch("/shutdown");
    this._connected = false;
  }

  async accountInfo(): Promise<Mt5AccountInfo> {
    return bridgeFetch<Mt5AccountInfo>("/account-info");
  }

  async positions(): Promise<Mt5Position[]> {
    return bridgeFetch<Mt5Position[]>("/positions");
  }

  async orderSend(req: Mt5OrderRequest): Promise<Mt5OrderResult> {
    return bridgeFetch<Mt5OrderResult>("/order-send", req);
  }

  async positionsClose(ticket: number): Promise<Mt5OrderResult> {
    return bridgeFetch<Mt5OrderResult>("/positions-close", { ticket });
  }

  async symbolInfo(symbol: string): Promise<Mt5SymbolInfo> {
    return bridgeFetch<Mt5SymbolInfo>("/symbol-info", { symbol });
  }

  async symbolInfoTick(symbol: string): Promise<Mt5Tick> {
    return bridgeFetch<Mt5Tick>("/symbol-tick", { symbol });
  }

  async rates(
    symbol: string,
    timeframe: "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d",
    count: number,
  ): Promise<Mt5Rate[]> {
    return bridgeFetch<Mt5Rate[]>("/rates", { symbol, timeframe, count });
  }

  async status(): Promise<Mt5ConnectionStatus> {
    try {
      const info = await this.accountInfo();
      return { connected: true, account: info };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return { connected: false, error: msg };
    }
  }
}

/** Singleton instance lazily created on first access */
let defaultClient: Mt5Client | null = null;

export function getMt5Client(mode?: Mt5LibraryMode): Mt5Client {
  if (!defaultClient) {
    defaultClient = new Mt5Client(mode);
  }
  return defaultClient;
}
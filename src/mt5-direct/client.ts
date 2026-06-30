/**
 * MT5 Direct Client
 *
 * Library choice: metatrader5-sdk (npm package) is used as the primary MT5
 * integration library because it wraps the MetaTrader 5 Web API in a clean
 * Node.js interface without requiring the MT5 desktop terminal to be installed.
 *
 * Fallback strategy:
 * If the SDK fails to load (e.g., DLL not available on non-Windows or missing
 * MT5 terminal), the system falls back to a Python FastAPI bridge service.
 * The Python bridge uses the native `MetaTrader5` Python package which requires
 * the MT5 terminal installed on Windows. Set MT5_LIB_MODE=python-bridge in .env
 * and ensure the FastAPI bridge is running at MT5_BRIDGE_URL (default http://localhost:8765).
 */

import { MetaTrader5 } from "metatrader5-sdk";
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

const MT5_BRIDGE_URL =
  import.meta.env.VITE_MT5_BRIDGE_URL ?? "http://localhost:8765";
const MT5_LIB_MODE: Mt5LibraryMode =
  (import.meta.env.VITE_MT5_LIB_MODE as Mt5LibraryMode) ?? "node-sdk";

let sdkInstance: MetaTrader5 | null = null;

// ── Node SDK helpers ──

function getSdk(): MetaTrader5 {
  if (!sdkInstance) {
    sdkInstance = new MetaTrader5();
  }
  return sdkInstance;
}

// ── Python Bridge helpers ──

async function bridgeFetch<T>(
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${MT5_BRIDGE_URL}${endpoint}`, {
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
    this.mode = mode ?? MT5_LIB_MODE;
  }

  get connected(): boolean {
    return this._connected;
  }

  get libraryMode(): Mt5LibraryMode {
    return this.mode;
  }

  async initialize(creds?: Mt5Credentials): Promise<void> {
    this.creds = creds ?? null;

    if (this.mode === "python-bridge") {
      const res = await bridgeFetch<{ status: string }>("/initialize", creds);
      if (res.status !== "ok") throw new Error("Bridge init failed");
      this._connected = true;
      return;
    }

    // Node SDK mode
    try {
      const sdk = getSdk();
      await sdk.initialize();
      if (creds) {
        const authed = await sdk.login(
          creds.login,
          creds.password,
          creds.server,
        );
        if (!authed) throw new Error("MT5 login failed");
      }
      this._connected = true;
    } catch (e) {
      this._connected = false;
      throw e;
    }
  }

  async shutdown(): Promise<void> {
    if (this.mode === "python-bridge") {
      await bridgeFetch("/shutdown");
    } else {
      const sdk = getSdk();
      await sdk.shutdown();
    }
    this._connected = false;
  }

  async accountInfo(): Promise<Mt5AccountInfo> {
    if (this.mode === "python-bridge") {
      return bridgeFetch<Mt5AccountInfo>("/account-info");
    }
    const sdk = getSdk();
    const info = await sdk.accountInfo();
    return info as unknown as Mt5AccountInfo;
  }

  async positions(): Promise<Mt5Position[]> {
    if (this.mode === "python-bridge") {
      return bridgeFetch<Mt5Position[]>("/positions");
    }
    const sdk = getSdk();
    const pos = await sdk.positionsGet();
    return (pos ?? []) as unknown as Mt5Position[];
  }

  async orderSend(req: Mt5OrderRequest): Promise<Mt5OrderResult> {
    if (this.mode === "python-bridge") {
      return bridgeFetch<Mt5OrderResult>("/order-send", req);
    }
    const sdk = getSdk();
    const result = await sdk.orderSend({
      symbol: req.symbol,
      type:
        req.type === "buy"
          ? 0 // ORDER_TYPE_BUY
          : 1, // ORDER_TYPE_SELL
      volume: req.volume,
      price: req.price ?? 0,
      sl: req.sl ?? 0,
      tp: req.tp ?? 0,
      comment: req.comment ?? "",
      magic: req.magic ?? 0,
      deviation: req.deviation ?? 20,
      type_filling:
        req.typeFilling === "fok"
          ? 0
          : req.typeFilling === "ioc"
            ? 1
            : 2,
    });
    return result as unknown as Mt5OrderResult;
  }

  async positionsClose(ticket: number): Promise<Mt5OrderResult> {
    if (this.mode === "python-bridge") {
      return bridgeFetch<Mt5OrderResult>("/positions-close", { ticket });
    }
    const sdk = getSdk();
    const result = await sdk.positionClose(ticket);
    return result as unknown as Mt5OrderResult;
  }

  async symbolInfo(symbol: string): Promise<Mt5SymbolInfo> {
    if (this.mode === "python-bridge") {
      return bridgeFetch<Mt5SymbolInfo>("/symbol-info", { symbol });
    }
    const sdk = getSdk();
    const info = await sdk.symbolInfo(symbol);
    return info as unknown as Mt5SymbolInfo;
  }

  async symbolInfoTick(symbol: string): Promise<Mt5Tick> {
    if (this.mode === "python-bridge") {
      return bridgeFetch<Mt5Tick>("/symbol-tick", { symbol });
    }
    const sdk = getSdk();
    const tick = await sdk.symbolInfoTick(symbol);
    return tick as unknown as Mt5Tick;
  }

  async rates(
    symbol: string,
    timeframe: "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d",
    count: number,
  ): Promise<Mt5Rate[]> {
    const tfMap: Record<string, number> = {
      "1m": 1,
      "5m": 5,
      "15m": 15,
      "30m": 30,
      "1h": 60,
      "4h": 240,
      "1d": 1440,
    };
    if (this.mode === "python-bridge") {
      return bridgeFetch<Mt5Rate[]>("/rates", { symbol, timeframe, count });
    }
    const sdk = getSdk();
    const rates = await sdk.copyRatesFrom(symbol, tfMap[timeframe] ?? 1, 0, count);
    return (rates ?? []) as unknown as Mt5Rate[];
  }

  async status(): Promise<Mt5ConnectionStatus> {
    try {
      const info = await this.accountInfo();
      return { connected: true, account: info };
    } catch (e: any) {
      return { connected: false, error: e?.message ?? "Unknown error" };
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
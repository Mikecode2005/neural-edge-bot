/**
 * Browser-side Deriv WebSocket client.
 * Uses the public app_id=1089 for tick / candle streaming. NO trading token.
 * All live trading goes through the HF backend.
 */

export interface Tick {
  symbol: string;
  quote: number;
  epoch: number;
}

export interface Candle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

type TickHandler = (t: Tick) => void;

const DERIV_APP_ID = "1089";
const DERIV_WS = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;

export class DerivWS {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<TickHandler>>();
  private subscriptions = new Set<string>();
  private pending: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(DERIV_WS);
    this.ws.onopen = () => {
      this.subscriptions.forEach((s) => this.send({ ticks: s, subscribe: 1 }));
      this.pending.forEach((p) => this.ws?.send(p));
      this.pending = [];
    };
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.msg_type === "tick" && msg.tick) {
          const t: Tick = {
            symbol: msg.tick.symbol,
            quote: Number(msg.tick.quote),
            epoch: Number(msg.tick.epoch),
          };
          this.handlers.get(t.symbol)?.forEach((h) => h(t));
        }
      } catch {
        /* ignore */
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 1500);
    };
    this.ws.onerror = () => this.ws?.close();
  }

  private send(payload: unknown) {
    const data = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.pending.push(data);
      this.connect();
    }
  }

  subscribeTicks(symbol: string, handler: TickHandler): () => void {
    let set = this.handlers.get(symbol);
    if (!set) {
      set = new Set();
      this.handlers.set(symbol, set);
    }
    set.add(handler);
    if (!this.subscriptions.has(symbol)) {
      this.subscriptions.add(symbol);
      this.send({ ticks: symbol, subscribe: 1 });
    }
    return () => {
      set?.delete(handler);
      if (set && set.size === 0) {
        this.handlers.delete(symbol);
        this.subscriptions.delete(symbol);
        this.send({ forget_all: "ticks" });
        this.subscriptions.forEach((s) => this.send({ ticks: s, subscribe: 1 }));
      }
    };
  }

  async fetchCandles(symbol: string, granularity = 60, count = 200): Promise<Candle[]> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(DERIV_WS);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Deriv candles timeout"));
      }, 8000);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            ticks_history: symbol,
            adjust_start_time: 1,
            count,
            end: "latest",
            granularity,
            style: "candles",
          }),
        );
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.error) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(m.error.message));
          return;
        }
        if (m.candles) {
          clearTimeout(timer);
          ws.close();
          resolve(
            m.candles.map((c: Record<string, unknown>) => ({
              epoch: Number(c.epoch),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
            })),
          );
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Deriv WS error"));
      };
    });
  }
}

let _client: DerivWS | null = null;
export function getDeriv(): DerivWS {
  if (!_client) _client = new DerivWS();
  _client.connect();
  return _client;
}

export const DERIV_SYMBOLS = [
  { code: "R_10", label: "Volatility 10 Index" },
  { code: "1HZ10V", label: "Volatility 10 (1s)" },
  { code: "R_15", label: "Volatility 15 Index" },
  { code: "1HZ15V", label: "Volatility 15 (1s)" },
  { code: "R_25", label: "Volatility 25 Index" },
  { code: "1HZ25V", label: "Volatility 25 (1s)" },
] as const;

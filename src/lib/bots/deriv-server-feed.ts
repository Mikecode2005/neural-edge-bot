import { WebSocket } from "ws";
import type { Candle } from "@/lib/deriv-ws";

function appId() {
  return process.env.DERIV_APP_ID || process.env.VITE_DERIV_APP_ID || "1089";
}

export async function fetchDerivCandlesServer(symbol: string, granularity: number, count = 220): Promise<Candle[]> {
  const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId()}`);

  return new Promise<Candle[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error("Deriv request timeout"));
    }, 10_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        ticks_history: symbol,
        adjust_start_time: 1,
        count,
        end: "latest",
        granularity,
        style: "candles",
      }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.error) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(msg.error.message || "Deriv error"));
          return;
        }
        if (msg.candles) {
          clearTimeout(timer);
          ws.close();
          resolve((msg.candles as Array<Record<string, unknown>>).map((c) => ({
            epoch: Number(c.epoch),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
          })));
          return;
        }
      } catch (error) {
        clearTimeout(timer);
        ws.close();
        reject(error);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

import type { Candle } from "@/lib/deriv-ws";

export function requireLiveCandles(candles: Candle[] | null | undefined, minimum = 61): Candle[] {
  if (!Array.isArray(candles) || candles.length < minimum) {
    throw new Error("Live candle feed unavailable");
  }

  return candles.slice(-minimum);
}

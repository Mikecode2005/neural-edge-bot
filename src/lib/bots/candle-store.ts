/**
 * Server-side in-memory candle store.
 * The dashboard (browser) pushes real Deriv candle data here via a server function.
 * The bot loop reads from this store instead of connecting to Deriv WebSocket.
 */
import type { Candle } from "@/lib/deriv-ws";

// Map<symbol, Map<timeframe, Candle[]>>
const store = new Map<string, Map<string, Candle[]>>();

export function setCandles(symbol: string, timeframe: string, candles: Candle[]): void {
  let byTimeframe = store.get(symbol);
  if (!byTimeframe) {
    byTimeframe = new Map();
    store.set(symbol, byTimeframe);
  }
  byTimeframe.set(timeframe, candles);
}

export function getCandles(symbol: string, timeframe: string, minCount = 61): Candle[] {
  const byTimeframe = store.get(symbol);
  if (!byTimeframe) return [];
  const candles = byTimeframe.get(timeframe);
  if (!candles || candles.length < minCount) return [];
  return candles;
}

export function hasCandles(symbol: string, timeframe: string, minCount = 61): boolean {
  return getCandles(symbol, timeframe, minCount).length >= minCount;
}
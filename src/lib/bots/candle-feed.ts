import type { Candle } from "@/lib/deriv-ws";

export function buildFallbackCandles(startPrice: number, count = 220): Candle[] {
  const candles: Candle[] = [];
  let prevClose = Number.isFinite(startPrice) ? startPrice : 100;

  for (let i = 0; i < count; i += 1) {
    const drift = (i % 7) - 3;
    const open = prevClose;
    const close = Math.max(1, open + drift * 0.15);
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;

    candles.push({
      epoch: Date.now() - (count - i) * 60_000,
      open,
      high,
      low,
      close,
    });

    prevClose = close;
  }

  return candles;
}

export async function getCandlesWithFallback(
  liveFetcher: () => Promise<Candle[]>,
  startPrice: number,
  count = 220,
): Promise<Candle[]> {
  try {
    const candles = await liveFetcher();
    if (Array.isArray(candles) && candles.length >= 2) return candles;
  } catch {
    // fall back to synthetic candles for paper-trading when the live feed is unavailable
  }

  return buildFallbackCandles(startPrice, count);
}

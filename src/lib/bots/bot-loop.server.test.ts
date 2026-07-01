import { describe, expect, it } from "vitest";
import { buildFallbackCandles, getCandlesWithFallback } from "./candle-feed";

describe("buildFallbackCandles", () => {
  it("creates a candle series from a starting price", () => {
    const candles = buildFallbackCandles(100, 5);

    expect(candles).toHaveLength(5);
    expect(candles[0].open).toBeCloseTo(100, 5);
    expect(candles[0].close).toBeGreaterThan(0);
    expect(candles[4].close).toBeGreaterThan(0);
  });
});

describe("getCandlesWithFallback", () => {
  it("returns synthetic candles when the live feed fails", async () => {
    const candles = await getCandlesWithFallback(async () => {
      throw new Error("Deriv WebSocket error");
    }, 123.45, 5);

    expect(candles).toHaveLength(5);
    expect(candles[0].open).toBeCloseTo(123.45, 5);
    expect(candles[0].close).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { requireLiveCandles } from "./candle-feed";

describe("requireLiveCandles", () => {
  it("returns the provided live candles", () => {
    const candles = Array.from({ length: 61 }, (_, index) => ({
      epoch: index,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
    }));

    expect(requireLiveCandles(candles, 61)).toHaveLength(61);
    expect(requireLiveCandles(candles, 61)[0].open).toBe(100);
  });

  it("throws when the live feed does not provide enough candles", () => {
    expect(() =>
      requireLiveCandles([{ epoch: 1, open: 100, high: 101, low: 99, close: 100 }], 61),
    ).toThrow("Live candle feed unavailable");
  });
});

import type { StrategyKind } from "@/lib/ob-fvg";

export const STRATEGY_CATALOG: { id: StrategyKind; label: string; description: string }[] = [
  { id: "msnr-crt", label: "MSNR + CRT", description: "Session narrative/range reaction candles" },
  { id: "apa", label: "APA", description: "Analysis → POI → Action at key zones" },
  { id: "liquidity-sweep", label: "Liquidity Sweep", description: "Sweep/reclaim reversal setups" },
  { id: "ob-fvg", label: "OB + FVG", description: "Order block + fair value gap confluence" },
  {
    id: "vol-expansion",
    label: "Vol Expansion",
    description: "Compression into volatility expansion",
  },
  { id: "wyckoff", label: "Wyckoff", description: "Spring / UTAD range phase setups" },
  { id: "momentum", label: "Momentum", description: "EMA pullback + displacement continuation" },
  {
    id: "mean-reversion",
    label: "Mean Reversion",
    description: "Bollinger bands + RSI mean-reversion",
  },
  { id: "ote", label: "ICT OTE", description: "0.62–0.79 retracement entries" },
  { id: "fractal", label: "Fractal BOS/CHOCH", description: "Fractal structure break entries" },
  {
    id: "dynamic-sr",
    label: "Dynamic S/R",
    description: "Nearest swing support/resistance target logic",
  },
  { id: "bb-rsi", label: "BB + RSI", description: "Bollinger band + RSI mean reversion" },
  {
    id: "titan1",
    label: "TITAN1",
    description: "Elite high-confluence: MSNR+CRT + APA + Liquidity Sweep + OB/FVG + strict regime",
  },
  {
    id: "titan2",
    label: "TITAN2",
    description: "Adaptive momentum: 3-TF alignment, volatility-adjusted sizing, dynamic entries",
  },
  {
    id: "mars1",
    label: "Mars1",
    description:
      "Classic 3-detector multi-strategy: OB+FVG, Momentum, Mean-Reversion (best signal)",
  },
  {
    id: "mars2",
    label: "Mars2",
    description:
      "Mars1 refined for Volatility 25 (1s) & Volatility 15 (1s) — tighter SL/TP, momentum-weighted",
  },
  {
    id: "mars3",
    label: "Mars3",
    description:
      "Mars1 optimised: pullback-confirmed entries, 1.8×ATR SL / 2.5RR, balance-aware volume rescaling",
  },
  {
    id: "mars4",
    label: "Mars4",
    description:
      "Symbol-aware adaptive strategy: per-pair volatility profiles, 5-gate filter (RSI/BOS/pullback/spread/RR), session timing tiers (PRIME/GOOD/OFF_PEAK), and profile-calibrated SL/TP from Bayesian optimizer results",
  },
];

/** Strategy combinations for multi-strategy setups */
export type StrategyCombination = "single" | "dual-combo";

/**
 * Get all valid strategy IDs for use in selection UI
 */
export const ALL_STRATEGY_IDS = STRATEGY_CATALOG.map((s) => s.id);

/**
 * Default strategy selection - use all strategies for full ensemble
 */
export const DEFAULT_STRATEGY_SELECTION = ALL_STRATEGY_IDS;

/**
 * Normalize strategy selection input, filtering out invalid entries.
 * Returns valid strategies or default selection if empty.
 */
export function normalizeStrategySelection(input?: string[] | null): StrategyKind[] {
  const valid = new Set(ALL_STRATEGY_IDS);
  const selected = (input ?? []).filter((s): s is StrategyKind => valid.has(s as StrategyKind));
  return selected.length ? selected : DEFAULT_STRATEGY_SELECTION;
}

/**
 * Check if a strategy combination is valid (up to 3 strategies can be combined).
 */
export function validateStrategyCombination(strategies: StrategyKind[]): {
  valid: boolean;
  error?: string;
} {
  if (strategies.length === 0) {
    return { valid: false, error: "At least one strategy must be selected" };
  }
  if (strategies.length > 3) {
    return { valid: false, error: "Maximum 3 strategies can be combined at once" };
  }
  const valid = new Set(ALL_STRATEGY_IDS);
  const invalid = strategies.filter((s) => !valid.has(s));
  if (invalid.length > 0) {
    return { valid: false, error: `Invalid strategies: ${invalid.join(", ")}` };
  }
  return { valid: true };
}

/**
 * Get strategy label by ID
 */
export function getStrategyLabel(id: StrategyKind): string {
  const strat = STRATEGY_CATALOG.find((s) => s.id === id);
  return strat?.label ?? id;
}

/**
 * Get strategy description by ID
 */
export function getStrategyDescription(id: StrategyKind): string {
  const strat = STRATEGY_CATALOG.find((s) => s.id === id);
  return strat?.description ?? "";
}

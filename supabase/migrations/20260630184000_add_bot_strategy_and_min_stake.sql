-- Add strategy_mode and min_stake_per_trade to bot_runs
ALTER TABLE public.bot_runs
  ADD COLUMN IF NOT EXISTS min_stake_per_trade numeric NOT NULL DEFAULT 0.35;

ALTER TABLE public.bot_runs
  ADD COLUMN IF NOT EXISTS strategy_mode text NOT NULL DEFAULT 'qwen';
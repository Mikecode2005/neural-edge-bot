-- Add account_balance to bot_runs
ALTER TABLE public.bot_runs
  ADD COLUMN IF NOT EXISTS account_balance numeric NOT NULL DEFAULT 1000;

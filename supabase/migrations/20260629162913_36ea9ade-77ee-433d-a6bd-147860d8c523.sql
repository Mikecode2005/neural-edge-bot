
-- Extend bot_runs for autonomous loop config
ALTER TABLE public.bot_runs
  ADD COLUMN IF NOT EXISTS interval_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS min_confidence numeric NOT NULL DEFAULT 0.7,
  ADD COLUMN IF NOT EXISTS max_stake_per_trade numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS market_mode text NOT NULL DEFAULT 'synthetic',
  ADD COLUMN IF NOT EXISTS timeframe text NOT NULL DEFAULT '1m',
  ADD COLUMN IF NOT EXISTS last_tick_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS account_loginid text;

ALTER TABLE public.bot_runs DROP CONSTRAINT IF EXISTS bot_runs_status_check;
ALTER TABLE public.bot_runs ADD CONSTRAINT bot_runs_status_check CHECK (status IN ('running','paused','stopped','error'));

-- Settings extras
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS custom_doctrine text,
  ADD COLUMN IF NOT EXISTS confidence_stake_curve jsonb NOT NULL DEFAULT '[{"min":0.6,"pct":1},{"min":0.75,"pct":2},{"min":0.9,"pct":5}]'::jsonb,
  ADD COLUMN IF NOT EXISTS default_interval_seconds integer NOT NULL DEFAULT 60;

-- Strategy memory: pinned flag
ALTER TABLE public.strategy_memory
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;

-- Backtest runs
CREATE TABLE IF NOT EXISTS public.backtest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  timeframe text NOT NULL DEFAULT '1m',
  start_epoch bigint NOT NULL,
  end_epoch bigint NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  equity_curve jsonb NOT NULL DEFAULT '[]'::jsonb,
  trades jsonb NOT NULL DEFAULT '[]'::jsonb,
  starting_balance numeric NOT NULL DEFAULT 1000,
  final_balance numeric,
  final_pnl numeric,
  win_rate numeric,
  trades_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backtest_runs TO authenticated;
GRANT ALL ON public.backtest_runs TO service_role;
ALTER TABLE public.backtest_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own backtests" ON public.backtest_runs FOR ALL TO authenticated USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE TRIGGER trg_backtest_updated BEFORE UPDATE ON public.backtest_runs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Chat threads
CREATE TABLE IF NOT EXISTS public.chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_threads TO authenticated;
GRANT ALL ON public.chat_threads TO service_role;
ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own threads" ON public.chat_threads FOR ALL TO authenticated USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE TRIGGER trg_chat_threads_updated BEFORE UPDATE ON public.chat_threads FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Chat messages
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_messages TO authenticated;
GRANT ALL ON public.chat_messages TO service_role;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own messages" ON public.chat_messages FOR ALL TO authenticated USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON public.chat_messages (thread_id, created_at);

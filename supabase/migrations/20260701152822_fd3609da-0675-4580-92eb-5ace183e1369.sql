ALTER TABLE public.bot_runs
  ADD COLUMN IF NOT EXISTS current_price numeric,
  ADD COLUMN IF NOT EXISTS locked_stake numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS floating_pnl numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wins integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS losses integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_server_loop_at timestamptz,
  ADD COLUMN IF NOT EXISTS server_loop_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.bot_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bot_run_id uuid NOT NULL REFERENCES public.bot_runs(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('CALL','PUT')),
  account_type text NOT NULL CHECK (account_type IN ('demo','real')),
  market_mode text NOT NULL DEFAULT 'simulated',
  stake numeric NOT NULL CHECK (stake > 0),
  payout numeric NOT NULL DEFAULT 0,
  entry_price numeric NOT NULL,
  current_price numeric,
  exit_price numeric,
  stop_loss numeric,
  take_profit numeric,
  duration integer NOT NULL DEFAULT 10,
  duration_unit text NOT NULL DEFAULT 'm',
  opened_epoch bigint NOT NULL,
  expires_epoch bigint,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','error')),
  pnl numeric NOT NULL DEFAULT 0,
  floating_pnl numeric NOT NULL DEFAULT 0,
  outcome text CHECK (outcome IN ('win','loss','breakeven')),
  trade_history_id uuid,
  ai_decision_id uuid,
  external_contract_id text,
  reasoning text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_positions TO authenticated;
GRANT ALL ON public.bot_positions TO service_role;
ALTER TABLE public.bot_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own bot positions" ON public.bot_positions;
CREATE POLICY "Users can manage own bot positions"
ON public.bot_positions FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.bot_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bot_run_id uuid NOT NULL REFERENCES public.bot_runs(id) ON DELETE CASCADE,
  action text NOT NULL,
  symbol text NOT NULL,
  direction text,
  confidence numeric,
  entry_price numeric,
  stake numeric,
  stop_loss numeric,
  take_profit numeric,
  pnl numeric,
  reasoning text NOT NULL,
  ob_zone text,
  fvg_zone text,
  risk_check text,
  indicators jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_activity TO authenticated;
GRANT ALL ON public.bot_activity TO service_role;
ALTER TABLE public.bot_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own bot activity" ON public.bot_activity;
CREATE POLICY "Users can manage own bot activity"
ON public.bot_activity FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS bot_positions_bot_status_idx ON public.bot_positions(bot_run_id, status);
CREATE INDEX IF NOT EXISTS bot_positions_user_open_idx ON public.bot_positions(user_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS bot_activity_bot_created_idx ON public.bot_activity(bot_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_runs_running_loop_idx ON public.bot_runs(status, server_loop_enabled, last_tick_at);

DROP TRIGGER IF EXISTS set_bot_positions_updated_at ON public.bot_positions;
CREATE TRIGGER set_bot_positions_updated_at
BEFORE UPDATE ON public.bot_positions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bot_positions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bot_positions;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bot_activity'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bot_activity;
  END IF;
END $$;
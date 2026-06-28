
-- =========================================================
-- DERIV CONNECTIONS (encrypted tokens, server-only reads)
-- =========================================================
CREATE TABLE public.deriv_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  loginid TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('demo','real')),
  currency TEXT,
  balance NUMERIC,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, loginid)
);
GRANT SELECT, UPDATE, DELETE ON public.deriv_connections TO authenticated;
GRANT ALL ON public.deriv_connections TO service_role;
ALTER TABLE public.deriv_connections ENABLE ROW LEVEL SECURITY;

-- Users can see metadata about their own connections (NOT tokens — those columns should be selected only by service_role in practice)
CREATE POLICY "users select own deriv connections" ON public.deriv_connections
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users update own deriv connections" ON public.deriv_connections
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own deriv connections" ON public.deriv_connections
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER deriv_connections_set_updated_at
  BEFORE UPDATE ON public.deriv_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- AI DECISIONS
-- =========================================================
CREATE TABLE public.ai_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('CALL','PUT','NONE')),
  stake NUMERIC,
  duration INTEGER,
  duration_unit TEXT,
  take_profit NUMERIC,
  stop_loss NUMERIC,
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reasoning TEXT,
  model TEXT,
  prompt_hash TEXT,
  candles_snapshot JSONB,
  ob_zones JSONB,
  fvg_zones JSONB,
  recalled_memory JSONB,
  contract_id TEXT,
  executed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_decisions TO authenticated;
GRANT ALL ON public.ai_decisions TO service_role;
ALTER TABLE public.ai_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own ai decisions" ON public.ai_decisions
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ai_decisions_user_created_idx ON public.ai_decisions(user_id, created_at DESC);

-- =========================================================
-- STRATEGY MEMORY (the AI's notebook)
-- =========================================================
CREATE TABLE public.strategy_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT,
  timeframe TEXT,
  setup_type TEXT,
  lesson TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('win','loss','breakeven','observation')),
  pnl NUMERIC,
  tags TEXT[] DEFAULT '{}'::TEXT[],
  usefulness_score NUMERIC NOT NULL DEFAULT 1.0,
  times_recalled INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategy_memory TO authenticated;
GRANT ALL ON public.strategy_memory TO service_role;
ALTER TABLE public.strategy_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own strategy memory" ON public.strategy_memory
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX strategy_memory_recall_idx ON public.strategy_memory(user_id, symbol, setup_type, usefulness_score DESC);
CREATE TRIGGER strategy_memory_set_updated_at
  BEFORE UPDATE ON public.strategy_memory
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- BOT RUNS
-- =========================================================
CREATE TABLE public.bot_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual','auto')),
  account_type TEXT NOT NULL CHECK (account_type IN ('demo','real')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at TIMESTAMPTZ,
  total_trades INTEGER NOT NULL DEFAULT 0,
  total_pnl NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped','error'))
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_runs TO authenticated;
GRANT ALL ON public.bot_runs TO service_role;
ALTER TABLE public.bot_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own bot runs" ON public.bot_runs
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =========================================================
-- EXTENSIONS to existing tables
-- =========================================================
ALTER TABLE public.trade_history
  ADD COLUMN IF NOT EXISTS ai_decision_id UUID REFERENCES public.ai_decisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deriv_contract_id TEXT,
  ADD COLUMN IF NOT EXISTS take_profit NUMERIC,
  ADD COLUMN IF NOT EXISTS stop_loss NUMERIC;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS auto_trade BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS account_mode TEXT NOT NULL DEFAULT 'demo' CHECK (account_mode IN ('demo','real')),
  ADD COLUMN IF NOT EXISTS min_confidence NUMERIC NOT NULL DEFAULT 0.7,
  ADD COLUMN IF NOT EXISTS max_daily_loss NUMERIC NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS max_stake NUMERIC NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS max_trades_per_day INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS risk_percent NUMERIC NOT NULL DEFAULT 2;

-- =========================================================
-- REALTIME
-- =========================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_decisions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bot_runs;

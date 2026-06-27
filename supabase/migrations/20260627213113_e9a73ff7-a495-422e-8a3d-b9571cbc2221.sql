
-- =========================================================
-- AI Autonomous Crypto Trading Platform — Core Schema
-- Auth is deferred: tables include user_id (nullable) for
-- future per-user scoping. Public read for demo.
-- =========================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- updated_at helper
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ---------- profiles ----------
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'trader' CHECK (role IN ('admin','trader','guest')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO anon;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_read_all" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "profiles_write_anon_demo" ON public.profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "profiles_update_anon_demo" ON public.profiles FOR UPDATE USING (true);
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- settings ----------
CREATE TABLE public.settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  dark_mode BOOLEAN NOT NULL DEFAULT true,
  notifications_enabled BOOLEAN NOT NULL DEFAULT true,
  auto_trade BOOLEAN NOT NULL DEFAULT false,
  risk_percent NUMERIC(5,2) NOT NULL DEFAULT 1.00,
  max_daily_loss NUMERIC(12,2) NOT NULL DEFAULT 500.00,
  max_open_trades INT NOT NULL DEFAULT 5,
  default_timeframe TEXT NOT NULL DEFAULT '1m',
  default_symbol TEXT NOT NULL DEFAULT 'R_10',
  preferred_indicators JSONB NOT NULL DEFAULT '["ema","rsi","fvg","ob"]'::jsonb,
  language TEXT NOT NULL DEFAULT 'en',
  theme TEXT NOT NULL DEFAULT 'midnight',
  confidence_threshold NUMERIC(4,2) NOT NULL DEFAULT 0.65,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO authenticated, anon;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings_all_demo" ON public.settings FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER trg_settings_updated BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- watchlists ----------
CREATE TABLE public.watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  name TEXT NOT NULL DEFAULT 'Default',
  symbols JSONB NOT NULL DEFAULT '["R_10","1HZ10V","R_15","1HZ15V","R_25","1HZ25V"]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.watchlists TO authenticated, anon;
GRANT ALL ON public.watchlists TO service_role;
ALTER TABLE public.watchlists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "watchlists_all_demo" ON public.watchlists FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER trg_watchlists_updated BEFORE UPDATE ON public.watchlists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- strategies ----------
CREATE TABLE public.strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'ob_fvg',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  symbols JSONB NOT NULL DEFAULT '["R_10"]'::jsonb,
  timeframe TEXT NOT NULL DEFAULT '1m',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategies TO authenticated, anon;
GRANT ALL ON public.strategies TO service_role;
ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "strategies_all_demo" ON public.strategies FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER trg_strategies_updated BEFORE UPDATE ON public.strategies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- predictions ----------
CREATE TABLE public.predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  strategy_id UUID,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1m',
  decision TEXT NOT NULL CHECK (decision IN ('BUY','SELL','WAIT')),
  confidence NUMERIC(4,3) NOT NULL,
  risk_score NUMERIC(4,3),
  success_probability NUMERIC(4,3),
  reasoning TEXT,
  trade_plan JSONB,
  indicators JSONB,
  market_state JSONB,
  suggested_entry NUMERIC(20,8),
  suggested_sl NUMERIC(20,8),
  suggested_tp NUMERIC(20,8),
  suggested_size NUMERIC(20,8),
  model_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.predictions TO authenticated, anon;
GRANT ALL ON public.predictions TO service_role;
ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "predictions_all_demo" ON public.predictions FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX idx_predictions_symbol_time ON public.predictions(symbol, created_at DESC);

-- ---------- prediction_results ----------
CREATE TABLE public.prediction_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id UUID NOT NULL REFERENCES public.predictions(id) ON DELETE CASCADE,
  actual_outcome TEXT,
  actual_price_at_resolve NUMERIC(20,8),
  pnl NUMERIC(20,8),
  was_correct BOOLEAN,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prediction_results TO authenticated, anon;
GRANT ALL ON public.prediction_results TO service_role;
ALTER TABLE public.prediction_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prediction_results_all_demo" ON public.prediction_results FOR ALL USING (true) WITH CHECK (true);

-- ---------- trade_history (unified) ----------
CREATE TABLE public.trade_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  prediction_id UUID REFERENCES public.predictions(id) ON DELETE SET NULL,
  strategy_id UUID,
  mode TEXT NOT NULL CHECK (mode IN ('demo','live')),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  entry_price NUMERIC(20,8) NOT NULL,
  exit_price NUMERIC(20,8),
  size NUMERIC(20,8) NOT NULL,
  stop_loss NUMERIC(20,8),
  take_profit NUMERIC(20,8),
  pnl NUMERIC(20,8),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  reason_opened TEXT,
  reason_closed TEXT,
  deriv_contract_id TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_history TO authenticated, anon;
GRANT ALL ON public.trade_history TO service_role;
ALTER TABLE public.trade_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trade_history_all_demo" ON public.trade_history FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX idx_trade_history_symbol_time ON public.trade_history(symbol, opened_at DESC);
CREATE INDEX idx_trade_history_mode_status ON public.trade_history(mode, status);

-- Views for paper_trade_history / live_trade_history
CREATE OR REPLACE VIEW public.paper_trade_history AS
  SELECT * FROM public.trade_history WHERE mode = 'demo';
CREATE OR REPLACE VIEW public.live_trade_history AS
  SELECT * FROM public.trade_history WHERE mode = 'live';
GRANT SELECT ON public.paper_trade_history TO authenticated, anon, service_role;
GRANT SELECT ON public.live_trade_history TO authenticated, anon, service_role;

-- ---------- portfolio ----------
CREATE TABLE public.portfolio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  mode TEXT NOT NULL CHECK (mode IN ('demo','live')),
  balance NUMERIC(20,8) NOT NULL DEFAULT 10000,
  equity NUMERIC(20,8) NOT NULL DEFAULT 10000,
  realized_pnl NUMERIC(20,8) NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC(20,8) NOT NULL DEFAULT 0,
  open_positions INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, mode)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio TO authenticated, anon;
GRANT ALL ON public.portfolio TO service_role;
ALTER TABLE public.portfolio ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolio_all_demo" ON public.portfolio FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER trg_portfolio_updated BEFORE UPDATE ON public.portfolio
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- notifications ----------
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  payload JSONB,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated, anon;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notifications_all_demo" ON public.notifications FOR ALL USING (true) WITH CHECK (true);

-- ---------- logs ----------
CREATE TABLE public.logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level TEXT NOT NULL DEFAULT 'info',
  source TEXT,
  message TEXT NOT NULL,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.logs TO authenticated, anon;
GRANT ALL ON public.logs TO service_role;
ALTER TABLE public.logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "logs_all_demo" ON public.logs FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX idx_logs_time ON public.logs(created_at DESC);

-- ---------- learning_memory ----------
CREATE TABLE public.learning_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  pattern TEXT NOT NULL,
  context JSONB NOT NULL,
  outcome TEXT NOT NULL,
  pnl NUMERIC(20,8),
  validated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_memory TO authenticated, anon;
GRANT ALL ON public.learning_memory TO service_role;
ALTER TABLE public.learning_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "learning_memory_all_demo" ON public.learning_memory FOR ALL USING (true) WITH CHECK (true);

-- ---------- model_versions ----------
CREATE TABLE public.model_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  artifact_uri TEXT,
  metrics JSONB,
  is_production BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.model_versions TO authenticated, anon;
GRANT ALL ON public.model_versions TO service_role;
ALTER TABLE public.model_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "model_versions_all_demo" ON public.model_versions FOR ALL USING (true) WITH CHECK (true);

-- ---------- feedback ----------
CREATE TABLE public.feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id UUID REFERENCES public.predictions(id) ON DELETE CASCADE,
  user_id UUID,
  rating INT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedback TO authenticated, anon;
GRANT ALL ON public.feedback TO service_role;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "feedback_all_demo" ON public.feedback FOR ALL USING (true) WITH CHECK (true);

-- ---------- api_connections (encrypted creds stored server-side only) ----------
CREATE TABLE public.api_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  provider TEXT NOT NULL CHECK (provider IN ('deriv','binance','bybit','hyperliquid')),
  label TEXT,
  encrypted_token TEXT NOT NULL,
  meta JSONB,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- service_role only (never expose tokens to client)
GRANT ALL ON public.api_connections TO service_role;
ALTER TABLE public.api_connections ENABLE ROW LEVEL SECURITY;
-- no anon/authenticated policies = client cannot read
CREATE TRIGGER trg_api_connections_updated BEFORE UPDATE ON public.api_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- performance_metrics ----------
CREATE TABLE public.performance_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  mode TEXT NOT NULL CHECK (mode IN ('demo','live')),
  period TEXT NOT NULL,
  win_rate NUMERIC(5,4),
  profit_factor NUMERIC(10,4),
  sharpe NUMERIC(10,4),
  max_drawdown NUMERIC(10,4),
  total_trades INT,
  winning_trades INT,
  losing_trades INT,
  total_pnl NUMERIC(20,8),
  prediction_accuracy NUMERIC(5,4),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.performance_metrics TO authenticated, anon;
GRANT ALL ON public.performance_metrics TO service_role;
ALTER TABLE public.performance_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "performance_metrics_all_demo" ON public.performance_metrics FOR ALL USING (true) WITH CHECK (true);

-- ---------- audit_logs ----------
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id UUID,
  ip TEXT,
  user_agent TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.audit_logs TO authenticated, anon;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_read" ON public.audit_logs FOR SELECT USING (true);
CREATE POLICY "audit_logs_insert" ON public.audit_logs FOR INSERT WITH CHECK (true);

-- ---------- live AI signals (for realtime UI feed) ----------
CREATE TABLE public.live_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('BUY','SELL','WAIT')),
  confidence NUMERIC(4,3) NOT NULL,
  price NUMERIC(20,8) NOT NULL,
  ob_zone JSONB,
  fvg_zone JSONB,
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_signals TO authenticated, anon;
GRANT ALL ON public.live_signals TO service_role;
ALTER TABLE public.live_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "live_signals_all_demo" ON public.live_signals FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX idx_live_signals_symbol_time ON public.live_signals(symbol, created_at DESC);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_signals;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trade_history;
ALTER PUBLICATION supabase_realtime ADD TABLE public.portfolio;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

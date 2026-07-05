
ALTER TABLE public.bot_activity ADD COLUMN IF NOT EXISTS regime text;
ALTER TABLE public.bot_activity ADD COLUMN IF NOT EXISTS confluence_score numeric;
ALTER TABLE public.bot_activity ADD COLUMN IF NOT EXISTS score_breakdown jsonb;
ALTER TABLE public.bot_activity ADD COLUMN IF NOT EXISTS strategy text;

ALTER TABLE public.bot_positions ADD COLUMN IF NOT EXISTS strategy text;
ALTER TABLE public.bot_positions ADD COLUMN IF NOT EXISTS regime text;
ALTER TABLE public.bot_positions ADD COLUMN IF NOT EXISTS confluence_score numeric;

CREATE OR REPLACE VIEW public.strategy_performance AS
SELECT
  user_id,
  bot_run_id,
  COALESCE(strategy, 'unknown') AS strategy,
  COUNT(*)::int AS trades,
  COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
  COUNT(*) FILTER (WHERE outcome = 'loss')::int AS losses,
  ROUND(AVG(pnl)::numeric, 4) AS avg_pnl,
  ROUND(SUM(pnl)::numeric, 4) AS net_pnl,
  CASE WHEN COUNT(*) > 0
       THEN ROUND((COUNT(*) FILTER (WHERE outcome = 'win'))::numeric / COUNT(*)::numeric, 4)
       ELSE 0 END AS win_rate
FROM public.bot_positions
WHERE outcome IS NOT NULL
GROUP BY user_id, bot_run_id, strategy;

GRANT SELECT ON public.strategy_performance TO authenticated;

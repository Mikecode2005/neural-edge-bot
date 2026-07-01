import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Play,
  Square,
  Activity,
  Wallet,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Settings,
  Terminal,
  ExternalLink,
  Info,
  Target,
  Shield,
  BarChart3,
  Zap,
  Eye,
  EyeOff,
  Trash2,
} from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import {
  startBot,
  stopBot,
  listBots,
  updateBotBalance,
  resetBotStats,
  listBotActivity,
  listOpenBotPositions,
  runBotServerTick,
} from "@/lib/bots/bots.functions";
import { DERIV_SYMBOLS } from "@/lib/deriv-ws";

export const Route = createFileRoute("/_authenticated/bots")({
  head: () => ({ meta: [{ title: "Bots — Autonomous AI Loop" }] }),
  component: BotsPage,
});

interface BotRow {
  id: string;
  symbol: string;
  timeframe: string;
  account_type: "demo" | "real";
  status: "running" | "paused" | "stopped" | "error";
  interval_seconds: number;
  min_confidence: number;
  max_stake_per_trade: number;
  min_stake_per_trade?: number; // fallback: 0.35
  strategy_mode?: "qwen" | "ob-fvg"; // fallback: "qwen"
  total_trades: number;
  total_pnl: number;
  locked_stake?: number;
  floating_pnl?: number;
  wins?: number;
  losses?: number;
  current_price?: number | null;
  last_server_loop_at?: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  market_mode: string;
  account_balance?: number;
}

interface OpenBotPosition {
  id: string;
  direction: "CALL" | "PUT";
  stake: number;
  entry_price: number;
  current_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  floating_pnl: number;
  opened_at: string;
}

interface ActivityEntry {
  id: string;
  timestamp: number;
  action: "SCAN" | "SKIP" | "ENTRY" | "EXIT" | "ERROR" | "PROTECTION";
  symbol: string;
  direction: "CALL" | "PUT" | "NONE" | "—";
  confidence: number;
  entryPrice: number | null;
  stake: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  duration: string | null;
  pnl: number | null;
  reasoning: string;
  obZone: string | null;
  fvgZone: string | null;
  riskCheck: string | null;
  trend: string | null;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
}

function BotsPage() {
  const fnStart = useServerFn(startBot);
  const fnStop = useServerFn(stopBot);
  const fnList = useServerFn(listBots);
  const fnUpdateBalance = useServerFn(updateBotBalance);
  const fnResetStats = useServerFn(resetBotStats);
  const fnActivity = useServerFn(listBotActivity);
  const fnOpenPositions = useServerFn(listOpenBotPositions);
  const fnServerTick = useServerFn(runBotServerTick);

  const [bots, setBots] = useState<BotRow[]>([]);
  const [form, setForm] = useState({
    symbol: "R_10",
    account_type: "simulated" as "simulated" | "demo" | "real",
    interval_seconds: 60,
    min_confidence: 0.65,
    max_stake_per_trade: 1,
    min_stake_per_trade: 0.35,
    strategy_mode: "ob-fvg" as "qwen" | "ob-fvg",
    account_balance: 1000,
  });

  // Activity logs per bot
  const [activityLogs, setActivityLogs] = useState<Map<string, ActivityEntry[]>>(new Map());
  const [openPositions, setOpenPositions] = useState<Map<string, OpenBotPosition[]>>(new Map());
  const [expandedBots, setExpandedBots] = useState<Set<string>>(new Set());
  const [editingBalance, setEditingBalance] = useState<string | null>(null);
  const [newBalance, setNewBalance] = useState("");
  const [showMt5Guide, setShowMt5Guide] = useState(false);

  const loopsRef = useRef<Map<string, number>>(new Map());
  const logIdRef = useRef(0);

  const addLog = useCallback((botId: string, entry: Omit<ActivityEntry, "id">) => {
    const id = `log-${++logIdRef.current}`;
    setActivityLogs((prev) => {
      const next = new Map(prev);
      const existing = next.get(botId) ?? [];
      next.set(botId, [{ ...entry, id }, ...existing].slice(0, 100)); // cap at 100 to prevent memory bloat
      return next;
    });
  }, []);

  const mapDbActivity = (row: any): ActivityEntry => ({
    id: row.id,
    timestamp: new Date(row.created_at).getTime(),
    action: row.action,
    symbol: row.symbol,
    direction: row.direction ?? "—",
    confidence: Number(row.confidence ?? 0),
    entryPrice: row.entry_price == null ? null : Number(row.entry_price),
    stake: row.stake == null ? null : Number(row.stake),
    stopLoss: row.stop_loss == null ? null : Number(row.stop_loss),
    takeProfit: row.take_profit == null ? null : Number(row.take_profit),
    duration: null,
    pnl: row.pnl == null ? null : Number(row.pnl),
    reasoning: row.reasoning,
    obZone: row.ob_zone ?? null,
    fvgZone: row.fvg_zone ?? null,
    riskCheck: row.risk_check ?? null,
    trend: row.indicators?.trend ?? null,
    ema20: row.indicators?.ema20 == null ? null : Number(row.indicators.ema20),
    ema50: row.indicators?.ema50 == null ? null : Number(row.indicators.ema50),
    rsi14: row.indicators?.rsi14 == null ? null : Number(row.indicators.rsi14),
    atr14: row.indicators?.atr14 == null ? null : Number(row.indicators.atr14),
  });

  const refreshBotState = async (botId: string) => {
    const [rows, positions] = await Promise.all([
      fnActivity({ data: { bot_id: botId, limit: 100 } }) as Promise<any[]>,
      fnOpenPositions({ data: { bot_id: botId } }) as Promise<any[]>,
    ]);
    setActivityLogs((prev) => {
      const next = new Map(prev);
      next.set(botId, rows.map(mapDbActivity));
      return next;
    });
    setOpenPositions((prev) => {
      const next = new Map(prev);
      next.set(botId, positions.map((p) => ({
        id: p.id,
        direction: p.direction,
        stake: Number(p.stake ?? 0),
        entry_price: Number(p.entry_price ?? 0),
        current_price: p.current_price == null ? null : Number(p.current_price),
        stop_loss: p.stop_loss == null ? null : Number(p.stop_loss),
        take_profit: p.take_profit == null ? null : Number(p.take_profit),
        floating_pnl: Number(p.floating_pnl ?? 0),
        opened_at: p.opened_at,
      })));
      return next;
    });
  };

  const load = async () => {
    const rows = (await fnList()) as BotRow[];
    setBots(rows);
    await Promise.all(rows.slice(0, 20).map((b) => refreshBotState(b.id).catch(() => {})));
  };
  useEffect(() => {
    load();
    return () => {
      loopsRef.current.forEach((id) => clearInterval(id));
    };
  }, []);

  const clearActivityLog = (botId: string) => {
    setActivityLogs((prev) => {
      const next = new Map(prev);
      next.delete(botId);
      return next;
    });
    toast.message("Activity log cleared");
  };

  const handleResetStats = async (botId: string) => {
    if (!confirm("Are you sure you want to reset trade count and P&L statistics for this bot?")) return;
    await fnResetStats({ data: { id: botId } });
    toast.success("Statistics reset successfully");
    load();
  };

  const runOneTick = async (bot: BotRow) => {
    const ts = Date.now();
    try {
      await fnServerTick({ data: { id: bot.id } });
      await refreshBotState(bot.id);
      await load();
    } catch (e: any) {
      addLog(bot.id, {
        timestamp: ts, action: "ERROR", symbol: bot.symbol,
        direction: "—", confidence: 0,
        entryPrice: null, stake: null, stopLoss: null, takeProfit: null,
        duration: null, pnl: null,
        reasoning: e?.message || "Server bot loop failed",
        obZone: null, fvgZone: null, riskCheck: "Server loop error",
        trend: null, ema20: null, ema50: null, rsi14: null, atr14: null,
      });
    }
  };

  const startLoop = (bot: BotRow) => {
    if (loopsRef.current.has(bot.id)) return;
    runOneTick(bot);
    const handle = window.setInterval(() => runOneTick(bot), bot.interval_seconds * 1000);
    loopsRef.current.set(bot.id, handle);
  };

  // Auto-attach loops to running bots while page is open
  useEffect(() => {
    bots.forEach((b) => {
      if (b.status === "running") startLoop(b);
      else {
        const h = loopsRef.current.get(b.id);
        if (h) {
          clearInterval(h);
          loopsRef.current.delete(b.id);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots]);

  const onCreate = async () => {
    const isSimulated = form.account_type === "simulated";
    if (form.account_type === "real") {
      const ok = confirm("Start an autonomous bot trading REAL money? This will place live trades.");
      if (!ok) return;
    }
    const row = (await fnStart({
      data: {
        symbol: form.symbol,
        timeframe: "1m",
        account_type: isSimulated ? "demo" : form.account_type, // save as demo in DB if simulated to satisfy constraint
        market_mode: isSimulated ? "simulated" : "synthetic",
        interval_seconds: form.interval_seconds,
        min_confidence: form.min_confidence,
        max_stake_per_trade: form.max_stake_per_trade,
        min_stake_per_trade: form.min_stake_per_trade,
        strategy_mode: form.strategy_mode,
        account_balance: form.account_balance,
      },
    })) as BotRow;
    setBots((p) => [row, ...p]);
    toast.success(`Bot started on ${row.symbol}`);
  };

  const onStop = async (id: string) => {
    const h = loopsRef.current.get(id);
    if (h) {
      clearInterval(h);
      loopsRef.current.delete(id);
    }
    await fnStop({ data: { id } });
    load();
  };

  const onUpdateBalance = async (botId: string) => {
    const val = parseFloat(newBalance);
    if (!val || val <= 0) {
      toast.error("Enter a valid balance");
      return;
    }
    await fnUpdateBalance({ data: { id: botId, account_balance: val } });
    setEditingBalance(null);
    setNewBalance("");
    toast.success("Balance updated");
    load();
  };

  const toggleExpand = (id: string) => {
    setExpandedBots((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Compute bot stats
  const getBotStats = (bot: BotRow) => {
    const logs = activityLogs.get(bot.id) ?? [];
    const trades = logs.filter((l) => l.action === "EXIT");
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const scans = logs.filter((l) => l.action === "SCAN").length;
    const entries = logs.filter((l) => l.action === "ENTRY").length;
    const errors = logs.filter((l) => l.action === "ERROR").length;

    // Compute peak balance & drawdown from trade sequence
    let peak = bot.account_balance ?? 1000;
    let current = peak;
    let maxDD = 0;
    for (const t of [...trades].reverse()) {
      current += t.pnl ?? 0;
      if (current > peak) peak = current;
      const dd = ((peak - current) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    return { wins, losses, winRate, scans, entries, errors, maxDD, trades: trades.length };
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Autonomous Bots</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Each bot uses the same OB+FVG engine as backtesting, persists its activity, and can be processed by the hosted server loop after deployment.
          </p>
        </header>

        {/* ── New Bot Form ── */}
        <div className="glass rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Play className="size-3.5 text-primary" /> New Bot
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
            <div>
              <Label className="text-xs">Symbol</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={form.symbol}
                onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              >
                {DERIV_SYMBOLS.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Account / Execution Mode</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={form.account_type}
                onChange={(e) => setForm({ ...form, account_type: e.target.value as any })}
              >
                <option value="simulated">Local Simulated Demo (Paper trade)</option>
                <option value="demo">Deriv Virtual Demo Account</option>
                <option value="real">Deriv Live Real Account</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Account Balance ($)</Label>
              <Input
                type="number"
                min={1}
                step="100"
                value={form.account_balance}
                onChange={(e) => setForm({ ...form, account_balance: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className="text-xs">Interval (s)</Label>
              <Input
                type="number"
                min={10}
                max={3600}
                value={form.interval_seconds}
                onChange={(e) => setForm({ ...form, interval_seconds: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className="text-xs">Min Confidence</Label>
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={form.min_confidence}
                onChange={(e) => setForm({ ...form, min_confidence: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className="text-xs">Max Stake / Trade</Label>
              <Input
                type="number"
                step="0.5"
                min={0.35}
                value={form.max_stake_per_trade}
                onChange={(e) =>
                  setForm({ ...form, max_stake_per_trade: Number(e.target.value) })
                }
              />
            </div>
            <div>
              <Label className="text-xs">Min Stake</Label>
              <Input
                type="number"
                step="0.1"
                min={0.35}
                value={form.min_stake_per_trade}
                onChange={(e) =>
                  setForm({ ...form, min_stake_per_trade: Number(e.target.value) })
                }
              />
            </div>
            <div>
              <Label className="text-xs">Strategy Mode</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={form.strategy_mode}
                onChange={(e) => setForm({ ...form, strategy_mode: e.target.value as "qwen" | "ob-fvg" })}
              >
                <option value="qwen">Qwen AI (with memory)</option>
                <option value="ob-fvg">OB+FVG Strategy Only</option>
              </select>
            </div>
          </div>
          <Button onClick={onCreate} className="gap-1.5">
            <Play className="size-3.5" /> Start Bot
          </Button>
        </div>

        {/* ── Bot Cards ── */}
        <div className="space-y-4">
          {bots.map((b) => {
            const stats = getBotStats(b);
            const isExpanded = expandedBots.has(b.id);
            const logs = activityLogs.get(b.id) ?? [];
              const lockedStake = Number(b.locked_stake ?? 0);
              const floatingPnl = Number(b.floating_pnl ?? 0);
              const availableBalance = (b.account_balance ?? 1000) + Number(b.total_pnl ?? 0) - lockedStake;
              const equity = availableBalance + lockedStake + floatingPnl;
            const isSimulated = b.market_mode === "simulated";
              const positions = openPositions.get(b.id) ?? [];

            return (
              <div key={b.id} className="glass rounded-xl overflow-hidden">
                {/* Bot header */}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="space-y-2 flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium flex-wrap">
                        <Activity
                          className={`size-4 ${b.status === "running" ? "text-primary animate-pulse" : "text-muted-foreground"}`}
                        />
                        <span className="font-semibold text-base">{b.symbol}</span>
                        {isSimulated ? (
                          <Badge className="bg-primary/20 text-primary border-primary/30">
                            LOCAL SIMULATED
                          </Badge>
                        ) : (
                          <Badge variant={b.account_type === "demo" ? "secondary" : "destructive"}>
                            DERIV {b.account_type.toUpperCase()}
                          </Badge>
                        )}
                        <Badge variant="outline">{b.status}</Badge>
                        {b.status === "running" && (
                          <span className="text-xs text-primary">● Live Loop Running</span>
                        )}
                      </div>

                      {/* Quick stats row */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                        <MiniStat
                          icon={<Wallet className="size-3" />}
                          label="Available"
                          value={`$${availableBalance.toFixed(2)}`}
                        />
                        <MiniStat
                          icon={<TrendingUp className="size-3" />}
                          label="Equity"
                          value={`$${equity.toFixed(2)}`}
                          tone={equity >= (b.account_balance ?? 1000) ? "bull" : "bear"}
                        />
                        <MiniStat
                          icon={<Target className="size-3" />}
                          label="Trades"
                          value={`${b.total_trades ?? 0}`}
                        />
                        <MiniStat
                          icon={<BarChart3 className="size-3" />}
                          label="Win Rate"
                          value={(Number(b.wins ?? 0) + Number(b.losses ?? 0)) > 0 ? `${((Number(b.wins ?? 0) / (Number(b.wins ?? 0) + Number(b.losses ?? 0))) * 100).toFixed(0)}%` : "—"}
                          tone={stats.winRate >= 50 ? "bull" : stats.winRate > 0 ? "bear" : undefined}
                        />
                        <MiniStat
                          icon={<TrendingDown className="size-3" />}
                          label="Open P&L"
                          value={`${floatingPnl >= 0 ? "+" : ""}${floatingPnl.toFixed(2)}`}
                          tone={floatingPnl >= 0 ? "bull" : "bear"}
                        />
                        <MiniStat
                          icon={<Clock className="size-3" />}
                          label="Interval"
                          value={`${b.interval_seconds}s`}
                        />
                        <MiniStat
                          icon={<Shield className="size-3" />}
                          label="Min Conf"
                          value={`${(b.min_confidence * 100).toFixed(0)}%`}
                        />
                      </div>

                      {/* Errors */}
                      {b.last_error && (
                        <p className="text-xs text-bear flex items-center gap-1">
                          <AlertTriangle className="size-3" /> {b.last_error}
                        </p>
                      )}

                      {positions.length > 0 && (
                        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                          <div className="mb-2 flex items-center justify-between text-xs">
                            <span className="font-semibold text-primary">Open simulated broker contract</span>
                            <span className="numeric text-muted-foreground">Locked ${lockedStake.toFixed(2)}</span>
                          </div>
                          <div className="space-y-1">
                            {positions.map((p) => (
                              <div key={p.id} className="grid grid-cols-2 gap-2 text-[11px] md:grid-cols-6">
                                <span className={p.direction === "CALL" ? "text-bull" : "text-bear"}>{p.direction}</span>
                                <span className="numeric">Stake ${p.stake.toFixed(2)}</span>
                                <span className="numeric">Entry {p.entry_price.toFixed(4)}</span>
                                <span className="numeric">Now {p.current_price?.toFixed(4) ?? "—"}</span>
                                <span className="numeric">TP {p.take_profit?.toFixed(4) ?? "—"}</span>
                                <span className={`numeric font-semibold ${p.floating_pnl >= 0 ? "text-bull" : "text-bear"}`}>{p.floating_pnl >= 0 ? "+" : ""}{p.floating_pnl.toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-2 items-end shrink-0">
                      <div className="flex items-center gap-1.5">
                        {b.status === "running" && (
                          <Button size="sm" variant="destructive" onClick={() => onStop(b.id)} className="gap-1.5 h-8">
                            <Square className="size-3.5" /> Stop Bot
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => handleResetStats(b.id)}>
                          <RefreshCw className="size-3" /> Reset Stats
                        </Button>
                      </div>

                      {/* Balance edit */}
                      {editingBalance === b.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            className="w-24 h-7 text-xs"
                            placeholder="New balance"
                            value={newBalance}
                            onChange={(e) => setNewBalance(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && onUpdateBalance(b.id)}
                          />
                          <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={() => onUpdateBalance(b.id)}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => setEditingBalance(null)}>
                            ✕
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1 text-xs h-7"
                          onClick={() => {
                            setEditingBalance(b.id);
                            setNewBalance(String(b.account_balance ?? 1000));
                          }}
                        >
                          <Settings className="size-3" /> Update Balance
                        </Button>
                      )}

                      <div className="flex items-center gap-1.5">
                        {logs.length > 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1 text-xs h-7 text-bear/80 hover:text-bear"
                            onClick={() => clearActivityLog(b.id)}
                          >
                            <Trash2 className="size-3" /> Clear Logs
                          </Button>
                        )}

                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1 text-xs h-7"
                          onClick={() => toggleExpand(b.id)}
                        >
                          {isExpanded ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                          {isExpanded ? "Hide Activity" : "Show Activity"}
                          {logs.length > 0 && (
                            <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1">
                              {logs.length}
                            </Badge>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Activity feed */}
                {isExpanded && (
                  <div className="border-t border-border">
                    <div className="p-3 bg-card/30">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-xs font-semibold flex items-center gap-1.5">
                          <Terminal className="size-3 text-primary" /> Live Activity Feed (Calibrated Setup Classification)
                        </h4>
                        <span className="text-[10px] text-muted-foreground">
                          {logs.length} stored entries
                        </span>
                      </div>

                      {logs.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-4 text-center">
                          No activity yet. Bot will log here on each tick.
                        </p>
                      ) : (
                        <div className="max-h-[500px] overflow-y-auto space-y-1.5 pr-1">
                          {logs.map((entry) => (
                            <ActivityRow key={entry.id} entry={entry} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!bots.length && (
            <p className="text-sm text-muted-foreground text-center py-12">No bots yet.</p>
          )}
        </div>

        {/* ── MT5 Direct & Deriv Bot Demo Section ── */}
        <div className="glass rounded-xl overflow-hidden">
          <button
            onClick={() => setShowMt5Guide(!showMt5Guide)}
            className="w-full p-4 flex items-center justify-between hover:bg-card/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ExternalLink className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">MT5 Direct & Deriv Bot Demo</h2>
              <Badge variant="default" className="text-[10px]">NEW</Badge>
            </div>
            {showMt5Guide ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {showMt5Guide && (
            <div className="px-4 pb-5 border-t border-border space-y-4 pt-4">
              {/* Quick link to MT5 Direct page */}
              <div className="flex items-start gap-3 bg-primary/5 border border-primary/20 rounded-lg p-4">
                <Zap className="size-5 text-primary shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-semibold">Try the new MT5 Direct Page</p>
                  <p className="text-xs text-muted-foreground">
                    Connect directly to MetaTrader 5 from within the app — place orders, view positions,
                    and manage your MT5 account. No Python bridge needed.
                  </p>
                  <Button
                    size="sm"
                    variant="default"
                    className="mt-2 gap-1"
                    onClick={() => window.location.href = "/mt5-direct"}
                  >
                    <ExternalLink className="size-3.5" /> Open MT5 Direct
                  </Button>
                </div>
              </div>

              {/* Step 1 — Get Credentials */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <span className="size-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center">1</span>
                  Get MT5 Credentials from Deriv
                </h3>
                <div className="ml-7 text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <p>1. Log into <a href="https://app.deriv.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">app.deriv.com</a></p>
                  <p>2. Go to <strong>Trader's Hub</strong> → under "CFDs"</p>
                  <p>3. Click <strong>"Get"</strong> next to a demo MT5 account (Synthetic Indices or Financial)</p>
                  <p>4. Note your <strong>Login ID</strong>, <strong>Password</strong>, and <strong>Server</strong></p>
                  <p>5. Add them to <code className="bg-card px-1 rounded">.env</code> as <code className="bg-card px-1 rounded">MT5_ACCOUNT_LOGIN</code>, <code className="bg-card px-1 rounded">MT5_ACCOUNT_PASSWORD</code>, <code className="bg-card px-1 rounded">MT5_ACCOUNT_SERVER</code></p>
                </div>
              </div>

              {/* Step 2 — Node SDK (Primary) */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <span className="size-5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold flex items-center justify-center">2</span>
                  Connect via Node.js SDK <Badge variant="default" className="text-[10px]">Primary</Badge>
                </h3>
                <div className="ml-7 text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <p>The <code className="bg-card px-1 rounded">metatrader5-sdk</code> npm package connects to the MT5 Web API
                  without needing the MT5 terminal installed. Just configure credentials in .env and click
                  <strong> "Connect"</strong> on the MT5 Direct page.</p>
                </div>
              </div>

              {/* Step 3 — Python Bridge (Fallback) */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <span className="size-5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold flex items-center justify-center">3</span>
                  Python Bridge Fallback <Badge variant="outline" className="text-[10px]">Fallback</Badge>
                </h3>
                <div className="ml-7">
                  <div className="bg-card rounded-lg p-3 border border-border text-xs font-mono overflow-x-auto">
                    <pre className="text-muted-foreground">{`# Install dependencies
pip install MetaTrader5 fastapi uvicorn websockets

# Create bridge server (run.py)
from fastapi import FastAPI
from pydantic import BaseModel
import MetaTrader5 as mt5
import uvicorn

app = FastAPI()

class Creds(BaseModel):
    login: int
    password: str
    server: str

@app.post("/initialize")
async def init(creds: Creds):
    if not mt5.initialize():
        return {"status": "error", "detail": mt5.last_error()}
    authorized = mt5.login(creds.login, creds.password, creds.server)
    if not authorized:
        return {"status": "error", "detail": mt5.last_error()}
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8765)`}</pre>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Set <code className="bg-card px-1 rounded">MT5_LIB_MODE=python-bridge</code> in .env to use this path.
                  </p>
                </div>
              </div>

              {/* Architecture flow */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <span className="size-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center">4</span>
                  Trading Architecture
                </h3>
                <div className="ml-7 text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <div className="bg-card rounded-lg p-3 border border-border my-2">
                    <p className="font-mono text-center text-xs">
                      Bot Decision → AI Analysis → MT5 Direct API → MT5 Broker Server
                    </p>
                  </div>
                  <p>These bots use <strong>Deriv's WebSocket API</strong> for synthetic indices (R_10, R_25, etc.). 
                  The <strong>MT5 Direct</strong> page provides parallel access to MT5 accounts for CFDs & forex trading.</p>
                  <div className="flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-lg p-3 mt-2">
                    <Info className="size-4 text-primary shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      <strong className="text-foreground">Demo Mode:</strong> When the account type is set to 
                      <strong> "Local Simulated"</strong>, trades are executed in-memory without real money. 
                      Use this to test strategies before switching to Deriv demo or real accounts.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Subcomponents ── */

function MiniStat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div className="bg-card/50 rounded-lg px-2.5 py-1.5 border border-border/60">
      <div className="flex items-center gap-1 text-muted-foreground mb-0.5">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p
        className={`text-sm font-semibold numeric ${
          tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [expanded, setExpanded] = useState(false);

  const actionColors: Record<string, string> = {
    SCAN: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    SKIP: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    ENTRY: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    EXIT: entry.pnl && entry.pnl > 0
      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
      : "bg-red-500/15 text-red-400 border-red-500/30",
    ERROR: "bg-red-500/15 text-red-400 border-red-500/30",
    PROTECTION: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  };

  const directionColors: Record<string, string> = {
    CALL: "text-bull",
    PUT: "text-bear",
    NONE: "text-muted-foreground",
    "—": "text-muted-foreground",
  };

  return (
    <div className="bg-card/40 rounded-lg border border-border/40 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 text-xs hover:bg-card/60 transition-colors"
      >
        {/* Time */}
        <span className="text-muted-foreground numeric w-16 text-left shrink-0">
          {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>

        {/* Action badge */}
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${actionColors[entry.action] ?? ""} w-20 text-center shrink-0`}>
          {entry.action}
        </span>

        {/* Direction */}
        <span className={`font-semibold w-10 text-left shrink-0 ${directionColors[entry.direction] ?? ""}`}>
          {entry.direction}
        </span>

        {/* Confidence */}
        <span className="numeric w-10 text-left shrink-0">
          {entry.confidence > 0 ? `${(entry.confidence * 100).toFixed(0)}%` : "—"}
        </span>

        {/* Stake */}
        <span className="numeric w-12 text-left shrink-0">
          {entry.stake != null ? `$${entry.stake.toFixed(2)}` : "—"}
        </span>

        {/* P&L */}
        <span className={`numeric w-14 text-left shrink-0 font-semibold ${
          entry.pnl != null ? (entry.pnl >= 0 ? "text-bull" : "text-bear") : ""
        }`}>
          {entry.pnl != null ? `${entry.pnl >= 0 ? "+" : ""}${entry.pnl.toFixed(2)}` : "—"}
        </span>

        {/* Reasoning (truncated) */}
        <span className="text-muted-foreground truncate flex-1 text-left">
          {entry.reasoning.length > 80 ? entry.reasoning.slice(0, 80) + "…" : entry.reasoning}
        </span>

        {/* Expand icon */}
        {expanded ? (
          <ChevronUp className="size-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="size-3 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-border/30 pt-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
            <DetailCell label="Entry Price" value={entry.entryPrice?.toFixed(4) ?? "—"} />
            <DetailCell label="Stop Loss" value={entry.stopLoss?.toFixed(4) ?? "—"} />
            <DetailCell label="Take Profit" value={entry.takeProfit?.toFixed(4) ?? "—"} />
            <DetailCell label="Duration" value={entry.duration ?? "—"} />
            <DetailCell label="Trend" value={entry.trend?.toUpperCase() ?? "—"} />
            <DetailCell label="EMA 20" value={entry.ema20?.toFixed(4) ?? "—"} />
            <DetailCell label="EMA 50" value={entry.ema50?.toFixed(4) ?? "—"} />
            <DetailCell label="RSI 14" value={entry.rsi14?.toFixed(1) ?? "—"} />
            <DetailCell label="ATR 14" value={entry.atr14?.toFixed(5) ?? "—"} />
            <DetailCell label="Risk Check" value={entry.riskCheck ?? "—"} />
            <div className="col-span-2">
              <DetailCell label="Order Block" value={entry.obZone ?? "None"} />
            </div>
            <div className="col-span-2">
              <DetailCell label="Fair Value Gap" value={entry.fvgZone ?? "None"} />
            </div>
          </div>
          <div className="mt-2 pt-2 border-t border-border/30">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">AI Reasoning</p>
            <p className="text-xs text-foreground/80 leading-relaxed">{entry.reasoning}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-xs font-mono mt-0.5">{value}</p>
    </div>
  );
}

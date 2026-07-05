import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Plug,
  PlugZap,
  Activity,
  Wallet,
  Clock,
  RefreshCw,
  BarChart3,
  ExternalLink,
  Info,
  Play,
  Square,
  Shield,
  ChevronDown,
  ChevronUp,
  Zap,
  Trash2,
} from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import {
  mt5Connect,
  mt5Disconnect,
  mt5AccountInfo,
  mt5Status,
  mt5PerformanceReport,
} from "@/mt5-direct/api";
import { mt5StartBot, mt5ListBots, mt5RunBotTick } from "@/mt5-direct/bot.functions";
import {
  stopBot,
  listBotActivity,
  listOpenBotPositions,
  resetBotStats,
} from "@/lib/bots/bots.functions";
import type { Mt5AccountInfo, Mt5PerformanceReport } from "@/mt5-direct/types";

export const Route = createFileRoute("/_authenticated/mt5-direct")({
  head: () => ({ meta: [{ title: "MT5 Direct — AI Bots on MetaTrader 5" }] }),
  component: Mt5DirectPage,
});

interface BotRow {
  id: string;
  symbol: string;
  timeframe: string;
  status: string;
  interval_seconds: number;
  min_confidence: number;
  max_stake_per_trade: number;
  min_stake_per_trade: number;
  total_trades: number;
  total_pnl: number;
  wins?: number;
  losses?: number;
  locked_stake?: number;
  floating_pnl?: number;
  current_price?: number | null;
  last_tick_at: string | null;
  last_error: string | null;
  account_balance?: number;
  ai_config?: { volume?: number };
}

interface OpenPos {
  id: string;
  direction: "CALL" | "PUT";
  stake: number;
  entry_price: number;
  current_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  floating_pnl: number;
  external_contract_id: string | null;
  opened_at: string;
}

interface ActivityEntry {
  id: string;
  timestamp: number;
  action: string;
  symbol: string;
  direction: string;
  confidence: number;
  entryPrice: number | null;
  stake: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  pnl: number | null;
  reasoning: string;
  obZone: string | null;
  fvgZone: string | null;
  riskCheck: string | null;
}

const MT5_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "USDCAD",
  "XAUUSD",
  "BTCUSD",
  "ETHUSD",
  // Volatility Indices (all have tradeMode=shortonly on Deriv)
  "Volatility 10 Index",
  "Volatility 25 Index",
  "Volatility 50 Index",
  "Volatility 75 Index",
  "Volatility 100 Index",
  "Volatility 5 Index",
  "Volatility 15 Index",
  "Volatility 30 Index",
  "Volatility 90 Index",
  // 1s Volatility Indices
  "Volatility 10 (1s) Index",
  "Volatility 15 (1s) Index",
  "Volatility 25 (1s) Index",
  "Volatility 30 (1s) Index",
  "Volatility 50 (1s) Index",
  "Volatility 75 (1s) Index",
  "Volatility 90 (1s) Index",
  "Volatility 100 (1s) Index",
  "Volatility 150 (1s) Index",
  "Volatility 250 (1s) Index",
  // Other Deriv indices
  "Crash 150 Index",
  "Boom 150 Index",
  "Crash 500 Index",
  "Boom 500 Index",
  "Crash 1000 Index",
  "Boom 1000 Index",
];

// Rough per-trade $ risk estimate: lots × pipValue × pipsOfSL. We assume 1.5×ATR SL and use
// conservative pip-value defaults per symbol family (real value comes from MT5 broker at fill).
function estimateRisk(lots: number, symbol: string): string {
  const s = symbol.toLowerCase();
  const isJpy = s.includes("jpy");
  const isGold = s.includes("xau");
  const isBtc = s.includes("btc");
  const isVol = s.includes("volatility") || s.includes("crash") || s.includes("boom");
  // pip $ per 1.0 lot approximations
  let pipValue = 10; // majors
  let assumedPips = 20; // 1.5*ATR ≈ 20 pips on 1m majors
  if (isJpy) {
    pipValue = 9;
    assumedPips = 20;
  }
  if (isGold) {
    pipValue = 10;
    assumedPips = 30;
  }
  if (isBtc) {
    pipValue = 1;
    assumedPips = 200;
  }
  if (isVol) {
    pipValue = 1;
    assumedPips = 40;
  }
  const risk = lots * pipValue * assumedPips;
  return `$${risk.toFixed(2)}`;
}

function Mt5DirectPage() {
  const fnConnect = useServerFn(mt5Connect);
  const fnDisconnect = useServerFn(mt5Disconnect);
  const fnAccount = useServerFn(mt5AccountInfo);
  const fnStatus = useServerFn(mt5Status);
  const fnReport = useServerFn(mt5PerformanceReport);
  const fnStart = useServerFn(mt5StartBot);
  const fnList = useServerFn(mt5ListBots);
  const fnTick = useServerFn(mt5RunBotTick);
  const fnStop = useServerFn(stopBot);
  const fnActivity = useServerFn(listBotActivity);
  const fnPositions = useServerFn(listOpenBotPositions);
  const fnReset = useServerFn(resetBotStats);

  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<Mt5AccountInfo | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [bots, setBots] = useState<BotRow[]>([]);
  const [report, setReport] = useState<Mt5PerformanceReport | null>(null);
  const [activity, setActivity] = useState<Map<string, ActivityEntry[]>>(new Map());
  const [positions, setPositions] = useState<Map<string, OpenPos[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const loopsRef = useRef<Map<string, number>>(new Map());

  const [form, setForm] = useState({
    symbol: "EURUSD",
    interval_seconds: 60,
    min_confidence: 0.7,
    max_stake_per_trade: 50, // kept for backend compat; not surfaced in UI
    min_stake_per_trade: 1,
    account_balance: 1000,
    volume: 0.01,
    account_type: "demo" as "demo" | "real",
    strategy_mode: "ob-fvg" as "qwen" | "ob-fvg" | "ob-fvg-strict",
  });

  // ── Data loading ──
  const mapActivity = (r: any): ActivityEntry => ({
    id: r.id,
    timestamp: new Date(r.created_at).getTime(),
    action: r.action,
    symbol: r.symbol,
    direction: r.direction ?? "—",
    confidence: Number(r.confidence ?? 0),
    entryPrice: r.entry_price == null ? null : Number(r.entry_price),
    stake: r.stake == null ? null : Number(r.stake),
    stopLoss: r.stop_loss == null ? null : Number(r.stop_loss),
    takeProfit: r.take_profit == null ? null : Number(r.take_profit),
    pnl: r.pnl == null ? null : Number(r.pnl),
    reasoning: r.reasoning,
    obZone: r.ob_zone ?? null,
    fvgZone: r.fvg_zone ?? null,
    riskCheck: r.risk_check ?? null,
  });

  const refreshBot = async (botId: string) => {
    const [acts, pos] = await Promise.all([
      fnActivity({ data: { bot_id: botId, limit: 100 } }) as Promise<any[]>,
      fnPositions({ data: { bot_id: botId } }) as Promise<any[]>,
    ]);
    setActivity((prev) => {
      const next = new Map(prev);
      next.set(botId, acts.map(mapActivity));
      return next;
    });
    setPositions((prev) => {
      const next = new Map(prev);
      next.set(
        botId,
        pos.map((p) => ({
          id: p.id,
          direction: p.direction,
          stake: Number(p.stake ?? 0),
          entry_price: Number(p.entry_price ?? 0),
          current_price: p.current_price == null ? null : Number(p.current_price),
          stop_loss: p.stop_loss == null ? null : Number(p.stop_loss),
          take_profit: p.take_profit == null ? null : Number(p.take_profit),
          floating_pnl: Number(p.floating_pnl ?? 0),
          external_contract_id: p.external_contract_id ?? null,
          opened_at: p.opened_at,
        })),
      );
      return next;
    });
  };

  const loadBots = async () => {
    const rows = (await fnList()) as BotRow[];
    setBots(rows);
    const brokerReport = await fnReport();
    if (!("error" in brokerReport)) {
      setReport(brokerReport as Mt5PerformanceReport);
      setAccount((brokerReport as Mt5PerformanceReport).account);
    }
    await Promise.all(rows.slice(0, 20).map((b) => refreshBot(b.id).catch(() => {})));
  };

  useEffect(() => {
    fnStatus().then((s) => {
      if (s.connected) {
        setConnected(true);
        if (s.account) setAccount(s.account);
      }
    });
    loadBots();
    return () => {
      loopsRef.current.forEach((id) => clearInterval(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Connection ──
  const connect = useCallback(async () => {
    setConnecting(true);
    const s = await fnConnect();
    if (s.connected) {
      setConnected(true);
      setAccount(s.account ?? null);
      toast.success("Connected to MT5");
    } else {
      toast.error("Connection failed", { description: s.error });
    }
    setConnecting(false);
  }, [fnConnect]);

  const disconnect = useCallback(async () => {
    await fnDisconnect();
    setConnected(false);
    setAccount(null);
    toast.message("Disconnected");
  }, [fnDisconnect]);

  const refreshAccount = useCallback(async () => {
    const info = await fnAccount();
    if ("error" in info) toast.error(info.error);
    else setAccount(info as Mt5AccountInfo);
  }, [fnAccount]);

  // ── Bot loop ──
  const runTick = async (bot: BotRow) => {
    try {
      const res = (await fnTick({ data: { id: bot.id } })) as any;
      if (!res?.ok && res?.error) {
        toast.error(`${bot.symbol}: ${res.error}`, { duration: 3000 });
      }
      await refreshBot(bot.id);
      await loadBots();
    } catch (e: any) {
      toast.error(e?.message ?? "Tick failed");
    }
  };

  const startLoop = (bot: BotRow) => {
    if (loopsRef.current.has(bot.id)) return;
    runTick(bot);
    const handle = window.setInterval(() => runTick(bot), bot.interval_seconds * 1000);
    loopsRef.current.set(bot.id, handle);
  };

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
    if (!connected) {
      toast.error("Connect to MT5 first");
      return;
    }
    if (form.account_type === "real") {
      if (
        !confirm("Start an MT5 bot on a REAL account? This will place live trades with real money.")
      )
        return;
    }
    try {
      const row = (await fnStart({ data: form })) as BotRow;
      setBots((p) => [row, ...p]);
      toast.success(`MT5 bot started on ${row.symbol}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to start bot");
    }
  };

  const onStop = async (id: string) => {
    const h = loopsRef.current.get(id);
    if (h) {
      clearInterval(h);
      loopsRef.current.delete(id);
    }
    await fnStop({ data: { id } });
    loadBots();
    toast.message("Bot stopped");
  };

  const onReset = async (id: string) => {
    if (!confirm("Reset trade stats & P&L for this bot?")) return;
    await fnReset({ data: { id } });
    toast.success("Stats reset");
    loadBots();
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const getStats = (bot: BotRow) => {
    const logs = activity.get(bot.id) ?? [];
    const trades = logs.filter((l) => l.action === "EXIT");
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const scans = logs.filter((l) => l.action === "SCAN").length;
    const entries = logs.filter((l) => l.action === "ENTRY").length;
    const errors = logs.filter((l) => l.action === "ERROR").length;
    return { wins, losses, winRate, scans, entries, errors, trades: trades.length };
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <ExternalLink className="size-5 text-primary" /> MT5 Direct — AI Bots
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              OB+FVG strategy runs on MT5 candles, chooses direction, SL &amp; TP, and executes
              through the MetaTrader 5 bridge with a locked stake.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {connected ? (
              <>
                <Badge variant="default" className="gap-1">
                  <Activity className="size-3" /> Connected
                </Badge>
                <Button size="sm" variant="outline" onClick={refreshAccount} className="gap-1">
                  <RefreshCw className="size-3.5" /> Refresh
                </Button>
                <Button size="sm" variant="destructive" onClick={disconnect} className="gap-1">
                  <PlugZap className="size-3.5" /> Disconnect
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={connect} disabled={connecting} className="gap-1">
                <Plug className="size-3.5" />
                {connecting ? "Connecting…" : "Connect to MT5"}
              </Button>
            )}
          </div>
        </header>

        {!connected && (
          <div className="glass rounded-xl p-8 text-center space-y-2">
            <p className="text-muted-foreground">
              Click "Connect to MT5" to open the bridge session using your{" "}
              <code className="bg-card px-1 rounded">MT5_ACCOUNT_LOGIN / PASSWORD / SERVER</code>{" "}
              env vars.
            </p>
            <p className="text-xs text-muted-foreground">
              Bots need an active MT5 connection to fetch candles and place orders.
            </p>
          </div>
        )}

        {connected && account && (
          <div className="glass rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Wallet className="size-3.5 text-primary" /> MT5 Account
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <InfoBadge label="Server" value={account.server} />
              <InfoBadge label="Name" value={account.name} />
              <InfoBadge label="Currency" value={account.currency} />
              <InfoBadge label="Leverage" value={`1:${account.leverage}`} />
              <InfoBadge
                label="Balance"
                value={`$${account.balance.toFixed(2)}`}
                tone={account.balance >= 0 ? "bull" : "bear"}
              />
              <InfoBadge
                label="Equity"
                value={`$${account.equity.toFixed(2)}`}
                tone={account.equity >= 0 ? "bull" : "bear"}
              />
              <InfoBadge label="Margin" value={`$${account.margin.toFixed(2)}`} />
              <InfoBadge
                label="Free Margin"
                value={`$${account.marginFree.toFixed(2)}`}
                tone={account.marginFree > 0 ? "bull" : "bear"}
              />
            </div>
          </div>
        )}

        {/* ── New MT5 Bot ── */}
        <div className="glass rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Zap className="size-3.5 text-primary" /> New MT5 Bot
          </h2>
          <p className="text-xs text-muted-foreground -mt-2">
            Multi-strategy engine (OB+FVG · Momentum · Mean-Reversion) with hard institutional
            gates, HTF alignment, loss-streak brake, and optional Qwen AI overlay. Position sizing
            is by
            <span className="text-primary font-medium"> lots</span> — dollar risk is derived from
            your SL distance × MT5 pip value.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">Symbol</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={form.symbol}
                onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              >
                {MT5_SYMBOLS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Account</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={form.account_type}
                onChange={(e) =>
                  setForm({ ...form, account_type: e.target.value as "demo" | "real" })
                }
              >
                <option value="demo">Demo</option>
                <option value="real">Real (live money)</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Interval (sec)</Label>
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
                step={0.05}
                min={0}
                max={1}
                value={form.min_confidence}
                onChange={(e) => setForm({ ...form, min_confidence: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className="text-xs">Volume (lots)</Label>
              <Input
                type="number"
                step={0.01}
                min={0.01}
                value={form.volume}
                onChange={(e) => setForm({ ...form, volume: Number(e.target.value) })}
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                ≈ risk/trade:{" "}
                <span className="text-foreground">{estimateRisk(form.volume, form.symbol)}</span>{" "}
                (1.5·ATR SL)
              </p>
            </div>
            <div>
              <Label className="text-xs">Strategy Mode</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={form.strategy_mode}
                onChange={(e) => setForm({ ...form, strategy_mode: e.target.value as any })}
              >
                <option value="all">All Strategies (Ensemble)</option>
                <option value="multi">Multi-Strategy (Top 3)</option>
                <option value="titan1">TITAN1 (Elite Confluence)</option>
                <option value="titan2">TITAN2 (Adaptive Momentum)</option>
                <option value="msnr-crt">MSNR + CRT</option>
                <option value="apa">APA</option>
                <option value="liquidity-sweep">Liquidity Sweep</option>
                <option value="ob-fvg">OB + FVG</option>
                <option value="ob-fvg-strict">OB + FVG (Strict)</option>
                <option value="vol-expansion">Vol Expansion</option>
                <option value="wyckoff">Wyckoff</option>
                <option value="momentum">Momentum</option>
                <option value="mean-reversion">Mean Reversion</option>
                <option value="ote">ICT OTE</option>
                <option value="fractal">Fractal BOS/CHOCH</option>
                <option value="dynamic-sr">Dynamic S/R</option>
                <option value="bb-rsi">BB + RSI</option>
                <option value="qwen">Qwen AI (requires API)</option>
              </select>
            </div>
          </div>
          <Button onClick={onCreate} className="gap-1.5">
            <Play className="size-3.5" /> Start MT5 Bot
          </Button>
        </div>

        {/* ── Running Bots ── */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <BarChart3 className="size-3.5 text-primary" /> Your MT5 Bots ({bots.length})
          </h2>

          {bots.length === 0 && (
            <div className="glass rounded-xl p-6 text-center text-sm text-muted-foreground">
              No MT5 bots yet — create one above.
            </div>
          )}

          {bots.map((bot) => {
            const stats = getStats(bot);
            const isOpen = expanded.has(bot.id);
            const logs = activity.get(bot.id) ?? [];
            const pos = positions.get(bot.id) ?? [];
            const balance = Number(bot.account_balance ?? 0);
            const locked = Number(bot.locked_stake ?? 0);
            const brokerOpen = report?.openPositions ?? [];
            const floating = brokerOpen.reduce((s, p) => s + Number(p.profit ?? 0), 0);
            const brokerPnl = report?.netProfit ?? Number(bot.total_pnl ?? 0);
            const available = report?.account.marginFree ?? balance + brokerPnl - locked;
            const equity = report?.account.equity ?? available + locked + floating;
            const truthStats = report
              ? {
                  trades: report.totalTrades,
                  wins: report.wins,
                  losses: report.losses,
                  winRate: report.winRate,
                }
              : stats;
            return (
              <div key={bot.id} className="glass rounded-xl overflow-hidden">
                <div className="p-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Badge
                      variant={bot.status === "running" ? "default" : "secondary"}
                      className="gap-1"
                    >
                      {bot.status === "running" ? (
                        <Activity className="size-3" />
                      ) : (
                        <Square className="size-3" />
                      )}
                      {bot.status}
                    </Badge>
                    <span className="font-semibold text-sm">{bot.symbol}</span>
                    <span className="text-xs text-muted-foreground">
                      {bot.timeframe} · every {bot.interval_seconds}s
                    </span>
                    <span className="text-xs text-muted-foreground">
                      min conf {(bot.min_confidence * 100).toFixed(0)}%
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {bot.ai_config?.volume ?? 0.01} lots
                    </span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {(bot as any).strategy_mode === "qwen"
                        ? "Qwen AI"
                        : (bot as any).strategy_mode === "ob-fvg-strict"
                          ? "OB+FVG strict"
                          : "Multi-Strategy"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggleExpand(bot.id)}
                      className="h-7 gap-1 text-xs"
                    >
                      {isOpen ? (
                        <ChevronUp className="size-3" />
                      ) : (
                        <ChevronDown className="size-3" />
                      )}
                      Details
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onReset(bot.id)}
                      className="h-7 gap-1 text-xs"
                    >
                      <Trash2 className="size-3" /> Reset
                    </Button>
                    {bot.status === "running" ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => onStop(bot.id)}
                        className="h-7 gap-1 text-xs"
                      >
                        <Square className="size-3" /> Stop
                      </Button>
                    ) : null}
                  </div>
                </div>

                {/* stats row */}
                <div className="grid grid-cols-2 md:grid-cols-6 gap-2 px-4 pb-3">
                  <MetaCell label="Balance" value={`$${balance.toFixed(2)}`} />
                  <MetaCell
                    label="Available"
                    value={`$${available.toFixed(2)}`}
                    tone={available >= balance ? "bull" : "bear"}
                  />
                  <MetaCell label="Locked" value={`$${locked.toFixed(2)}`} />
                  <MetaCell
                    label="Open P&L"
                    value={`${floating >= 0 ? "+" : ""}$${floating.toFixed(2)}`}
                    tone={floating >= 0 ? "bull" : "bear"}
                  />
                  <MetaCell
                    label="Total P&L"
                    value={`${brokerPnl >= 0 ? "+" : ""}$${brokerPnl.toFixed(2)}`}
                    tone={brokerPnl >= 0 ? "bull" : "bear"}
                  />
                  <MetaCell label="Equity" value={`$${equity.toFixed(2)}`} />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-6 gap-2 px-4 pb-4">
                  <MetaCell label="Trades" value={String(truthStats.trades)} />
                  <MetaCell label="Wins" value={String(truthStats.wins)} tone="bull" />
                  <MetaCell label="Losses" value={String(truthStats.losses)} tone="bear" />
                  <MetaCell label="Win rate" value={`${truthStats.winRate.toFixed(0)}%`} />
                  <MetaCell label="Scans" value={String(stats.scans)} />
                  <MetaCell
                    label="Errors"
                    value={String(stats.errors)}
                    tone={stats.errors ? "bear" : undefined}
                  />
                </div>

                {report && (
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-2 px-4 pb-4">
                    <MetaCell
                      label="Profit Factor"
                      value={report.profitFactor == null ? "∞" : report.profitFactor.toFixed(2)}
                    />
                    <MetaCell
                      label="Avg Win"
                      value={`$${report.averageWin.toFixed(2)}`}
                      tone="bull"
                    />
                    <MetaCell
                      label="Avg Loss"
                      value={`$${report.averageLoss.toFixed(2)}`}
                      tone="bear"
                    />
                    <MetaCell
                      label="Expectancy"
                      value={`$${report.expectancy.toFixed(2)}`}
                      tone={report.expectancy >= 0 ? "bull" : "bear"}
                    />
                    <MetaCell
                      label="Drawdown"
                      value={`$${report.drawdown.toFixed(2)}`}
                      tone={report.drawdown > 0 ? "bear" : undefined}
                    />
                    <MetaCell
                      label="Avg Hold"
                      value={`${Math.round(report.averageHoldingSeconds / 60)}m`}
                    />
                  </div>
                )}

                {bot.last_error && (
                  <div className="mx-4 mb-3 text-xs px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30 text-destructive">
                    Last error: {bot.last_error}
                  </div>
                )}
                {bot.last_tick_at && (
                  <div className="px-4 pb-3 text-[10px] text-muted-foreground flex items-center gap-1">
                    <Clock className="size-3" /> Last tick{" "}
                    {new Date(bot.last_tick_at).toLocaleTimeString()}
                  </div>
                )}

                {isOpen && (
                  <div className="border-t border-border/60 divide-y divide-border/60">
                    {/* Open positions */}
                    <div className="p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                        <Shield className="size-3" /> Open positions ({pos.length})
                      </h3>
                      {pos.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No open positions.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                                <th className="px-2 py-1">Ticket</th>
                                <th className="px-2 py-1">Dir</th>
                                <th className="px-2 py-1">Entry</th>
                                <th className="px-2 py-1">Now</th>
                                <th className="px-2 py-1">SL</th>
                                <th className="px-2 py-1">TP</th>
                                <th className="px-2 py-1">Stake</th>
                                <th className="px-2 py-1">Floating</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pos.map((p) => (
                                <tr key={p.id} className="border-t border-border/30">
                                  <td className="px-2 py-1 numeric">
                                    {p.external_contract_id ?? "—"}
                                  </td>
                                  <td
                                    className={`px-2 py-1 font-semibold ${p.direction === "CALL" ? "text-bull" : "text-bear"}`}
                                  >
                                    {p.direction}
                                  </td>
                                  <td className="px-2 py-1 numeric">{p.entry_price.toFixed(4)}</td>
                                  <td className="px-2 py-1 numeric">
                                    {p.current_price?.toFixed(4) ?? "—"}
                                  </td>
                                  <td className="px-2 py-1 numeric">
                                    {p.stop_loss?.toFixed(4) ?? "—"}
                                  </td>
                                  <td className="px-2 py-1 numeric">
                                    {p.take_profit?.toFixed(4) ?? "—"}
                                  </td>
                                  <td className="px-2 py-1 numeric">${p.stake.toFixed(2)}</td>
                                  <td
                                    className={`px-2 py-1 numeric font-semibold ${p.floating_pnl >= 0 ? "text-bull" : "text-bear"}`}
                                  >
                                    {p.floating_pnl >= 0 ? "+" : ""}${p.floating_pnl.toFixed(2)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    {/* Activity feed */}
                    {report && report.trades.length > 0 && (
                      <div className="p-4">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                          <BarChart3 className="size-3" /> MT5 Broker Trade Audit (
                          {report.trades.length})
                        </h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-[11px]">
                            <thead>
                              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                                <th className="px-2 py-1">Ticket</th>
                                <th className="px-2 py-1">Type</th>
                                <th className="px-2 py-1">Entry</th>
                                <th className="px-2 py-1">Exit</th>
                                <th className="px-2 py-1">SL</th>
                                <th className="px-2 py-1">TP</th>
                                <th className="px-2 py-1">RR</th>
                                <th className="px-2 py-1">MFE</th>
                                <th className="px-2 py-1">MAE</th>
                                <th className="px-2 py-1">P&L</th>
                                <th className="px-2 py-1">Reason</th>
                              </tr>
                            </thead>
                            <tbody>
                              {report.trades.slice(0, 25).map((t) => (
                                <tr
                                  key={t.positionId}
                                  className="border-t border-border/30 align-top"
                                >
                                  <td className="px-2 py-1 numeric">{t.positionId}</td>
                                  <td
                                    className={`px-2 py-1 font-semibold ${t.type === "BUY" ? "text-bull" : "text-bear"}`}
                                  >
                                    {t.type}
                                  </td>
                                  <td className="px-2 py-1 numeric">{t.entryPrice.toFixed(4)}</td>
                                  <td className="px-2 py-1 numeric">{t.exitPrice.toFixed(4)}</td>
                                  <td className="px-2 py-1 numeric">
                                    {t.stopLoss?.toFixed(4) ?? "—"}
                                  </td>
                                  <td className="px-2 py-1 numeric">
                                    {t.takeProfit?.toFixed(4) ?? "—"}
                                  </td>
                                  <td className="px-2 py-1 numeric">
                                    {t.riskRewardRatio?.toFixed(2) ?? "—"}
                                  </td>
                                  <td className="px-2 py-1 numeric">{t.mfe?.toFixed(4) ?? "—"}</td>
                                  <td className="px-2 py-1 numeric">{t.mae?.toFixed(4) ?? "—"}</td>
                                  <td
                                    className={`px-2 py-1 numeric font-semibold ${t.profit >= 0 ? "text-bull" : "text-bear"}`}
                                  >
                                    {t.profit >= 0 ? "+" : ""}${t.profit.toFixed(2)}
                                  </td>
                                  <td className="px-2 py-1 text-muted-foreground max-w-[260px]">
                                    {t.exitReason}: {t.diagnosis.join(" ")}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    <div className="p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                        <Terminal /> Activity ({logs.length})
                      </h3>
                      <div className="max-h-[420px] overflow-y-auto space-y-1">
                        {logs.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            No activity yet — waiting for the first tick.
                          </p>
                        )}
                        {logs.map((l) => (
                          <div
                            key={l.id}
                            className="text-[11px] leading-snug px-2 py-1.5 rounded bg-card/40 border border-border/30"
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-muted-foreground tabular-nums">
                                {new Date(l.timestamp).toLocaleTimeString()}
                              </span>
                              <ActionBadge action={l.action} />
                              {l.direction !== "—" && (
                                <span
                                  className={`font-semibold ${l.direction === "CALL" ? "text-bull" : l.direction === "PUT" ? "text-bear" : ""}`}
                                >
                                  {l.direction}
                                </span>
                              )}
                              <span>{(l.confidence * 100).toFixed(0)}%</span>
                              {l.entryPrice != null && (
                                <span className="numeric">@ {l.entryPrice.toFixed(4)}</span>
                              )}
                              {l.stake != null && <span>${l.stake.toFixed(2)}</span>}
                              {l.pnl != null && (
                                <span
                                  className={`font-semibold ${l.pnl >= 0 ? "text-bull" : "text-bear"}`}
                                >
                                  {l.pnl >= 0 ? "+" : ""}${l.pnl.toFixed(2)}
                                </span>
                              )}
                            </div>
                            <div className="text-muted-foreground mt-0.5">{l.reasoning}</div>
                            {l.riskCheck && (
                              <div className="text-[10px] text-muted-foreground/80 mt-0.5">
                                {l.riskCheck}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Guide */}
        <div className="glass rounded-xl p-5">
          <div className="flex items-start gap-3">
            <Info className="size-5 text-primary shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                <strong className="text-foreground">How it works:</strong> Each MT5 bot tick fetches
                candles from your broker, runs the OB+FVG engine (the same one used in the Bots page
                and the backtester), and if a setup exceeds your confidence threshold it sends a
                MetaTrader 5 market order with the analyzed stop-loss and take-profit levels. The
                lock-in stake caps the risk exposure per trade.
              </p>
              <p>
                <strong className="text-foreground">Bridge:</strong>{" "}
                <code className="bg-card px-1 rounded">MT5_LIB_MODE=python-bridge</code> +{" "}
                <code className="bg-card px-1 rounded">VITE_MT5_BRIDGE_URL</code> point to the
                FastAPI bridge that connects to your MT5 terminal.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoBadge({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div className="bg-card/50 rounded-lg px-3 py-2 border border-border/60">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={`text-sm font-semibold numeric mt-0.5 ${tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}

function MetaCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div className="bg-card/30 rounded-md px-2.5 py-1.5 border border-border/40">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={`text-xs font-semibold numeric ${tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const map: Record<string, string> = {
    SCAN: "bg-muted text-muted-foreground",
    ENTRY: "bg-primary/20 text-primary",
    EXIT: "bg-accent/20 text-accent-foreground",
    ERROR: "bg-destructive/20 text-destructive",
    SKIP: "bg-muted text-muted-foreground",
    PROTECTION: "bg-yellow-500/20 text-yellow-500",
  };
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${map[action] ?? "bg-muted"}`}
    >
      {action}
    </span>
  );
}

function Terminal() {
  return <span className="text-primary">▸</span>;
}

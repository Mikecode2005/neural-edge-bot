import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AreaChart, Area, CartesianGrid, ResponsiveContainer, XAxis, YAxis, Tooltip,
} from "recharts";
import { Play, TrendingUp, Layers } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import { getDerivWS } from "@/lib/deriv/ws";
import { DERIV_SYMBOLS } from "@/lib/deriv-ws";
import { runMultiBacktest } from "@/lib/backtest/multi-backtest.functions";

export const Route = createFileRoute("/_authenticated/strategy-lab")({
  head: () => ({ meta: [{ title: "Strategy Lab — Multi-Strategy Backtester" }] }),
  component: StrategyLabPage,
});

const TIMEFRAMES = [
  { code: "1m", value: 60 },
  { code: "2m", value: 120 },
  { code: "5m", value: 300 },
  { code: "15m", value: 900 },
];

function StrategyLabPage() {
  const fnRun = useServerFn(runMultiBacktest);
  const [symbol, setSymbol] = useState("R_10");
  const [timeframe, setTimeframe] = useState("1m");
  const [count, setCount] = useState(1500);
  const [minScore, setMinScore] = useState(70);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const ws = getDerivWS();
      const tfSecs = TIMEFRAMES.find(t => t.code === timeframe)?.value ?? 60;
      const candles = await ws.fetchCandles(symbol, tfSecs, count);
      if (candles.length < 220) { toast.error("Not enough candles"); return; }
      const res = await fnRun({ data: { symbol, timeframe, candles, minScore, riskPerTrade: 1, maxHold: 20 } });
      setResult(res);
      toast.success(`Backtest done: ${res.totalTrades} trades · ${(res.winRate * 100).toFixed(1)}% wins · Net ${res.netR.toFixed(2)}R`);
    } catch (e: any) {
      toast.error(e.message ?? "Backtest failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <Toaster />
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Layers className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold">Strategy Lab</h1>
            <p className="text-sm text-muted-foreground">Regime-aware multi-strategy confluence backtester · tracks per-strategy performance</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <Label className="text-xs">Symbol</Label>
              <select className="w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={symbol} onChange={e => setSymbol(e.target.value)}>
                {DERIV_SYMBOLS.map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs">Timeframe</Label>
              <select className="w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={timeframe} onChange={e => setTimeframe(e.target.value)}>
                {TIMEFRAMES.map(t => <option key={t.code} value={t.code}>{t.code}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs">Candles</Label>
              <Input type="number" value={count} onChange={e => setCount(+e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Min Score</Label>
              <Input type="number" min={50} max={100} value={minScore} onChange={e => setMinScore(+e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button onClick={run} disabled={running} className="w-full gap-2">
                <Play className="size-4" /> {running ? "Running..." : "Run Backtest"}
              </Button>
            </div>
          </div>
        </div>

        {result && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Stat label="Total Trades" value={result.totalTrades} />
              <Stat label="Win Rate" value={`${(result.winRate * 100).toFixed(1)}%`} accent={result.winRate >= 0.55 ? "green" : "red"} />
              <Stat label="Net R" value={`${result.netR.toFixed(2)}R`} accent={result.netR >= 0 ? "green" : "red"} />
              <Stat label="Max DD (R)" value={result.maxDrawdownR.toFixed(2)} accent="red" />
              <Stat label="Wins / Losses" value={`${result.totalWins} / ${result.totalLosses}`} />
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-sm font-semibold mb-3 flex items-center gap-2"><TrendingUp className="size-4" /> Equity Curve (R units)</div>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={result.equity}>
                  <defs>
                    <linearGradient id="eq" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="t" tickFormatter={t => new Date(t * 1000).toLocaleTimeString()} tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                  <Area dataKey="equity" stroke="hsl(var(--primary))" fill="url(#eq)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-sm font-semibold mb-3">Per-Strategy Performance</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="text-left border-b border-border">
                      <th className="py-2 pr-3">Strategy</th>
                      <th className="py-2 pr-3">Trades</th>
                      <th className="py-2 pr-3">Wins</th>
                      <th className="py-2 pr-3">Losses</th>
                      <th className="py-2 pr-3">Win %</th>
                      <th className="py-2 pr-3">Avg R</th>
                      <th className="py-2 pr-3">Net R</th>
                      <th className="py-2 pr-3">PF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(result.byStrategy).map(([k, v]: any) => (
                      <tr key={k} className="border-b border-border/50">
                        <td className="py-2 pr-3"><Badge variant="secondary" className="capitalize">{k}</Badge></td>
                        <td className="py-2 pr-3">{v.trades}</td>
                        <td className="py-2 pr-3 text-emerald-500">{v.wins}</td>
                        <td className="py-2 pr-3 text-red-500">{v.losses}</td>
                        <td className="py-2 pr-3">{(v.winRate * 100).toFixed(1)}%</td>
                        <td className={`py-2 pr-3 ${v.avgR >= 0 ? "text-emerald-500" : "text-red-500"}`}>{v.avgR.toFixed(2)}</td>
                        <td className={`py-2 pr-3 ${v.netR >= 0 ? "text-emerald-500" : "text-red-500"}`}>{v.netR.toFixed(2)}</td>
                        <td className="py-2 pr-3">{v.profitFactor == null ? "—" : v.profitFactor === Infinity ? "∞" : v.profitFactor.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-sm font-semibold mb-3">Last {Math.min(result.trades.length, 50)} Trades</div>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground sticky top-0 bg-card">
                    <tr className="text-left border-b border-border">
                      <th className="py-2 pr-3">Time</th>
                      <th className="py-2 pr-3">Strategy</th>
                      <th className="py-2 pr-3">Regime</th>
                      <th className="py-2 pr-3">Dir</th>
                      <th className="py-2 pr-3">Score</th>
                      <th className="py-2 pr-3">Entry → Exit</th>
                      <th className="py-2 pr-3">R</th>
                      <th className="py-2 pr-3">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.slice(-50).reverse().map((t: SimTrade, i: number) => (
                      <tr key={i} className="border-b border-border/40">
                        <td className="py-1.5 pr-3">{new Date(t.entryEpoch * 1000).toLocaleTimeString()}</td>
                        <td className="py-1.5 pr-3"><Badge variant="outline" className="text-[10px]">{t.strategy}</Badge></td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{t.regime}</td>
                        <td className={`py-1.5 pr-3 font-semibold ${t.dir === "BUY" ? "text-emerald-500" : "text-red-500"}`}>{t.dir}</td>
                        <td className="py-1.5 pr-3">{t.score.toFixed(0)}</td>
                        <td className="py-1.5 pr-3">{t.entry.toFixed(4)} → {t.exit.toFixed(4)}</td>
                        <td className={`py-1.5 pr-3 font-mono ${t.rMultiple >= 0 ? "text-emerald-500" : "text-red-500"}`}>{t.rMultiple.toFixed(2)}R</td>
                        <td className="py-1.5 pr-3">
                          <Badge variant={t.outcome === "win" ? "default" : "destructive"} className="text-[10px]">{t.outcome}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface SimTrade {
  strategy: string;
  regime: string;
  dir: "BUY" | "SELL";
  entryEpoch: number;
  exitEpoch: number;
  entry: number;
  exit: number;
  score: number;
  rMultiple: number;
  outcome: string;
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: "green" | "red" }) {
  const color = accent === "green" ? "text-emerald-500" : accent === "red" ? "text-red-500" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

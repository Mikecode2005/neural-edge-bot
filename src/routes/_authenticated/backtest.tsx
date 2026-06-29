import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AreaChart,
  Area,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import { getDerivWS } from "@/lib/deriv/ws";
import { analyze } from "@/lib/ob-fvg";
import { DERIV_SYMBOLS } from "@/lib/deriv-ws";
import { saveBacktest, listBacktests } from "@/lib/backtest/backtest.functions";

export const Route = createFileRoute("/_authenticated/backtest")({
  head: () => ({ meta: [{ title: "Backtest — AI Trading" }] }),
  component: BacktestPage,
});

interface Trade {
  t: number;
  side: "BUY" | "SELL";
  entry: number;
  exit: number;
  pnl: number;
}

function BacktestPage() {
  const fnSave = useServerFn(saveBacktest);
  const fnList = useServerFn(listBacktests);

  const [symbol, setSymbol] = useState("R_10");
  const [count, setCount] = useState(500);
  const [minConfidence, setMinConfidence] = useState(0.65);
  const [stake, setStake] = useState(1);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [equity, setEquity] = useState<{ t: number; equity: number }[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [history, setHistory] = useState<any[]>([]);

  useEffect(() => {
    fnList().then(setHistory).catch(() => {});
  }, [fnList]);

  const run = async () => {
    setRunning(true);
    setEquity([]);
    setTrades([]);
    setProgress(0);
    try {
      const ws = getDerivWS();
      const candles = await ws.fetchCandles(symbol, 60, count);
      if (candles.length < 60) {
        toast.error("Not enough historical candles");
        return;
      }
      const startingBalance = 1000;
      let balance = startingBalance;
      const localTrades: Trade[] = [];
      const curve: { t: number; equity: number }[] = [
        { t: candles[60].epoch, equity: balance },
      ];

      // Walk forward — at each candle, run analyze() on the prior window,
      // simulate a rise/fall over 5 candles, use confidence-gated entry.
      let openIdx: number | null = null;
      let openSide: "BUY" | "SELL" | null = null;
      let openEntry = 0;

      for (let i = 60; i < candles.length - 5; i++) {
        const window = candles.slice(Math.max(0, i - 60), i + 1);
        const a = analyze(window);
        const c = candles[i];

        // settle any open trade after 5 bars
        if (openIdx != null && openSide && i - openIdx >= 5) {
          const exit = candles[i].close;
          const dir = openSide === "BUY" ? 1 : -1;
          const win = (exit - openEntry) * dir > 0;
          const pnl = win ? stake * 0.85 : -stake; // typical Deriv rise/fall payout ~1.85x
          balance += pnl;
          localTrades.push({
            t: candles[openIdx].epoch,
            side: openSide,
            entry: openEntry,
            exit,
            pnl,
          });
          curve.push({ t: c.epoch, equity: balance });
          openIdx = null;
          openSide = null;
        }

        if (openIdx == null && a.decision !== "WAIT" && a.confidence >= minConfidence) {
          openIdx = i;
          openSide = a.decision;
          openEntry = c.close;
        }

        if (i % 20 === 0) {
          setProgress(Math.round(((i - 60) / (candles.length - 65)) * 100));
          // yield so UI renders
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      setEquity(curve);
      setTrades(localTrades);
      const wins = localTrades.filter((t) => t.pnl > 0).length;
      const win_rate = localTrades.length ? wins / localTrades.length : 0;
      const final_pnl = balance - startingBalance;

      await fnSave({
        data: {
          symbol,
          timeframe: "1m",
          start_epoch: candles[60].epoch,
          end_epoch: candles.at(-1)!.epoch,
          starting_balance: startingBalance,
          final_balance: balance,
          final_pnl,
          win_rate,
          trades_count: localTrades.length,
          equity_curve: curve,
          trades: localTrades,
          params: { count, minConfidence, stake },
        },
      });
      toast.success(`Backtest done · ${localTrades.length} trades · ${(win_rate * 100).toFixed(0)}% wins`);
      fnList().then(setHistory).catch(() => {});
    } catch (e: any) {
      toast.error("Backtest failed", { description: e.message });
    } finally {
      setRunning(false);
      setProgress(100);
    }
  };

  const finalEquity = equity.at(-1)?.equity;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Backtest</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Replay the OB+FVG strategy on historical Deriv candles. No Deriv account required —
            uses the public candle feed.
          </p>
        </header>

        <div className="glass rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <Label className="text-xs">Symbol</Label>
              <select
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
              >
                {DERIV_SYMBOLS.map((s) => (
                  <option key={s.code} value={s.code}>{s.code}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Candles (1m)</Label>
              <Input
                type="number"
                min={120}
                max={5000}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </div>
            <div>
              <Label className="text-xs">Min confidence</Label>
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={minConfidence}
                onChange={(e) => setMinConfidence(Number(e.target.value))}
              />
            </div>
            <div>
              <Label className="text-xs">Stake per trade</Label>
              <Input
                type="number"
                step="0.5"
                value={stake}
                onChange={(e) => setStake(Number(e.target.value))}
              />
            </div>
            <div className="flex items-end">
              <Button onClick={run} disabled={running} className="w-full">
                {running ? `Running ${progress}%` : "Run backtest"}
              </Button>
            </div>
          </div>
        </div>

        {equity.length > 0 && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Trades" value={trades.length} />
              <Stat label="Win rate" value={`${winRate.toFixed(0)}%`} />
              <Stat
                label="Final equity"
                value={`$${(finalEquity ?? 0).toFixed(2)}`}
                tone={(finalEquity ?? 0) >= 1000 ? "bull" : "bear"}
              />
              <Stat
                label="PnL"
                value={`${(finalEquity ?? 1000) - 1000 >= 0 ? "+" : ""}${((finalEquity ?? 1000) - 1000).toFixed(2)}`}
                tone={(finalEquity ?? 1000) - 1000 >= 0 ? "bull" : "bear"}
              />
            </div>
            <div className="glass rounded-xl p-4 h-[360px]">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                Equity curve
              </h3>
              <ResponsiveContainer width="100%" height="92%">
                <AreaChart data={equity}>
                  <defs>
                    <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.78 0.16 200)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="oklch(0.78 0.16 200)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-grid)" strokeOpacity={0.4} vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickFormatter={(t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    stroke="var(--color-muted-foreground)"
                    fontSize={11}
                  />
                  <YAxis stroke="var(--color-muted-foreground)" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", fontSize: 12 }}
                  />
                  <Area type="monotone" dataKey="equity" stroke="oklch(0.78 0.16 200)" fill="url(#eq)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </>
        )}

        <div className="glass rounded-xl p-5">
          <h2 className="text-sm font-semibold mb-3">Past backtests</h2>
          <div className="space-y-2">
            {history.map((h) => (
              <div key={h.id} className="flex items-center justify-between text-xs py-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{h.symbol}</Badge>
                  <span className="text-muted-foreground">
                    {new Date(h.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span>{h.trades_count} trades</span>
                  <span>{((h.win_rate ?? 0) * 100).toFixed(0)}% wins</span>
                  <span className={h.final_pnl >= 0 ? "text-bull" : "text-bear"}>
                    {h.final_pnl >= 0 ? "+" : ""}{Number(h.final_pnl).toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
            {!history.length && (
              <p className="text-xs text-muted-foreground">No backtests saved yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: any; tone?: "bull" | "bear" }) {
  return (
    <div className="glass rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : ""}`}>
        {value}
      </p>
    </div>
  );
}

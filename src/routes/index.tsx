import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Activity, BarChart3, Brain, Cpu, Wallet } from "lucide-react";

import { MetricCard } from "@/components/dashboard/MetricCard";
import { SymbolSelector } from "@/components/dashboard/SymbolSelector";
import { PriceChart } from "@/components/dashboard/PriceChart";
import { AIPanel } from "@/components/dashboard/AIPanel";
import { RecentSignals } from "@/components/dashboard/RecentSignals";
import { Toaster } from "@/components/ui/sonner";

import { type Candle, getDeriv } from "@/lib/deriv-ws";
import { analyze, type LiveAnalysis } from "@/lib/ob-fvg";
import { supabase } from "@/integrations/supabase/client";
import { fmtMoney, fmtPct } from "@/lib/format";
import { openPaperTrade } from "@/lib/trade.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AI Trading Workstation" },
      {
        name: "description",
        content:
          "Autonomous AI crypto trading platform with Order Block + Fair Value Gap strategy, live Deriv feeds, and Qwen reasoning.",
      },
    ],
  }),
  component: Dashboard,
});

interface PortfolioRow {
  balance: number;
  equity: number;
  realized_pnl: number;
  open_positions: number;
}

function Dashboard() {
  const router = useRouter();
  const [symbol, setSymbol] = useState("R_10");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioRow | null>(null);
  const [pending, setPending] = useState(false);
  const lastCandleEpoch = useRef<number>(0);

  const openTrade = useServerFn(openPaperTrade);

  // Load historical candles when symbol changes
  useEffect(() => {
    let active = true;
    setCandles([]);
    setLivePrice(null);
    (async () => {
      try {
        const c = await getDeriv().fetchCandles(symbol, 60, 200);
        if (!active) return;
        setCandles(c);
        lastCandleEpoch.current = c.at(-1)?.epoch ?? 0;
        setLivePrice(c.at(-1)?.close ?? null);
      } catch (e) {
        console.error(e);
        toast.error("Could not fetch market data");
      }
    })();
    return () => {
      active = false;
    };
  }, [symbol]);

  // Subscribe to live ticks
  useEffect(() => {
    const unsub = getDeriv().subscribeTicks(symbol, (t) => {
      setLivePrice(t.quote);
      setCandles((prev) => {
        if (!prev.length) return prev;
        const bucket = Math.floor(t.epoch / 60) * 60;
        const last = prev[prev.length - 1];
        if (bucket > last.epoch) {
          const next: Candle = {
            epoch: bucket,
            open: last.close,
            high: t.quote,
            low: t.quote,
            close: t.quote,
          };
          return [...prev.slice(-199), next];
        }
        const updated: Candle = {
          ...last,
          high: Math.max(last.high, t.quote),
          low: Math.min(last.low, t.quote),
          close: t.quote,
        };
        return [...prev.slice(0, -1), updated];
      });
    });
    return unsub;
  }, [symbol]);

  // Load portfolio + subscribe to changes
  useEffect(() => {
    const fetchPortfolio = async () => {
      const { data } = await supabase
        .from("portfolio")
        .select("*")
        .eq("mode", "demo")
        .order("created_at", { ascending: true })
        .limit(1);
      if (data?.[0]) setPortfolio(data[0] as unknown as PortfolioRow);
      else
        setPortfolio({
          balance: 10000,
          equity: 10000,
          realized_pnl: 0,
          open_positions: 0,
        });
    };
    fetchPortfolio();
    const channel = supabase
      .channel("portfolio_feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "portfolio" },
        () => fetchPortfolio(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const analysis: LiveAnalysis | null = useMemo(
    () => (candles.length >= 30 ? analyze(candles) : null),
    [candles],
  );

  const handlePaperTrade = async () => {
    if (!analysis || analysis.decision === "WAIT" || !analysis.entry) return;
    setPending(true);
    try {
      const res = await openTrade({
        data: {
          symbol,
          side: analysis.decision,
          entry: analysis.entry,
          sl: analysis.sl ?? null,
          tp: analysis.tp ?? null,
          size: 100,
          confidence: analysis.confidence,
          reasoning: analysis.rationale,
          ob_zone: analysis.activeOB,
          fvg_zone: analysis.activeFVG,
        },
      });
      if (res.ok) {
        toast.success("Paper trade opened", { description: res.message });
        router.invalidate();
      } else {
        toast.error("Rejected", { description: res.message });
      }
    } catch (e) {
      toast.error("Trade failed", { description: String(e) });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="min-h-screen px-6 py-6 max-w-[1600px] mx-auto">
      <Toaster theme="dark" position="top-right" richColors />

      <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
            <Brain className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              AI Trading Workstation
            </h1>
            <p className="text-xs text-muted-foreground">
              Demo mode · Order Block + Fair Value Gap · Deriv Synthetics
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md glass">
            <span className="size-1.5 rounded-full bg-bull pulse-dot" />
            Deriv feed live
          </span>
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md glass">
            <Cpu className="size-3" /> Qwen via HF Space
          </span>
        </div>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <MetricCard
          label="Portfolio Value"
          value={fmtMoney(portfolio?.equity)}
          sublabel={`Realized P&L ${fmtMoney(portfolio?.realized_pnl)}`}
          icon={<Wallet className="size-3.5" />}
        />
        <MetricCard
          label="Open Positions"
          value={portfolio?.open_positions ?? 0}
          sublabel="Demo trades"
          icon={<Activity className="size-3.5" />}
        />
        <MetricCard
          label="AI Confidence"
          value={analysis ? fmtPct(analysis.confidence) : "—"}
          sublabel={`Decision · ${analysis?.decision ?? "—"}`}
          tone={
            analysis?.decision === "BUY"
              ? "bull"
              : analysis?.decision === "SELL"
              ? "bear"
              : "warn"
          }
          icon={<Brain className="size-3.5" />}
        />
        <MetricCard
          label="Market Trend"
          value={analysis?.trend?.toUpperCase() ?? "—"}
          sublabel={
            analysis
              ? `EMA20 ${analysis.ema20.toFixed(4)} · RSI ${analysis.rsi14.toFixed(0)}`
              : ""
          }
          tone={analysis?.trend === "up" ? "bull" : "bear"}
          icon={<BarChart3 className="size-3.5" />}
        />
      </section>

      <div className="mb-4">
        <SymbolSelector value={symbol} onChange={setSymbol} />
      </div>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <PriceChart
            candles={candles}
            analysis={analysis}
            livePrice={livePrice}
          />
        </div>
        <div className="min-h-[420px]">
          <AIPanel
            analysis={analysis}
            symbol={symbol}
            onPaperTrade={handlePaperTrade}
            pending={pending}
          />
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2 glass rounded-xl p-4">
          <h3 className="text-sm uppercase tracking-wider text-muted-foreground mb-2">
            Strategy notes
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            This dashboard runs the <strong className="text-foreground">Order Block + Fair Value Gap</strong> strategy
            client-side on live Deriv candles for instant visual feedback.
            The same algorithm runs server-side in the Hugging Face Space
            (<code className="text-xs">hf_backend/app/strategy_ob_fvg.py</code>) where Qwen 3 produces
            the final natural-language reasoning and risk plan. The Deriv API token is{" "}
            <strong className="text-foreground">never</strong> exposed to the browser — all live trade
            execution must flow through the HF backend.
          </p>
        </div>
        <div className="h-[280px]">
          <RecentSignals />
        </div>
      </section>
    </div>
  );
}

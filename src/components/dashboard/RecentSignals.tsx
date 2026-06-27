import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fmtPct, fmtPrice } from "@/lib/format";

interface Signal {
  id: string;
  symbol: string;
  decision: "BUY" | "SELL" | "WAIT";
  confidence: number;
  price: number;
  reasoning: string | null;
  created_at: string;
}

export function RecentSignals() {
  const [signals, setSignals] = useState<Signal[]>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("live_signals")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (active && data) setSignals(data as unknown as Signal[]);
    })();

    const channel = supabase
      .channel("live_signals_feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "live_signals" },
        (payload) => {
          setSignals((prev) =>
            [payload.new as unknown as Signal, ...prev].slice(0, 20),
          );
        },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="glass rounded-xl p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm uppercase tracking-wider text-muted-foreground">
          Signal Feed
        </h3>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-bull pulse-dot" />
          Live
        </div>
      </div>
      <div className="flex-1 overflow-y-auto space-y-1.5 -mx-1 px-1">
        {signals.length === 0 && (
          <div className="text-xs text-muted-foreground py-8 text-center">
            No signals yet — analysis publishes as the AI evaluates the market.
          </div>
        )}
        {signals.map((s) => {
          const tone =
            s.decision === "BUY"
              ? "text-bull"
              : s.decision === "SELL"
              ? "text-bear"
              : "text-warn";
          return (
            <div
              key={s.id}
              className="rounded-lg border border-border/60 bg-surface-2/40 px-3 py-2 flex items-center justify-between text-sm"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className={`font-semibold ${tone} w-12`}>{s.decision}</span>
                <span className="text-muted-foreground w-16">{s.symbol}</span>
                <span className="numeric text-foreground">
                  {fmtPrice(s.price, 4)}
                </span>
              </div>
              <div className="numeric text-xs text-muted-foreground">
                {fmtPct(s.confidence)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

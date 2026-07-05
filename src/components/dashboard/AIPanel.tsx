import type { LiveAnalysis } from "@/lib/ob-fvg";
import { fmtPrice, fmtPct } from "@/lib/format";
import { Brain, TrendingUp, TrendingDown, Pause } from "lucide-react";

interface Props {
  analysis: LiveAnalysis | null;
  symbol: string;
  onPaperTrade?: () => void;
  pending?: boolean;
}

const decisionIcon = {
  BUY: <TrendingUp className="size-5" />,
  SELL: <TrendingDown className="size-5" />,
  WAIT: <Pause className="size-5" />,
};

export function AIPanel({ analysis, symbol, onPaperTrade, pending }: Props) {
  if (!analysis) {
    return (
      <div className="glass rounded-xl p-5 h-full flex items-center justify-center text-muted-foreground">
        Loading market analysis…
      </div>
    );
  }

  const isBuy = analysis.decision === "BUY";
  const isSell = analysis.decision === "SELL";
  const tone = isBuy ? "bull" : isSell ? "bear" : "warn";
  const toneText = tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-warn";
  const toneBg =
    tone === "bull"
      ? "bg-bull-soft border-bull/30"
      : tone === "bear"
        ? "bg-bear-soft border-bear/30"
        : "bg-surface-2 border-border";

  return (
    <div className="glass rounded-xl p-5 h-full flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
          <Brain className="size-4 text-primary" />
          AI Reasoning · {symbol}
        </div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          OB + FVG · v1
        </span>
      </div>

      <div className={`rounded-lg border ${toneBg} p-4 flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <div className={toneText}>{decisionIcon[analysis.decision]}</div>
          <div>
            <div className={`text-2xl font-semibold ${toneText}`}>{analysis.decision}</div>
            <div className="text-xs text-muted-foreground">
              Trend {analysis.trend.toUpperCase()} · RSI {analysis.rsi14.toFixed(1)}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Confidence</div>
          <div className="numeric text-xl font-semibold">{fmtPct(analysis.confidence)}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <Stat label="Entry" value={fmtPrice(analysis.entry)} />
        <Stat label="Stop Loss" value={fmtPrice(analysis.sl)} tone="bear" />
        <Stat label="Take Profit" value={fmtPrice(analysis.tp)} tone="bull" />
      </div>

      <div className="text-sm text-muted-foreground leading-relaxed flex-1">
        {analysis.rationale}
      </div>

      <div className="grid grid-cols-4 gap-2 text-xs">
        <KV k="EMA20" v={analysis.ema20.toFixed(4)} />
        <KV k="EMA50" v={analysis.ema50.toFixed(4)} />
        <KV k="ATR14" v={analysis.atr14.toFixed(5)} />
        <KV k="FVGs" v={String(analysis.fvgs.length)} />
      </div>

      <button
        disabled={analysis.decision === "WAIT" || pending}
        onClick={onPaperTrade}
        className="w-full rounded-lg bg-primary text-primary-foreground font-medium py-2.5 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
      >
        {pending
          ? "Opening…"
          : analysis.decision === "WAIT"
            ? "No actionable setup"
            : `Open ${analysis.decision} · Paper Trade`}
      </button>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
  const t = tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-foreground";
  return (
    <div className="rounded-md bg-surface-2/60 px-3 py-2 border border-border/60">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`numeric font-semibold ${t}`}>{value}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{k}</span>
      <span className="numeric font-medium">{v}</span>
    </div>
  );
}

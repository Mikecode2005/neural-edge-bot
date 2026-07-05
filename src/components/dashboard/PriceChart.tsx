import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Candle } from "@/lib/deriv-ws";
import type { LiveAnalysis } from "@/lib/ob-fvg";
import { fmtPrice } from "@/lib/format";

interface Props {
  candles: Candle[];
  analysis: LiveAnalysis | null;
  livePrice: number | null;
}

export function PriceChart({ candles, analysis, livePrice }: Props) {
  const data = useMemo(
    () =>
      candles.map((c) => ({
        t: c.epoch,
        time: new Date(c.epoch * 1000).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        close: c.close,
      })),
    [candles],
  );

  const minY = useMemo(() => (data.length ? Math.min(...data.map((d) => d.close)) : 0), [data]);
  const maxY = useMemo(() => (data.length ? Math.max(...data.map((d) => d.close)) : 1), [data]);
  const pad = (maxY - minY) * 0.1 || 0.001;

  const obZone = analysis?.activeOB;
  const fvgZone = analysis?.activeFVG;

  return (
    <div className="glass rounded-xl p-4 h-[420px]">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm uppercase tracking-wider text-muted-foreground">Live Price</h3>
        <div className="numeric text-xl font-semibold">{fmtPrice(livePrice)}</div>
      </div>
      <ResponsiveContainer width="100%" height="88%">
        <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.78 0.16 200)" stopOpacity={0.5} />
              <stop offset="100%" stopColor="oklch(0.78 0.16 200)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-grid)" strokeOpacity={0.4} vertical={false} />
          <XAxis
            dataKey="time"
            stroke="var(--color-muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            domain={[minY - pad, maxY + pad]}
            stroke="var(--color-muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={70}
            tickFormatter={(v) => v.toFixed(3)}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-popover)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(v: number) => fmtPrice(v)}
          />
          {fvgZone && (
            <ReferenceArea
              y1={fvgZone.bottom}
              y2={fvgZone.top}
              fill={fvgZone.kind === "bullish" ? "oklch(0.78 0.18 152)" : "oklch(0.66 0.22 18)"}
              fillOpacity={0.08}
              stroke={fvgZone.kind === "bullish" ? "oklch(0.78 0.18 152)" : "oklch(0.66 0.22 18)"}
              strokeOpacity={0.35}
              strokeDasharray="3 3"
              label={{
                value: `${fvgZone.kind.toUpperCase()} FVG`,
                position: "insideTopRight",
                fill: "var(--color-muted-foreground)",
                fontSize: 10,
              }}
            />
          )}
          {obZone && (
            <ReferenceArea
              y1={obZone.bottom}
              y2={obZone.top}
              fill={obZone.kind === "bullish" ? "oklch(0.78 0.18 152)" : "oklch(0.66 0.22 18)"}
              fillOpacity={0.18}
              stroke={obZone.kind === "bullish" ? "oklch(0.78 0.18 152)" : "oklch(0.66 0.22 18)"}
              strokeOpacity={0.7}
              label={{
                value: `${obZone.kind.toUpperCase()} OB`,
                position: "insideBottomRight",
                fill: "var(--color-foreground)",
                fontSize: 10,
              }}
            />
          )}
          {analysis?.entry && (
            <ReferenceLine
              y={analysis.entry}
              stroke="var(--color-primary)"
              strokeDasharray="2 4"
              label={{
                value: "Entry",
                fill: "var(--color-primary)",
                fontSize: 10,
                position: "right",
              }}
            />
          )}
          {analysis?.sl && (
            <ReferenceLine
              y={analysis.sl}
              stroke="var(--color-bear)"
              strokeDasharray="2 4"
              label={{ value: "SL", fill: "var(--color-bear)", fontSize: 10, position: "right" }}
            />
          )}
          {analysis?.tp && (
            <ReferenceLine
              y={analysis.tp}
              stroke="var(--color-bull)"
              strokeDasharray="2 4"
              label={{ value: "TP", fill: "var(--color-bull)", fontSize: 10, position: "right" }}
            />
          )}
          <Area
            type="monotone"
            dataKey="close"
            stroke="oklch(0.78 0.16 200)"
            strokeWidth={1.5}
            fill="url(#priceFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

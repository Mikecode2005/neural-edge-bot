import type { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  tone?: "default" | "bull" | "bear" | "warn";
  icon?: ReactNode;
}

const toneClass = {
  default: "text-foreground",
  bull: "text-bull",
  bear: "text-bear",
  warn: "text-warn",
};

export function MetricCard({ label, value, sublabel, tone = "default", icon }: Props) {
  return (
    <div className="glass rounded-xl p-4 flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        {icon}
      </div>
      <div className={`numeric text-2xl font-semibold ${toneClass[tone]}`}>
        {value}
      </div>
      {sublabel && (
        <div className="text-xs text-muted-foreground">{sublabel}</div>
      )}
    </div>
  );
}

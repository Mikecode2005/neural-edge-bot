import { DERIV_SYMBOLS } from "@/lib/deriv-ws";

interface Props {
  value: string;
  onChange: (s: string) => void;
}

export function SymbolSelector({ value, onChange }: Props) {
  return (
    <div className="glass rounded-xl p-2 flex flex-wrap gap-1">
      {DERIV_SYMBOLS.map((s) => {
        const active = s.code === value;
        return (
          <button
            key={s.code}
            onClick={() => onChange(s.code)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              active
                ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                : "text-muted-foreground hover:text-foreground hover:bg-surface-2"
            }`}
            title={s.label}
          >
            {s.code}
          </button>
        );
      })}
    </div>
  );
}

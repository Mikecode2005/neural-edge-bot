import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Brain, LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

const items = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/bots", label: "Bots" },
  { to: "/backtest", label: "Backtest" },
  { to: "/mt5-direct", label: "MT5 Direct" },
  { to: "/memory", label: "Memory" },
  { to: "/chat", label: "Chat" },
] as const;

export function AppNav() {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="flex items-center justify-between gap-4 px-6 py-3 border-b border-border bg-background/80 backdrop-blur sticky top-0 z-30">
      <Link to="/dashboard" className="flex items-center gap-2">
        <div className="size-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
          <Brain className="size-4 text-primary" />
        </div>
        <div className="text-sm font-semibold tracking-tight">AI Trader</div>
      </Link>
      <div className="flex items-center gap-1">
        {items.map((it) => {
          const active = path === it.to || path.startsWith(it.to + "/");
          return (
            <Link
              key={it.to}
              to={it.to}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-card"
              }`}
            >
              {it.label}
            </Link>
          );
        })}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="gap-1"
        onClick={async () => {
          await supabase.auth.signOut();
          navigate({ to: "/auth" });
        }}
      >
        <LogOut className="size-3.5" /> Sign out
      </Button>
    </nav>
  );
}

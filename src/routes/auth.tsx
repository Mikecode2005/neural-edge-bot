import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — AI Trading Workstation" },
      { name: "description", content: "Sign in to the AI-powered autonomous Deriv trading workstation." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  const onEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const fn =
        mode === "signin"
          ? supabase.auth.signInWithPassword({ email, password })
          : supabase.auth.signUp({
              email,
              password,
              options: { emailRedirectTo: `${window.location.origin}/dashboard` },
            });
      const { error } = await fn;
      if (error) throw error;
      toast.success(mode === "signin" ? "Welcome back" : "Account created");
      navigate({ to: "/dashboard" });
    } catch (e: any) {
      toast.error(e.message ?? "Auth failed");
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async () => {
    setBusy(true);
    try {
      const res = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: `${window.location.origin}/auth`,
      });
      if (res.error) {
        toast.error("Google sign-in failed");
        setBusy(false);
        return;
      }
      if (res.redirected) return;
      navigate({ to: "/dashboard" });
    } catch (e: any) {
      toast.error(e.message ?? "Sign-in failed");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Toaster theme="dark" position="top-right" richColors />
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 justify-center mb-8">
          <div className="size-10 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
            <Brain className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight">AI Trading Workstation</h1>
            <p className="text-xs text-muted-foreground">Autonomous Deriv trader</p>
          </div>
        </div>

        <div className="glass rounded-xl p-6 border border-border">
          <h2 className="text-lg font-semibold mb-1">
            {mode === "signin" ? "Sign in" : "Create account"}
          </h2>
          <p className="text-xs text-muted-foreground mb-5">
            {mode === "signin"
              ? "Welcome back. Sign in to access your AI trader."
              : "Start trading with AI in under a minute."}
          </p>

          <Button onClick={onGoogle} disabled={busy} variant="outline" className="w-full mb-4">
            Continue with Google
          </Button>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
            <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
              <span className="bg-card px-2 text-muted-foreground">or email</span>
            </div>
          </div>

          <form onSubmit={onEmailSubmit} className="space-y-3">
            <div>
              <Label htmlFor="email" className="text-xs">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password" className="text-xs">Password</Label>
              <Input id="password" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <button
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="mt-4 text-xs text-muted-foreground hover:text-foreground w-full text-center"
          >
            {mode === "signin" ? "Need an account? Sign up" : "Already have one? Sign in"}
          </button>
        </div>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          By continuing you agree to trade only on demo accounts until you explicitly enable real-money trading. <Link to="/" className="underline">Home</Link>
        </p>
      </div>
    </div>
  );
}

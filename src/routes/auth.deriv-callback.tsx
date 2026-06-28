import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { parseDerivCallback } from "@/lib/deriv/oauth";
import { saveDerivConnections } from "@/lib/deriv/connections.functions";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/auth/deriv-callback")({
  component: DerivCallback,
});

function DerivCallback() {
  const navigate = useNavigate();
  const save = useServerFn(saveDerivConnections);
  const [msg, setMsg] = useState("Connecting your Deriv account…");

  useEffect(() => {
    (async () => {
      const accounts = parseDerivCallback(window.location.search);
      if (!accounts.length) {
        setMsg("No Deriv tokens found in callback URL.");
        toast.error("Deriv did not return any account tokens");
        setTimeout(() => navigate({ to: "/dashboard" }), 1500);
        return;
      }
      try {
        // Prefer first demo as active
        const demo = accounts.find((a) => a.account_type === "demo");
        await save({
          data: {
            accounts,
            activate_loginid: demo?.loginid ?? accounts[0].loginid,
          },
        });
        toast.success(`Linked ${accounts.length} Deriv account${accounts.length > 1 ? "s" : ""}`);
        navigate({ to: "/dashboard" });
      } catch (e: any) {
        toast.error(e.message ?? "Failed to save accounts");
        setMsg("Failed to link account. Returning to dashboard…");
        setTimeout(() => navigate({ to: "/dashboard" }), 2000);
      }
    })();
  }, [navigate, save]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <div className="text-center">
        <Loader2 className="size-6 animate-spin mx-auto mb-3 text-primary" />
        <p className="text-sm text-muted-foreground">{msg}</p>
      </div>
    </div>
  );
}

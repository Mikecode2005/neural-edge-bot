/**
 * Server functions for managing the user's Deriv account connections.
 * Tokens are encrypted at rest and only returned (in plaintext) to the
 * authenticated owning user.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const AccountInput = z.object({
  loginid: z.string().min(2),
  token: z.string().min(10),
  currency: z.string().default("USD"),
  account_type: z.enum(["demo", "real"]),
});

const SaveInput = z.object({
  accounts: z.array(AccountInput).min(1),
  activate_loginid: z.string().optional(),
});

export const saveDerivConnections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }) => {
    const { encryptToken } = await import("./crypto.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const userId = context.userId;
    const rows = data.accounts.map((a) => ({
      user_id: userId,
      loginid: a.loginid,
      account_type: a.account_type,
      currency: a.currency,
      access_token_encrypted: encryptToken(a.token),
      is_active: data.activate_loginid
        ? a.loginid === data.activate_loginid
        : a.account_type === "demo", // default to first demo account
    }));

    // Deactivate all existing first
    await supabaseAdmin
      .from("deriv_connections")
      .update({ is_active: false })
      .eq("user_id", userId);

    const { error } = await supabaseAdmin
      .from("deriv_connections")
      .upsert(rows, { onConflict: "user_id,loginid" });
    if (error) throw new Error(error.message);
    return { ok: true, count: rows.length };
  });

export const listDerivAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("deriv_connections")
      .select("id, loginid, account_type, currency, balance, is_active, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const setActiveDerivAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ loginid: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("deriv_connections")
      .update({ is_active: false })
      .eq("user_id", context.userId);
    const { error } = await supabaseAdmin
      .from("deriv_connections")
      .update({ is_active: true })
      .eq("user_id", context.userId)
      .eq("loginid", data.loginid);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Returns the active account's plaintext token. Authorized user only. */
export const getActiveDerivToken = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { decryptToken } = await import("./crypto.server");
    const { data, error } = await supabaseAdmin
      .from("deriv_connections")
      .select("loginid, account_type, currency, access_token_encrypted")
      .eq("user_id", context.userId)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      loginid: data.loginid,
      account_type: data.account_type as "demo" | "real",
      currency: data.currency,
      token: decryptToken(data.access_token_encrypted),
    };
  });

export const disconnectDeriv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("deriv_connections")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

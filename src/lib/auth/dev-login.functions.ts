/**
 * Dev-only "instant sign-in" server function.
 * Gated by:
 *   - VITE_ENABLE_DEV_LOGIN=true (client gate so the button only renders in dev/preview)
 *   - DEV_AUTOLOGIN_EMAIL / DEV_AUTOLOGIN_PASSWORD secrets on the server
 *
 * Returns the email so the browser can call supabase.auth.signInWithPassword
 * directly (the password is only read server-side; never sent to the client).
 *
 * NOTE: never put a password in the client bundle. The browser must request a
 * one-time challenge from this fn; the fn signs the user in via the admin
 * client and returns a magic link / OTP. To keep things simple we proxy the
 * actual sign-in here using the admin client + email, returning a session.
 */
import { createServerFn } from "@tanstack/react-start";

export const devGenerateSession = createServerFn({ method: "POST" }).handler(async () => {
  const email = process.env.DEV_AUTOLOGIN_EMAIL;
  const password = process.env.DEV_AUTOLOGIN_PASSWORD;
  if (!email || !password) throw new Error("Dev login not configured");

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Ensure the user exists (idempotent).
  await supabaseAdmin.auth.admin
    .createUser({ email, password, email_confirm: true })
    .catch(() => undefined);

  // Generate a magic link the browser can use to mint a session without
  // exposing the password.
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error) throw new Error(error.message);
  const hashed_token = (data?.properties as any)?.hashed_token;
  if (!hashed_token) throw new Error("Could not generate dev sign-in link");
  return { email, hashed_token, type: "magiclink" as const };
});

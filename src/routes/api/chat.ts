/**
 * Streaming chat endpoint backed by HF Router (Qwen 2.5 7B Instruct) via the
 * AI SDK OpenAI-compatible provider so the UI-message stream protocol matches
 * what @ai-sdk/react's useChat expects.
 *
 * Auth: validates the Supabase JWT from the Authorization header so we can
 * personalise the system prompt with the user's balance, settings, and lessons.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

async function verifyUser(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const url = process.env.SUPABASE_URL!;
  const apikey = process.env.SUPABASE_PUBLISHABLE_KEY!;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j?.id ?? null;
}

async function buildSystemPrompt(userId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [settingsRes, memRes, balRes, tradesRes] = await Promise.all([
    supabaseAdmin.from("settings").select("*").eq("user_id", userId).maybeSingle(),
    supabaseAdmin
      .from("strategy_memory")
      .select("lesson, outcome, usefulness_score, pinned")
      .eq("user_id", userId)
      .order("pinned", { ascending: false })
      .order("usefulness_score", { ascending: false })
      .limit(8),
    supabaseAdmin
      .from("deriv_connections")
      .select("balance, currency, account_type, loginid")
      .eq("user_id", userId)
      .eq("is_active", true)
      .maybeSingle(),
    supabaseAdmin
      .from("trade_history")
      .select("pnl, status")
      .eq("user_id", userId)
      .gte("opened_at", new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString()),
  ]);
  const s = settingsRes.data;
  const bal = balRes.data;
  const pnlToday = (tradesRes.data ?? []).reduce((a, r) => a + Number(r.pnl ?? 0), 0);
  const lessons =
    (memRes.data ?? []).map((m, i) => `${i + 1}. ${m.lesson}`).join("\n") || "(none yet)";

  return `You are the user's AI trading coach for the Order Block + Fair Value Gap strategy on Deriv synthetic indices.
You can answer plain questions, plan their bankroll, set risk rules, and explain trades. Be concise, warm, and concrete. Use short bullet lists. Skip disclaimer boilerplate.

USER STATE
- Active account: ${bal?.loginid ?? "not linked"} (${bal?.account_type ?? "—"}, ${bal?.currency ?? "USD"})
- Balance: ${bal?.balance ?? "unknown"}
- PnL today (UTC): ${pnlToday.toFixed(2)}
- Min confidence to trade: ${s?.min_confidence ?? 0.7}
- Max stake per trade: ${s?.max_stake ?? 10}
- Risk percent: ${s?.risk_percent ?? 1}
- Max daily loss: ${s?.max_daily_loss ?? 500}
- Confidence→stake curve: ${JSON.stringify(s?.confidence_stake_curve ?? [])}
- Custom doctrine override: ${s?.custom_doctrine ? "yes" : "no"}

RECALLED LESSONS
${lessons}

If the user gives you a new bankroll or risk preference, propose exact values for min_confidence, max_stake, and max_daily_loss and tell them to save from the Memory page.`;
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const userId = await verifyUser(request);
          if (!userId) return new Response("Unauthorized", { status: 401 });

          const token = process.env.HF_TOKEN;
          if (!token) return new Response("HF_TOKEN not configured", { status: 500 });

          const body = (await request.json()) as { messages: UIMessage[] };
          const sys = await buildSystemPrompt(userId);

          const provider = createOpenAICompatible({
            name: "hf-router",
            baseURL: "https://router.huggingface.co/v1",
            apiKey: token,
          });
          const model = provider.chatModel(
            process.env.HF_MODEL ?? "Qwen/Qwen2.5-7B-Instruct:together",
          );

          const result = streamText({
            model,
            system: sys,
            messages: await convertToModelMessages(body.messages),
            temperature: 0.4,
          });

          return result.toUIMessageStreamResponse({ originalMessages: body.messages });
        } catch (e: any) {
          return new Response(`Chat error: ${e?.message ?? "unknown"}`, { status: 500 });
        }
      },
    },
  },
});

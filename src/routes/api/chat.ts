/**
 * Streaming chat endpoint backed by HF Router (Qwen 2.5 7B Instruct).
 * Uses OpenAI-compatible /v1/chat/completions with stream:true and forwards
 * SSE chunks as an AI SDK UIMessage stream so the AI Elements <Conversation>
 * renders tokens live.
 *
 * Auth: validates the Supabase JWT from the Authorization header so the
 * thread/lesson context belongs to the right user.
 */
import { createFileRoute } from "@tanstack/react-router";

type UIPart = { type: "text"; text: string } | { type: string; [k: string]: any };
type UIMessage = { id?: string; role: "user" | "assistant" | "system"; parts?: UIPart[]; content?: string };

function partsToText(m: UIMessage): string {
  if (Array.isArray(m.parts)) {
    return m.parts
      .map((p) => (p.type === "text" ? (p as any).text : ""))
      .join("");
  }
  return m.content ?? "";
}

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
  const lessons = (memRes.data ?? []).map((m, i) => `${i + 1}. ${m.lesson}`).join("\n") || "(none)";

  return `You are the user's AI trading coach for the OB+FVG strategy on Deriv synthetic indices.
You can answer plain questions about markets, plan their bankroll, set risk rules, and explain trades.
Be concise, warm, and concrete. Use bullets. Avoid disclaimers boilerplate.

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

If the user gives a new bankroll or risk preference, suggest exact values for min_confidence, max_stake, max_daily_loss and tell them to update from Settings or say "save these".`;
}

async function streamFromHF(messages: { role: string; content: string }[]) {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error("HF_TOKEN not configured");
  const res = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.HF_MODEL ?? "Qwen/Qwen2.5-7B-Instruct:together",
      messages,
      temperature: 0.4,
      max_tokens: 800,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HF ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.body;
}

/** Convert an OpenAI SSE stream → AI SDK UI message stream chunks. */
function toUIMessageStream(openaiSse: ReadableStream<Uint8Array>): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const msgId = crypto.randomUUID();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      send({ type: "start", messageId: msgId });
      send({ type: "text-start", id: msgId });
      const reader = openaiSse.getReader();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length) {
                send({ type: "text-delta", id: msgId, delta });
              }
            } catch {
              /* ignore */
            }
          }
        }
      } catch (e: any) {
        send({ type: "error", errorText: e?.message ?? "stream error" });
      }
      send({ type: "text-end", id: msgId });
      send({ type: "finish" });
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const userId = await verifyUser(request);
          if (!userId) return new Response("Unauthorized", { status: 401 });
          const body = (await request.json()) as { messages: UIMessage[] };
          const sys = await buildSystemPrompt(userId);
          const oaMsgs = [
            { role: "system", content: sys },
            ...body.messages.map((m) => ({ role: m.role, content: partsToText(m) })),
          ];
          const sse = await streamFromHF(oaMsgs);
          return toUIMessageStream(sse);
        } catch (e: any) {
          return new Response(`Chat error: ${e?.message ?? "unknown"}`, { status: 500 });
        }
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/bot-loop")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
        if (!expected || apikey !== expected) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        const { processDueBots } = await import("@/lib/bots/bot-loop.server");
        const result = await processDueBots(12);
        return Response.json({ ok: true, ...result, at: new Date().toISOString() });
      },
      GET: async () => Response.json({ ok: true, service: "bot-loop" }),
    },
  },
});

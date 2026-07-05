import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listMemory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("strategy_memory")
      .select("*")
      .eq("user_id", context.userId)
      .order("pinned", { ascending: false })
      .order("usefulness_score", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const updateMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        lesson: z.string().min(3).optional(),
        tags: z.array(z.string()).optional(),
        usefulness_score: z.number().min(0).max(10).optional(),
        pinned: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { id, ...patch } = data;
    const { error } = await supabaseAdmin
      .from("strategy_memory")
      .update(patch)
      .eq("id", id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("strategy_memory")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const addMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        lesson: z.string().min(3),
        symbol: z.string().optional(),
        timeframe: z.string().optional(),
        tags: z.array(z.string()).default([]),
        pinned: z.boolean().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error, data: row } = await supabaseAdmin
      .from("strategy_memory")
      .insert({
        user_id: context.userId,
        lesson: data.lesson,
        symbol: data.symbol ?? null,
        timeframe: data.timeframe ?? null,
        setup_type: "OB+FVG",
        outcome: "observation",
        tags: data.tags,
        pinned: data.pinned,
        usefulness_score: data.pinned ? 5 : 1,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const getSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let { data } = await supabaseAdmin
      .from("settings")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!data) {
      const ins = await supabaseAdmin
        .from("settings")
        .insert({ user_id: context.userId })
        .select()
        .single();
      data = ins.data;
    }
    return data;
  });

export const updateSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        min_confidence: z.number().min(0).max(1).optional(),
        max_stake: z.number().positive().optional(),
        max_trades_per_day: z.number().int().positive().optional(),
        max_daily_loss: z.number().positive().optional(),
        default_interval_seconds: z.number().int().min(10).max(3600).optional(),
        account_mode: z.enum(["demo", "real"]).optional(),
        custom_doctrine: z.string().nullable().optional(),
        confidence_stake_curve: z.array(z.object({ min: z.number(), pct: z.number() })).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("settings")
      .update(data)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

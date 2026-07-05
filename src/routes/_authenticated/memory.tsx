import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Pin, Trash2, Plus, Save } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import {
  listMemory,
  updateMemory,
  deleteMemory,
  addMemory,
  getSettings,
  updateSettings,
} from "@/lib/strategy/memory.functions";

export const Route = createFileRoute("/_authenticated/memory")({
  head: () => ({ meta: [{ title: "Strategy Memory — AI Trading" }] }),
  component: MemoryPage,
});

interface Row {
  id: string;
  lesson: string;
  symbol: string | null;
  timeframe: string | null;
  setup_type: string | null;
  outcome: string | null;
  pnl: number | null;
  tags: string[] | null;
  usefulness_score: number;
  times_recalled: number;
  pinned: boolean;
  created_at: string;
}

function MemoryPage() {
  const fnList = useServerFn(listMemory);
  const fnUpdate = useServerFn(updateMemory);
  const fnDelete = useServerFn(deleteMemory);
  const fnAdd = useServerFn(addMemory);
  const fnGetSettings = useServerFn(getSettings);
  const fnUpdateSettings = useServerFn(updateSettings);

  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState("");
  const [newLesson, setNewLesson] = useState("");
  const [doctrine, setDoctrine] = useState("");
  const [settingsId, setSettingsId] = useState<string | null>(null);

  const load = async () => {
    const r = (await fnList()) as Row[];
    setRows(r);
    const s = (await fnGetSettings()) as any;
    setDoctrine(s?.custom_doctrine ?? "");
    setSettingsId(s?.id ?? null);
  };
  useEffect(() => {
    load();
  }, []);

  const filtered = rows.filter((r) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      r.lesson.toLowerCase().includes(q) ||
      r.symbol?.toLowerCase().includes(q) ||
      r.tags?.some((t) => t.toLowerCase().includes(q))
    );
  });

  const onSave = async (r: Row) => {
    await fnUpdate({
      data: {
        id: r.id,
        lesson: r.lesson,
        tags: r.tags ?? [],
        usefulness_score: r.usefulness_score,
        pinned: r.pinned,
      },
    });
    toast.success("Lesson saved");
  };

  const onDelete = async (id: string) => {
    await fnDelete({ data: { id } });
    setRows((p) => p.filter((x) => x.id !== id));
  };

  const onAdd = async () => {
    if (!newLesson.trim()) return;
    const row = (await fnAdd({ data: { lesson: newLesson.trim(), pinned: true } })) as Row;
    setRows((p) => [row, ...p]);
    setNewLesson("");
  };

  const onSaveDoctrine = async () => {
    await fnUpdateSettings({ data: { custom_doctrine: doctrine || null } });
    toast.success("Doctrine override saved");
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Strategy Memory</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Lessons the AI recalls before every trade. Edit, pin, or remove them. Pinned lessons get
            top priority in the prompt.
          </p>
        </header>

        <div className="glass rounded-xl p-5">
          <h2 className="text-sm font-semibold mb-3">Doctrine override (system prompt addition)</h2>
          <Textarea
            value={doctrine}
            onChange={(e) => setDoctrine(e.target.value)}
            rows={5}
            placeholder="Optional. Anything written here is appended to the OB+FVG doctrine before every AI call. Example: 'Never trade between 22:00 and 02:00 UTC.'"
          />
          <Button size="sm" className="mt-3 gap-1.5" onClick={onSaveDoctrine}>
            <Save className="size-3.5" /> Save doctrine
          </Button>
        </div>

        <div className="glass rounded-xl p-5">
          <h2 className="text-sm font-semibold mb-3">Add a pinned lesson</h2>
          <div className="flex gap-2">
            <Input
              value={newLesson}
              onChange={(e) => setNewLesson(e.target.value)}
              placeholder="e.g. Skip V25 between 13:30-14:30 UTC, news volatility ruins OB."
            />
            <Button onClick={onAdd} className="gap-1.5">
              <Plus className="size-3.5" /> Pin
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <Input
            placeholder="Search lessons, symbols, tags…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-xs"
          />
          <p className="text-xs text-muted-foreground">
            {filtered.length} of {rows.length}
          </p>
        </div>

        <div className="space-y-3">
          {filtered.map((r) => (
            <MemoryCard
              key={r.id}
              row={r}
              onChange={(patch) =>
                setRows((p) => p.map((x) => (x.id === r.id ? { ...x, ...patch } : x)))
              }
              onSave={() => onSave(r)}
              onDelete={() => onDelete(r.id)}
            />
          ))}
          {!filtered.length && (
            <p className="text-sm text-muted-foreground text-center py-12">
              No lessons yet. The AI will record them as it trades and learns.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function MemoryCard({
  row,
  onChange,
  onSave,
  onDelete,
}: {
  row: Row;
  onChange: (p: Partial<Row>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="glass rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          {row.pinned && <Badge variant="default">Pinned</Badge>}
          {row.outcome && (
            <Badge
              variant={
                row.outcome === "win"
                  ? "default"
                  : row.outcome === "loss"
                    ? "destructive"
                    : "secondary"
              }
            >
              {row.outcome}
            </Badge>
          )}
          {row.symbol && <Badge variant="outline">{row.symbol}</Badge>}
          <span className="text-muted-foreground">
            score {row.usefulness_score.toFixed(2)} · recalled {row.times_recalled}×
          </span>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => onChange({ pinned: !row.pinned })}>
            <Pin className={`size-3.5 ${row.pinned ? "text-primary" : ""}`} />
          </Button>
          <Button size="sm" variant="ghost" onClick={onSave}>
            <Save className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <Textarea
        value={row.lesson}
        onChange={(e) => onChange({ lesson: e.target.value })}
        rows={3}
      />
      <div className="flex items-center gap-2">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Score</Label>
        <Input
          type="number"
          step="0.1"
          min="0"
          max="10"
          value={row.usefulness_score}
          onChange={(e) => onChange({ usefulness_score: Number(e.target.value) })}
          className="w-24"
        />
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wider ml-3">
          Tags
        </Label>
        <Input
          value={(row.tags ?? []).join(", ")}
          onChange={(e) =>
            onChange({
              tags: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="comma, separated"
        />
      </div>
    </div>
  );
}

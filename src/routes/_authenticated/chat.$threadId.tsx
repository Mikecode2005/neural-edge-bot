import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Send, Trash2 } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";

import {
  listThreads,
  createThread,
  deleteThread,
  getThreadMessages,
  appendMessage,
} from "@/lib/chat/chat.functions";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  head: () => ({ meta: [{ title: "Chat — AI Trading Coach" }] }),
  component: ChatThread,
});

type Thread = { id: string; title: string; updated_at: string };

function ChatThread() {
  const { threadId } = useParams({ from: "/_authenticated/chat/$threadId" });
  const navigate = useNavigate();
  const fnList = useServerFn(listThreads);
  const fnCreate = useServerFn(createThread);
  const fnDelete = useServerFn(deleteThread);
  const fnGet = useServerFn(getThreadMessages);
  const fnAppend = useServerFn(appendMessage);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [initial, setInitial] = useState<UIMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [bearer, setBearer] = useState<string | null>(null);
  const lastSaved = useRef<Set<string>>(new Set());

  // Load bearer once (for streaming endpoint auth)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setBearer(data.session?.access_token ?? null));
  }, []);

  // Threads
  const reloadThreads = async () => setThreads((await fnList()) as Thread[]);
  useEffect(() => {
    reloadThreads();
  }, []);

  // Thread messages
  useEffect(() => {
    setLoaded(false);
    setInitial([]);
    lastSaved.current = new Set();
    fnGet({ data: { thread_id: threadId } }).then((rows: any[]) => {
      const msgs: UIMessage[] = rows.map((r) => ({
        id: r.id,
        role: r.role,
        parts: r.parts as any,
      }));
      msgs.forEach((m) => lastSaved.current.add(m.id!));
      setInitial(msgs);
      setLoaded(true);
    });
  }, [threadId, fnGet]);

  if (!loaded || !bearer) {
    return (
      <div className="min-h-screen bg-background">
        <AppNav />
        <div className="p-10 text-sm text-muted-foreground">Loading conversation…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-6xl mx-auto px-4 py-4 grid grid-cols-12 gap-4">
        <aside className="col-span-3 glass rounded-xl p-3 space-y-1 h-[calc(100vh-110px)] overflow-y-auto">
          <Button
            size="sm"
            className="w-full gap-1.5 mb-2"
            onClick={async () => {
              const t = (await fnCreate({ data: { title: "New chat" } })) as Thread;
              setThreads((p) => [t, ...p]);
              navigate({ to: "/chat/$threadId", params: { threadId: t.id } });
            }}
          >
            <Plus className="size-3.5" /> New chat
          </Button>
          {threads.map((t) => {
            const active = t.id === threadId;
            return (
              <div
                key={t.id}
                className={`flex items-center gap-1 group rounded-md ${active ? "bg-primary/15" : "hover:bg-card"}`}
              >
                <button
                  className="flex-1 text-left text-xs px-2 py-1.5 truncate"
                  onClick={() => navigate({ to: "/chat/$threadId", params: { threadId: t.id } })}
                >
                  {t.title}
                </button>
                <button
                  className="opacity-0 group-hover:opacity-100 px-1 text-muted-foreground hover:text-bear"
                  onClick={async () => {
                    await fnDelete({ data: { id: t.id } });
                    const remaining = threads.filter((x) => x.id !== t.id);
                    setThreads(remaining);
                    if (active) {
                      if (remaining.length) {
                        navigate({ to: "/chat/$threadId", params: { threadId: remaining[0].id } });
                      } else navigate({ to: "/chat" });
                    }
                  }}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            );
          })}
        </aside>

        <main className="col-span-9">
          <ChatPane
            key={threadId}
            threadId={threadId}
            bearer={bearer}
            initial={initial}
            onPersist={async (m) => {
              if (!m.id || lastSaved.current.has(m.id)) return;
              try {
                await fnAppend({
                  data: { thread_id: threadId, role: m.role as any, parts: m.parts as any },
                });
                lastSaved.current.add(m.id);
              } catch (e: any) {
                toast.error("Save failed", { description: e.message });
              }
            }}
            input={input}
            setInput={setInput}
          />
        </main>
      </div>
    </div>
  );
}

function ChatPane({
  threadId,
  bearer,
  initial,
  onPersist,
  input,
  setInput,
}: {
  threadId: string;
  bearer: string;
  initial: UIMessage[];
  onPersist: (m: UIMessage) => Promise<void>;
  input: string;
  setInput: (s: string) => void;
}) {
  const transport = new DefaultChatTransport({
    api: "/api/chat",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const { messages, sendMessage, status } = useChat({
    id: threadId,
    messages: initial,
    transport,
    onError: (e) => toast.error(e.message),
  });

  // Persist on stream completion
  useEffect(() => {
    if (status === "ready" && messages.length) {
      const last = messages[messages.length - 1];
      void onPersist(last);
      // Also persist the immediately-preceding user msg if not saved.
      const prev = messages[messages.length - 2];
      if (prev) void onPersist(prev);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || status === "submitted" || status === "streaming") return;
    setInput("");
    await sendMessage({ text });
  };

  return (
    <div className="glass rounded-xl h-[calc(100vh-110px)] flex flex-col">
      <Conversation className="flex-1">
        <ConversationContent>
          {messages.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-12">
              Tell me your bankroll and risk preferences. <br />
              Example: <em>"I have $500. Plan my week. Only trade when confidence ≥ 0.8."</em>
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} from={m.role as any}>
              <MessageContent>
                {m.parts.map((p: any, i: number) =>
                  p.type === "text" ? <span key={i}>{p.text}</span> : null,
                )}
              </MessageContent>
            </Message>
          ))}
          {status === "submitted" && (
            <Message from="assistant">
              <MessageContent>
                <Shimmer>Thinking…</Shimmer>
              </MessageContent>
            </Message>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <form onSubmit={submit} className="border-t border-border p-3 flex gap-2 items-end">
        <Textarea
          autoFocus
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Ask your AI trading coach…"
          className="resize-none"
        />
        <Button
          type="submit"
          size="icon"
          disabled={!input.trim() || status === "submitted" || status === "streaming"}
        >
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  );
}

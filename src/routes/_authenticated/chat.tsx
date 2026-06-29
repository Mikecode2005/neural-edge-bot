import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createThread, listThreads } from "@/lib/chat/chat.functions";

export const Route = createFileRoute("/_authenticated/chat")({
  component: ChatIndex,
});

function ChatIndex() {
  const navigate = useNavigate();
  const fnList = useServerFn(listThreads);
  const fnCreate = useServerFn(createThread);

  useEffect(() => {
    (async () => {
      const ts = (await fnList()) as any[];
      if (ts.length) {
        navigate({ to: "/chat/$threadId", params: { threadId: ts[0].id } });
      } else {
        const t = (await fnCreate({ data: { title: "New chat" } })) as any;
        navigate({ to: "/chat/$threadId", params: { threadId: t.id } });
      }
    })();
  }, [fnList, fnCreate, navigate]);

  return null;
}

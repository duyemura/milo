import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button } from "@pushpress/pushpress-ui";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  effects?: { type: string; ok: boolean; detail: string }[];
  suggestedReplies?: string[];
}

interface Suggestion {
  id: string;
  title: string;
  actionType: "launch-site" | "investigate-job" | "deploy-staging";
  actionPayload: Record<string, string>;
  hint: string;
}

interface ManualTodo {
  id: string;
  title: string;
  status: "open" | "done" | "dismissed";
  assignee: string;
  createdAt: string;
}

const ACTION_LABEL: Record<string, string> = {
  "launch-site": "Launch now",
  "deploy-staging": "Launch now",
  "investigate-job": "Investigate",
  "follow-up": "Nudge client",
};

const ACTION_MESSAGE: Record<string, (p: Record<string, string>) => string> = {
  "launch-site": (p) => `launch ${p["companyName"] ?? "this site"}`,
  "deploy-staging": (p) => `launch ${p["companyName"] ?? "this site"}`,
  "investigate-job": (p) => `investigate the failed job for ${p["companyName"] ?? "this site"}`,
  "follow-up": (p) => `task: nudge ${p["companyName"] ?? "the client"} to approve their staging site`,
};

export function ChatPage() {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      role: "assistant",
      content:
        "What do you want to get done? I can launch or rebuild sites, push staging to production, move sites through the pipeline, and track tasks for the team. Try “launch Torrance Training Lab”.",
    },
  ]);
  const [input, setInput] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  const QUICK_ACTIONS: { label: string; message: string }[] = [
    { label: "Add new client", message: "Add a new client" },
    { label: "Add new website to client", message: "Add a new website to a client" },
    { label: "Add new task", message: "Add a new task" },
  ];

  const { data: todosData } = useQuery({
    queryKey: ["todos"],
    queryFn: async () => {
      const res = await fetch("/api/v1/todos");
      return (await res.json()) as { suggestions: Suggestion[]; todos: ManualTodo[] };
    },
    refetchInterval: 4000,
  });

  const send = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch("/api/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history: messages.slice(-10).map(({ role, content }) => ({ role, content })) }),
      });
      return (await res.json()) as { reply: string; effects: ChatMsg["effects"]; suggestedReplies?: string[] };
    },
    onSuccess: (data, message) => {
      setMessages((m) => [
        ...m.slice(0, -1),
        { role: "user", content: message },
        { role: "assistant", content: data.reply, effects: data.effects, suggestedReplies: data.suggestedReplies },
      ]);
      void qc.invalidateQueries();
    },
  });

  const completeTodo = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/v1/todos/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["todos"] }),
  });

  // Synchronous in-flight gate: send.isPending is React state (async) and lets
  // two same-frame clicks double-fire the request. A ref blocks the second one.
  const inFlight = useRef(false);
  const dispatch = (text: string) => {
    const t = text.trim();
    if (!t || inFlight.current) return;
    inFlight.current = true;
    setMessages((m) => [...m, { role: "user", content: t }, { role: "assistant", content: "…" }]);
    setInput("");
    send.mutate(t, {
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages]);

  const suggestions = todosData?.suggestions ?? [];
  const todos = (todosData?.todos ?? []).filter((t) => t.status === "open");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content !== "…");

  return (
    <div className="chat-grid">
      <section className="chat-rail">
        <div className="thread" ref={threadRef}>
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="bubble">{m.content}</div>
              {m.effects?.map((e, j) => (
                <div key={j} className="effect">
                  <Badge className={`${e.ok ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"} text-xs`}>
                    {e.ok ? "done" : "failed"}
                  </Badge>
                  <span className="muted small">{e.detail}</span>
                </div>
              ))}
              {m.role === "assistant" && i === messages.length - 1 && (m.suggestedReplies ?? []).length > 0 && (
                <div className="reply-chips">
                  {(m.suggestedReplies ?? []).map((s, k) => (
                    <button key={k} className="chip" onClick={() => dispatch(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="quick-actions">
          {QUICK_ACTIONS.map((a) => (
            <button key={a.label} className="chip" disabled={send.isPending} onClick={() => dispatch(a.message)}>
              {a.label}
            </button>
          ))}
        </div>
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            dispatch(input);
          }}
        >
          <div className="ghost-wrap">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Tab completes the ghost suggestion (Claude-style).
                const ghost = lastAssistant?.suggestedReplies?.[0];
                if (e.key === "Tab" && ghost && !input) {
                  e.preventDefault();
                  setInput(ghost);
                }
              }}
              placeholder={send.isPending ? "Working…" : "Tell me what to do…"}
              autoFocus
            />
            {!input && lastAssistant?.suggestedReplies?.[0] && (
              <span className="ghost">
                {lastAssistant.suggestedReplies[0]}
                <em>&nbsp;⭾</em>
              </span>
            )}
          </div>
          <Button type="submit" disabled={send.isPending || !input.trim()}>
            Send
          </Button>
        </form>
      </section>

      <aside className="todo-col">
        <h3>Suggested ({suggestions.length})</h3>
        {suggestions.map((s) => (
          <div key={s.id} className="todo-card suggested">
            <strong className="todo-title">{s.title}</strong>
            <span className="muted small">{s.hint}</span>
            <Button
              disabled={send.isPending}
              onClick={() => dispatch(ACTION_MESSAGE[s.actionType](s.actionPayload))}
            >
              {ACTION_LABEL[s.actionType] ?? "Do it"}
            </Button>
          </div>
        ))}
        {suggestions.length === 0 && <p className="muted small">Nothing on fire. Nice.</p>}

        <h3 style={{ marginTop: 16 }}>Tasks ({todos.length})</h3>
        {todos.map((t) => (
          <div key={t.id} className="todo-card">
            <strong className="todo-title">{t.title}</strong>
            <span className="muted small">{t.assignee}</span>
            <button className="chip" onClick={() => completeTodo.mutate(t.id)}>
              Mark done
            </button>
          </div>
        ))}
      </aside>
    </div>
  );
}

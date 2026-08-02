import { useEffect, useState } from "react";
import type { RunState } from "@milo/clone-engine";
import { api } from "../api.ts";

// A fresh clone starts in discovery. Defined as a typed local (not imported from the engine)
// so the browser bundle never pulls the engine's Node-only runtime; the `: RunState`
// annotation still fails the build if the engine's RunState shape ever drifts.
const DISCOVERING: RunState = {
  status: "discovering",
  totalPages: 0,
  pagesCompleted: 0,
  current: null,
  discovered: [],
  failures: [],
};

/** A parsed SSE frame is only trusted as RunState if it's an object carrying `status`. */
function isRunState(v: unknown): v is RunState {
  return typeof v === "object" && v !== null && "status" in v;
}

/**
 * Subscribe to a site's live RunState over SSE. The server sends full-state frames, so
 * we simply replace state on each message — no client-side reducer. Reconnects on error.
 * `initial` is defensively defaulted: a stale server (or any response missing runState)
 * must degrade to a discovering state, never crash the render on `state.status`.
 */
export function useRunState(siteId: string, initial: RunState | null | undefined): RunState {
  const [state, setState] = useState<RunState>(initial ?? DISCOVERING);
  useEffect(() => {
    const es = new EventSource(api.eventsUrl(siteId));
    es.onmessage = (ev) => {
      try {
        const next: unknown = JSON.parse(ev.data);
        if (isRunState(next)) setState(next);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      /* EventSource auto-reconnects; nothing to do */
    };
    return () => es.close();
  }, [siteId]);
  return state;
}

import { useEffect, useState } from "react";
import type { RunState } from "@milo/clone-engine";
import { api } from "../api.ts";

/**
 * Subscribe to a site's live RunState over SSE. The server sends full-state frames, so
 * we simply replace state on each message — no client-side reducer. Reconnects on error.
 */
export function useRunState(siteId: string, initial: RunState): RunState {
  const [state, setState] = useState<RunState>(initial);
  useEffect(() => {
    const es = new EventSource(api.eventsUrl(siteId));
    es.onmessage = (ev) => {
      try {
        setState(JSON.parse(ev.data) as RunState);
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

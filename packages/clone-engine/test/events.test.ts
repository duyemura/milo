import { describe, it, expect } from "vitest";
import {
  initialRunState,
  reduceRunState,
  projectRunState,
  eventToJsonLine,
  parseEventLine,
  EVENT_MARKER,
  type EngineEvent,
} from "../src/events.ts";

const CLONE_SEQUENCE: EngineEvent[] = [
  { type: "run.started", origin: "https://x.com" },
  { type: "discover.progress", coreFound: 2, ugcFound: 1, routes: ["/", "/about/", "/blog/p/"] },
  { type: "page.capture.started", route: "/" },
  { type: "page.capture.done", route: "/" },
  { type: "page.project.started", route: "/" },
  { type: "page.project.done", route: "/" },
  { type: "page.build.started", route: "/" },
  { type: "page.build.done", route: "/" },
  { type: "page.failed", route: "/about/", error: "capture timeout" },
  { type: "assemble.done", pages: 1, fullSiteDir: "/tmp/full-site" },
  { type: "report.done", reportJsonPath: "/tmp/r.json", reportHtmlPath: "/tmp/r.html" },
  { type: "run.completed", ok: 1, failed: 1 },
];

describe("reduceRunState", () => {
  it("projects a clone sequence into a coherent final state", () => {
    const s = projectRunState(CLONE_SEQUENCE);
    expect(s.status).toBe("built");
    expect(s.totalPages).toBe(3);
    expect(s.pagesCompleted).toBe(2); // one build.done + one failed
    expect(s.current).toBeNull();
    expect(s.discovered).toEqual(["/", "/about/", "/blog/p/"]);
    expect(s.failures).toEqual([{ route: "/about/", error: "capture timeout" }]);
  });

  it("marks a mid-run state while a page is building", () => {
    const partial = CLONE_SEQUENCE.slice(0, 7); // up to page.build.started "/"
    const s = projectRunState(partial);
    expect(s.status).toBe("building");
    expect(s.current).toEqual({ route: "/", phase: "build" });
    expect(s.pagesCompleted).toBe(0);
  });

  it("marks failed when every page failed (ok=0)", () => {
    const s = projectRunState([
      { type: "run.started", origin: "https://x.com" },
      { type: "run.completed", ok: 0, failed: 3 },
    ]);
    expect(s.status).toBe("failed");
  });

  it("initialRunState is a clean discovering state", () => {
    expect(initialRunState()).toEqual({
      status: "discovering",
      totalPages: 0,
      pagesCompleted: 0,
      current: null,
      discovered: [],
      failures: [],
    });
  });
});

describe("event line serializer", () => {
  it("round-trips every event through a marker-prefixed JSON line", () => {
    for (const e of CLONE_SEQUENCE) {
      const line = eventToJsonLine(e);
      expect(line.startsWith(EVENT_MARKER)).toBe(true);
      expect(parseEventLine(line)).toEqual(e);
    }
  });

  it("returns null for ordinary log lines (no marker)", () => {
    expect(parseEventLine("=== CAPTURE / ===")).toBeNull();
    expect(parseEventLine("")).toBeNull();
  });

  it("finds the event even when preceded by other stdout on the line", () => {
    const e: EngineEvent = { type: "page.build.done", route: "/" };
    expect(parseEventLine("leading noise " + eventToJsonLine(e))).toEqual(e);
  });

  it("returns null when the marker is present but the JSON is malformed", () => {
    expect(parseEventLine(EVENT_MARKER + "{not json")).toBeNull();
  });

  it("returns null for a marker line whose JSON is valid but not an event (no string type)", () => {
    expect(parseEventLine(EVENT_MARKER + '{"foo":1}')).toBeNull();
  });
});

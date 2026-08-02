import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AdminDb } from "../../db/index.ts";
import type { AdminConfig } from "../../config.ts";
import type { RunState } from "@milo/clone-engine";
import type { RunHub } from "../../jobs/run-state.ts";
import { sitePaths } from "../../jobs/paths.ts";
import { parseId } from "./schemas.ts";

/** One RunState → one SSE `data:` frame. Pure, so it is unit-tested directly. */
export function sseFrame(state: RunState): string {
  return `data: ${JSON.stringify(state)}\n\n`;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

export function registerWorkbenchRoutes(app: FastifyInstance, db: AdminDb, config: AdminConfig, hub: RunHub): void {
  // Live RunState stream. Subscribe FIRST (buffering) then send the authoritative first
  // frame, then flush — so no frame is lost in the gap. Frames are full state; the client
  // just replaces its state each frame.
  app.get("/api/v1/sites/:id/events", (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const buffer: RunState[] = [];
    let live = false;
    const off = hub.subscribe(id, (state) => {
      if (live) res.write(sseFrame(state));
      else buffer.push(state);
    });
    void hub.current(db, id).then((first) => {
      res.write(sseFrame(first));
      live = true;
      for (const s of buffer) res.write(sseFrame(s));
    });

    // Guard the write: the interval tick can race the close event, and writing to a
    // destroyed response throws (ERR_STREAM_WRITE_AFTER_END) as an unhandled error.
    const keepAlive = setInterval(() => {
      if (!res.destroyed) res.write(": keepalive\n\n");
    }, 15000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      off();
    });
  });

  // Same-origin static serve of the built site, for the preview iframe.
  app.get("/sites/:id/site/*", (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const base = path.resolve(sitePaths(config, id).distDir);
    // Fastify's wildcard (*) param is untyped without a schema; the key is always a
    // string at runtime, and defaults to the site root when the wildcard is empty.
    const raw = (req.params as Record<string, string>)["*"] || "index.html";
    let target = path.resolve(base, raw);
    // Path-traversal guard: target must be base itself or a descendant of it.
    if (target !== base && !target.startsWith(base + path.sep)) {
      return reply.code(403).send({ error: "Forbidden." });
    }
    // Serve the directory index when target is a directory (covers both `/site/` and
    // any nested dir request; target === base is intentionally allowed by the guard).
    if (existsSync(target) && existsSync(path.join(target, "index.html"))) {
      target = path.join(target, "index.html");
    }
    if (!existsSync(target)) return reply.code(404).send({ error: "Not found." });
    reply.type(MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream");
    return reply.send(createReadStream(target));
  });

  // Build report JSON (from build-report.json). HTML report is available via the preview
  // route if desired; the UI renders from JSON.
  app.get("/api/v1/sites/:id/report", (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const file = sitePaths(config, id).reportJson;
    if (!existsSync(file)) return reply.code(404).send({ error: "No report yet." });
    try {
      return reply.send({ report: JSON.parse(readFileSync(file, "utf-8")) });
    } catch {
      return reply.code(500).send({ error: "Report file is unreadable." });
    }
  });
}

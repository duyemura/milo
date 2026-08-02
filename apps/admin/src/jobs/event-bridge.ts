import { spawn } from "node:child_process";
import { parseEventLine } from "@milo/clone-engine";
import type { AdminDb } from "../db/index.ts";
import { appendLog } from "./dispatch.ts";
import { encodeLoggedEvent, type RunHub } from "./run-state.ts";

export interface EventBridge {
  /** Feed one line of engine stdout. Non-blocking; work is serialized internally. */
  onLine(line: string): void;
  /** Resolves once every queued line has been persisted. Await before finishing the job. */
  drain(): Promise<void>;
}

/**
 * Routes clone-CLI stdout to storage + live state. Event lines (engine U+0001 marker,
 * via parseEventLine) are persisted to job_logs in the ASCII-safe encoding AND applied
 * to the RunHub; everything else is logged verbatim. Writes are serialized through a
 * promise chain so job_logs.seq assignment can't race (a duplicate seq would drop a row).
 */
export function makeEventBridge(deps: { db: AdminDb; jobId: string; siteId: string; hub: RunHub }): EventBridge {
  let chain: Promise<void> = Promise.resolve();
  return {
    onLine(line: string): void {
      const ev = parseEventLine(line);
      chain = chain.then(async () => {
        if (ev) {
          // Persist before applying: if the process dies between the two, the hub is
          // rebuilt from job_logs at startup, so a persisted-but-unapplied event is safe
          // while an applied-but-unpersisted one would be lost on restart.
          await appendLog(deps.db, deps.jobId, encodeLoggedEvent(ev));
          deps.hub.apply(deps.siteId, ev);
        } else {
          await appendLog(deps.db, deps.jobId, line);
        }
      });
    },
    drain(): Promise<void> {
      return chain;
    },
  };
}

/**
 * Spawn a command, routing every stdout/stderr line through `onLine`. Resolves with the
 * exit code. Env is inherited from the admin process (root .env is loaded at config time,
 * so the clone engine's LLM-labeler keys are already present).
 */
export function spawnLines(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  onLine: (line: string) => void;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, env: { ...process.env } });
    // A single engine write ("line\n") can arrive split across two data chunks, so we
    // buffer the trailing partial line and only emit complete lines. Without this, an
    // event line split mid-JSON would fail parseEventLine and be lost from the RunHub.
    // stdout and stderr get separate carry buffers so a partial on one never splices
    // onto a chunk from the other.
    const streamCarry = { stdout: "", stderr: "" };
    const collect = (stream: "stdout" | "stderr") => (buf: Buffer) => {
      const lines = (streamCarry[stream] + buf.toString("utf-8")).split("\n");
      streamCarry[stream] = lines.pop() ?? "";
      for (const l of lines) {
        if (l.trim()) opts.onLine(l);
      }
    };
    const flush = () => {
      for (const s of ["stdout", "stderr"] as const) {
        if (streamCarry[s].trim()) opts.onLine(streamCarry[s]);
        streamCarry[s] = "";
      }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", reject);
    child.on("close", (code) => {
      flush();
      resolve(code ?? 1);
    });
  });
}

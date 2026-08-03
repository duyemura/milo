import os from "node:os";
import fs from "node:fs";

/**
 * Run `fn` over `items` with at most `limit` concurrent invocations; results are
 * returned in input order. `fn` MUST NOT throw for per-item failures — model those
 * as a result value — because a throw rejects the whole pool.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length || 1));
  const workers = Array.from({ length: width }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** vCPUs available to THIS process. Reads the cgroup v2 quota so it is correct
 *  inside a container (os.availableParallelism reports the HOST core count, which
 *  over-reports on Railway/EC2 and would cause thrash). */
function effectiveCpus(): number {
  try {
    const [quota, period] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quota !== "max") {
      const q = Number(quota), p = Number(period || "100000");
      if (q > 0 && p > 0) return Math.max(1, Math.floor(q / p));
    }
  } catch { /* not a cgroup-v2 container */ }
  return os.availableParallelism?.() ?? os.cpus().length;
}

/** Memory limit (MB) for THIS process — cgroup v2 first, else host total. Caps
 *  concurrency so K headless browsers can't OOM a small Railway instance. */
function memLimitMB(): number {
  try {
    const v = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (v !== "max") return Math.floor(Number(v) / 1048576);
  } catch { /* */ }
  return Math.floor(os.totalmem() / 1048576);
}

export interface AutoConcurrencyOpts {
  env?: Record<string, string | undefined>;
  /** Estimated RAM per concurrent headless browser. Default 500 MB. */
  perBrowserMb?: number;
  /** cores × this = CPU-bound ceiling. >1 because capture is ~40% idle wait. Default 1.5. */
  coreFactor?: number;
  /** Absolute ceiling regardless of hardware. Default 16. */
  hardCap?: number;
}

/**
 * Concurrency sized to the host. `CLONE_CONCURRENCY` (positive int) overrides
 * everything. Otherwise min(cores×coreFactor, memLimit/perBrowser, hardCap), ≥1.
 * Container-aware, so the same code is right locally and on any Railway size.
 */
export function autoConcurrency(opts: AutoConcurrencyOpts = {}): number {
  const env = opts.env ?? process.env;
  const override = Number(env.CLONE_CONCURRENCY);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const byCpu = Math.max(1, Math.floor(effectiveCpus() * (opts.coreFactor ?? 1.5)));
  const byMem = Math.max(1, Math.floor(memLimitMB() / (opts.perBrowserMb ?? 500)));
  return Math.max(1, Math.min(byCpu, byMem, opts.hardCap ?? 16));
}

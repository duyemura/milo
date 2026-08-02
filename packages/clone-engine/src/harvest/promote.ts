import type { Archetype } from "./types.ts";

/**
 * Popularity floor / quarantine: an archetype seen on <= floor distinct sites is likely an
 * idiosyncratic one-off → status "quarantine" (stays in the report, not in the live library).
 * Above the floor → "candidate" (eligible for the human gate, then admission).
 */
export function applyPopularityFloor(
  archetypes: Record<string, Archetype>,
  floor: number,
): Record<string, Archetype> {
  const out: Record<string, Archetype> = {};
  for (const [hash, a] of Object.entries(archetypes)) {
    out[hash] = { ...a, status: a.sites.length <= floor ? "quarantine" : "candidate" };
  }
  return out;
}

/**
 * Human-gate rule: every FIRST-TIME candidate promotion is reviewed. Returns true iff the
 * archetype is a candidate whose fingerprint has NOT already been admitted (in `admittedHashes`).
 */
export function needsHumanGate(a: Archetype, admittedHashes: Set<string>): boolean {
  return a.status === "candidate" && !admittedHashes.has(a.fingerprint.hash);
}

/**
 * Self-prune / merge: collapse archetypes that share the same fingerprint hash (a later
 * fingerprint/knob refinement can reveal two entries are the same shape differing only by a
 * knob). The knob absorbs the difference; sites unions; one entry survives. Idempotent.
 */
export function selfPruneMerge(archetypes: Record<string, Archetype>): Record<string, Archetype> {
  const byHash = new Map<string, Archetype>();
  for (const a of Object.values(archetypes)) {
    const key = a.fingerprint.hash;
    const existing = byHash.get(key);
    if (!existing) {
      byHash.set(key, { ...a, sites: [...new Set(a.sites)] });
      continue;
    }
    byHash.set(key, {
      ...existing,
      sites: [...new Set([...existing.sites, ...a.sites])],
      knobs: {
        mediaType: [...new Set([...existing.knobs.mediaType, ...a.knobs.mediaType])],
        mediaPosition: [...new Set([...existing.knobs.mediaPosition, ...a.knobs.mediaPosition])],
        align: [...new Set([...existing.knobs.align, ...a.knobs.align])],
        density: [...new Set([...existing.knobs.density, ...a.knobs.density])],
        itemCount: {
          min: Math.min(existing.knobs.itemCount.min, a.knobs.itemCount.min),
          max: Math.max(existing.knobs.itemCount.max, a.knobs.itemCount.max),
        },
      },
    });
  }
  const out: Record<string, Archetype> = {};
  for (const [hash, a] of byHash) out[hash] = a;
  return out;
}

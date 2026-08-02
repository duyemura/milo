import type { HarvestedSection, KnobSet, Archetype } from "./types.ts";

/** The mode (most frequent) value of a list, ties broken by first-seen order. */
function mode<T extends string | number>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestN = -1;
  for (const v of values) {
    const n = counts.get(v)!;
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

/** Distinct sorted values of a projected observed field across members. */
function distinct<T extends string>(members: HarvestedSection[], pick: (m: HarvestedSection) => T): T[] {
  return [...new Set(members.map(pick))];
}

/**
 * Enumerate the bounded knob set this archetype supports — ONLY the knobs its members
 * actually vary over. density always includes "default" (residual-density inference is out of
 * scope for v2's bounded set). itemCount is the observed min..max.
 */
export function enumerateKnobs(members: HarvestedSection[]): KnobSet {
  const counts = members.map((m) => m.observed.itemCount);
  return {
    mediaType: distinct(members, (m) => m.observed.mediaType),
    mediaPosition: distinct(members, (m) => m.observed.mediaPosition),
    align: distinct(members, (m) => m.observed.align),
    density: ["default"],
    itemCount: { min: Math.min(...counts), max: Math.max(...counts) },
  };
}

/** Seed each knob's default to the modal observed value across members. */
export function modalDefaults(members: HarvestedSection[]): Archetype["knobDefaults"] {
  return {
    mediaType: mode(members.map((m) => m.observed.mediaType)),
    mediaPosition: mode(members.map((m) => m.observed.mediaPosition)),
    align: mode(members.map((m) => m.observed.align)),
    itemCount: mode(members.map((m) => m.observed.itemCount)),
  };
}

import crypto from "node:crypto";
import type { HarvestedSection, Fingerprint, SlotNode } from "./types.ts";

/** Canonical, deterministic serialization of a slot tree (order-preserving, cardinality-collapsed). */
function serializeSlots(slots: SlotNode[]): string {
  return (
    "[" +
    slots
      .map((s) => {
        const kids = s.children && s.children.length ? serializeSlots(s.children) : "";
        return `${s.role}:${s.card}${kids}`;
      })
      .join(",") +
    "]"
  );
}

/**
 * Compute the structural fingerprint of a harvested section. Identity = role + slotTree
 * (cardinality collapsed to 1..N, order significant) + layoutPrimitive. Everything else
 * (media type/position, align, density, color, font, geometry, exact count, copy) is a knob
 * and is deliberately NOT an input.
 */
export function fingerprint(section: Pick<HarvestedSection, "role" | "slotTree" | "layoutPrimitive">): Fingerprint {
  const slotTree = section.slotTree;
  const canonical = `${section.role}|${section.layoutPrimitive}|${serializeSlots(slotTree)}`;
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return { role: section.role, slotTree, layoutPrimitive: section.layoutPrimitive, hash };
}

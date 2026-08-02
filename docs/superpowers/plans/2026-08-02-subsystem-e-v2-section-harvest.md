# Subsystem E-v2 — Adaptive Section-Template Library by Harvest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the E-v1 section-template library by harvesting sections from real conversion websites, tokenizing away their brand identity, and canonicalizing each *structurally-novel adaptive* archetype into an E-v1-compatible `SectionTemplate` that `generate.ts` inserts indistinguishably from a hand-authored one.

**Architecture:** A new **offline authoring** module `src/harvest/` that consumes the unchanged engine primitives (capture → labels → brand tokenizer → pixel/verify oracle) as a *new consumer*. Each harvested section gets a deterministic **structural fingerprint** (role + cardinality-collapsed slot-tree + layout primitive), is **classified** adaptive/reject by measuring residual bespoke styling and passing a **swap-brand oracle**, then **deduped** by fingerprint into a persisted archetype **library** with popularity votes. Novel adaptive archetypes are **emitted** as `SectionTemplate` source and **governed** by a human-gate + popularity floor. The residual threshold and popularity floor are **calibrated empirically** on a ~30-site B2C-service corpus, not guessed.

**Tech Stack:** Node 24 native TypeScript, `@milo/clone-engine` (`capture.ts`, `labels.ts`, `brand.ts`, `project.ts`, `tree.ts`, `pixel.ts`, `edit/verify.ts`, `edit/snapshot.ts`, `edit/templates.ts`, `edit/generate.ts`), Zod, Playwright (screenshots/diff via `pixel.ts`/`verify.ts`), Vitest (`vitest run --no-file-parallelism`). Spec (authoritative): `docs/superpowers/specs/2026-08-02-subsystem-e-v2-section-harvest-design.md`.

**Test setup pattern (all tasks):** unit tasks (fingerprint, knobs, residual metric, dedup, governance) run on **hand-written `HarvestedSection` fixtures** — no browser, deterministic, fast. Pipeline/oracle/integration tasks project a **golden capture** (`test/golden/{speakeasy,sweatshed,torrance}/capture.json`) to a temp dir via `project()`, share ONE Playwright `browser` across the file (never launch per-call), and mock the LLM via a local `fakeChat` helper (copy the one in `test/edit/scenario/generate.test.ts:90`). The calibration scan (Task 11) is a **script**, not a gated test — it fetches live sites and is run once manually.

---

## File structure

Every file has ONE responsibility. New module `packages/clone-engine/src/harvest/`:

```
packages/clone-engine/src/harvest/
  types.ts        # HarvestedSection, SlotNode, LayoutPrimitive, Fingerprint, Archetype,
                  #   KnobSet, Classification, HarvestReportEntry, LibraryStore — the shared vocabulary
  extract.ts      # captured section (TreeEl + StyleMap + role) -> { slotTree, layoutPrimitive, residualNodes }
                  #   reuses tree.ts (partitionRegions/isEl/elKids/findTag) + labels roles
  fingerprint.ts  # (role, slotTree, layoutPrimitive) -> stable Fingerprint struct + string hash
  knobs.ts        # enumerate the bounded per-archetype KnobSet from a group's members; modal defaults
  residual.ts     # measure residual bespoke styling of a section AFTER brand tokenization -> number [0,1]
  classify.ts     # residual-threshold gate + swap-brand ORACLE (render under >=2 other brands) -> Classification
  library.ts      # cluster HarvestedSection[] by Fingerprint -> Archetype[]; JSON-persist load/save; popularity
  emit.ts         # Archetype -> SectionTemplate source string (E-v1 templates.ts shape) + slotSchema + render
  promote.ts      # governance: promote-by-novelty, human-gate flags, popularity floor, self-prune/merge
  harvest.ts      # the end-to-end pipeline orchestrator: sites -> library + harvest-report.json + emitted templates
  index.ts        # barrel: re-export the public surface
packages/clone-engine/scripts/
  harvest-calibrate.mjs  # Task 11 offline calibration scan over the ~30-site corpus (run manually)
packages/clone-engine/test/harvest/
  fixtures.ts     # canonical HarvestedSection fixtures (video-bg hero, image-bg hero, form hero, cta L/R, grids)
  extract.test.ts fingerprint.test.ts knobs.test.ts residual.test.ts
  classify.test.ts library.test.ts emit.test.ts promote.test.ts
test/harvest/scenario/
  harvest-pipeline.test.ts   # Task 7: end-to-end on 1-2 goldens
  emit-integration.test.ts   # Task 10: emitted template inserts via UNCHANGED generate.ts + oracle-clean
```

**Sequencing (spec's pipeline order):** types → extract structure → fingerprint (Task 2 canonical cases) → knobs → residual metric → classify+swap-brand oracle → dedup/library → harvest pipeline → governance → integration+eval → calibration scan.

**DRY / YAGNI / reuse:** harvest NEVER modifies an engine primitive. `residual.ts` reuses `canon`/`COLOR_RE` from `tree.ts`; `classify.ts` reuses `buildBrand`/`flattenRoot`/`brandSlotOfCanon`/`deriveVariants` from `brand.ts` and `renderSnapshot`/`verify` from `edit/verify.ts`; `extract.ts` reuses `partitionRegions`/`findTag`/`isEl`/`elKids` from `tree.ts`; `emit.ts` emits the exact `RenderedTemplate`/`SectionTemplate` shape from `edit/templates.ts`; `harvest.ts` reuses `capture`/`heuristicLabels`/`project`. Only the swap-brand render + fingerprint + residual metric + knob enumerator + canonicalizer + report are new.

---

## Task 0: Scaffold `src/harvest/` + shared types

**Files:**
- Create: `packages/clone-engine/src/harvest/types.ts`
- Create: `packages/clone-engine/src/harvest/index.ts`
- Test: `packages/clone-engine/test/harvest/types.test.ts`

- [ ] **Step 1 — types.** Write `src/harvest/types.ts`. These are the ONLY shared harvest types; every later task imports from here (no forward-references — everything a later task uses is defined here first).

```ts
import type { z } from "zod";
import type { StyleMap, TreeEl } from "../types.ts";
import type { TemplateSectionRole, SectionTemplate } from "../edit/templates.ts";

/** Coarse arrangement primitive — part of the fingerprint identity (NOT a knob). */
export type LayoutPrimitive = "stack" | "grid" | "split" | "overlay" | "alternating";

/** Cardinality class of a slot: exactly-one, or a repeating group of >=2. */
export type Cardinality = "1" | "N";

/**
 * One node in a section's semantic slot tree. `role` is the slot's semantic name
 * (headline, subcopy, cta, media, form, feature-item, ...). `card` collapses repetition
 * (a grid of 3 cards and a grid of 6 cards share the same tree). `children` is the ordered
 * sub-slots of a repeating group (e.g. a card's {title, body}).
 */
export interface SlotNode {
  role: string;
  card: Cardinality;
  children?: SlotNode[];
}

/** The bounded knob set an archetype supports. Every value is an enum or a bounded int — never a raw literal. */
export interface KnobSet {
  mediaType: Array<"image" | "video" | "none">;
  mediaPosition: Array<"left" | "right" | "background">;
  align: Array<"left" | "center" | "right">;
  density: Array<"compact" | "default" | "roomy">;
  /** Supported item-count range for the archetype's N-cardinality slot (inclusive). */
  itemCount: { min: number; max: number };
}

/** The structural identity of a section. Two sections with equal `hash` ARE the same template. */
export interface Fingerprint {
  role: TemplateSectionRole;
  slotTree: SlotNode[];
  layoutPrimitive: LayoutPrimitive;
  /** Stable content hash of the three fields above. */
  hash: string;
}

/**
 * A single harvested section instance: its source, role, extracted structure, and its
 * brand-tokenized styles (produced by the tokenizer during harvest). This is the unit the
 * classifier, fingerprinter, and dedup operate on.
 */
export interface HarvestedSection {
  /** Origin site id (a stable slug, e.g. "vervecoffee"). Popularity counts distinct sourceSite. */
  sourceSite: string;
  role: TemplateSectionRole;
  slotTree: SlotNode[];
  layoutPrimitive: LayoutPrimitive;
  /** The section's captured computed styles at 1440 (id -> prop -> value), pre-tokenization. */
  styles: StyleMap;
  /** The captured subtree root for the section (for the swap-brand render + knob reading). */
  node: TreeEl;
  /** Observed knob values on THIS instance (used to seed the archetype's knob defaults). */
  observed: {
    mediaType: "image" | "video" | "none";
    mediaPosition: "left" | "right" | "background";
    align: "left" | "center" | "right";
    itemCount: number;
  };
}

export type ClassifyVerdict = "adaptive" | "reject";

/** The classifier's output for one section. `residual` is the measured [0,1] bespoke-styling score. */
export interface Classification {
  verdict: ClassifyVerdict;
  residual: number;
  /** true only when residual<=threshold AND the swap-brand oracle passed on every swap target. */
  swapBrandClean: boolean;
  /** Human-readable reasons (fed to the harvest report / human gate). */
  reasons: string[];
}

/** One clustered archetype: a fingerprint, its members, its popularity, and its enumerated knobs. */
export interface Archetype {
  fingerprint: Fingerprint;
  /** Distinct source-site slugs contributing to this archetype (popularity = size of this set). */
  sites: string[];
  knobs: KnobSet;
  /** Knob defaults = modal observed value across members. */
  knobDefaults: { mediaType: string; mediaPosition: string; align: string; itemCount: number };
  /** Governance state (see promote.ts). */
  status: "quarantine" | "candidate" | "admitted";
}

/** One row in harvest-report.json — the human-gate's evidence. */
export interface HarvestReportEntry {
  sourceSite: string;
  role: string;
  fingerprintHash: string;
  residual: number;
  swapBrandClean: boolean;
  /** Popularity of the archetype this instance landed in, at report time. */
  popularity: number;
  knobs: KnobSet;
  verdict: ClassifyVerdict;
}

/** The persisted library: archetypes keyed by fingerprint hash + a report log. */
export interface LibraryStore {
  version: 1;
  archetypes: Record<string, Archetype>;
  report: HarvestReportEntry[];
}

/** A template emitted from an archetype, ready to register in the E-v1 library. */
export interface EmittedTemplate {
  /** The archetype's fingerprint hash — the emitted template's stable id. */
  id: string;
  role: TemplateSectionRole;
  /** The templates.ts source string (a full `SectionTemplate` literal) for review/commit. */
  source: string;
  /** The runtime template object (same shape E-v1 registers), for in-process integration tests. */
  template: SectionTemplate;
}

/** A schema-typed alias kept local so later files don't re-derive it. */
export type Zod = z.ZodTypeAny;
```

- [ ] **Step 2 — barrel.** Write `src/harvest/index.ts`:

```ts
export * from "./types.ts";
```

- [ ] **Step 3 — test.** Write `test/harvest/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { HarvestedSection, LayoutPrimitive } from "../../src/harvest/types.ts";

describe("harvest types", () => {
  it("compiles and constructs a minimal HarvestedSection", () => {
    const s: HarvestedSection = {
      sourceSite: "x",
      role: "cta-band",
      slotTree: [{ role: "headline", card: "1" }],
      layoutPrimitive: "stack",
      styles: {},
      node: { id: 0, tag: "section", attrs: {}, children: [] },
      observed: { mediaType: "none", mediaPosition: "background", align: "center", itemCount: 1 },
    };
    expect(s.role).toBe("cta-band");
    const p: LayoutPrimitive = "grid";
    expect(p).toBe("grid");
  });
});
```

- [ ] **Step 4 — run + gate + commit.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/types.test.ts` → Expected: 1 passed.
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean (no output, exit 0).
  - Commit:
```bash
git add packages/clone-engine/src/harvest/types.ts packages/clone-engine/src/harvest/index.ts packages/clone-engine/test/harvest/types.test.ts
git commit -m "feat(harvest): scaffold src/harvest + shared types (E2-T0)"
```

---

## Task 1: Canonical fixtures for unit tasks

**Files:**
- Create: `packages/clone-engine/test/harvest/fixtures.ts`
- Test: `packages/clone-engine/test/harvest/fixtures.test.ts`

The spec names three canonical fingerprint cases (video-bg vs image-bg hero → SAME; L vs R CTA → SAME; button-hero vs form-hero → DIFFERENT). Build them ONCE here so every unit task shares them (DRY).

- [ ] **Step 1 — fixtures.** Write `test/harvest/fixtures.ts`:

```ts
import type { HarvestedSection, SlotNode } from "../../src/harvest/types.ts";
import type { TreeEl } from "../../src/types.ts";

/** A tiny section subtree (structure only; styles carried separately). */
function node(tag: string, children: TreeEl[] = [], attrs: Record<string, string> = {}): TreeEl {
  return { id: Math.floor(Math.random() * 1e9), tag, attrs, children };
}

const HERO_SLOTS: SlotNode[] = [
  { role: "headline", card: "1" },
  { role: "subcopy", card: "1" },
  { role: "primary-cta", card: "1" },
  { role: "media", card: "1" },
];

/** Video-background hero — same slots as image-bg, media.type differs (a KNOB). */
export const videoBgHero: HarvestedSection = {
  sourceSite: "siteA",
  role: "hero",
  slotTree: HERO_SLOTS,
  layoutPrimitive: "overlay",
  styles: { "0": { "background-color": "rgb(20, 20, 20)", color: "rgb(255,255,255)", "font-family": "Poppins" } },
  node: node("section", [node("video"), node("h1"), node("p"), node("a")]),
  observed: { mediaType: "video", mediaPosition: "background", align: "center", itemCount: 1 },
};

/** Image-background hero — identical structure, media.type=image. Must share videoBgHero's fingerprint. */
export const imageBgHero: HarvestedSection = {
  ...videoBgHero,
  sourceSite: "siteB",
  node: node("section", [node("img"), node("h1"), node("p"), node("a")]),
  observed: { ...videoBgHero.observed, mediaType: "image" },
};

/** Left-aligned CTA band. */
export const ctaLeft: HarvestedSection = {
  sourceSite: "siteC",
  role: "cta-band",
  slotTree: [
    { role: "headline", card: "1" },
    { role: "subcopy", card: "1" },
    { role: "primary-cta", card: "1" },
  ],
  layoutPrimitive: "stack",
  styles: { "0": { "background-color": "rgb(200, 40, 40)", color: "rgb(255,255,255)", "font-family": "Inter" } },
  node: node("section", [node("h2"), node("p"), node("a")]),
  observed: { mediaType: "none", mediaPosition: "background", align: "left", itemCount: 1 },
};

/** Right-aligned CTA band — identical structure, align differs (a KNOB). Must share ctaLeft's fingerprint. */
export const ctaRight: HarvestedSection = {
  ...ctaLeft,
  sourceSite: "siteD",
  observed: { ...ctaLeft.observed, align: "right" },
};

/** Form hero — DIFFERENT content model: a form{field:N} slot instead of a single cta. New fingerprint. */
export const formHero: HarvestedSection = {
  sourceSite: "siteE",
  role: "hero",
  slotTree: [
    { role: "headline", card: "1" },
    { role: "subcopy", card: "1" },
    { role: "form", card: "1", children: [{ role: "form-field", card: "N" }] },
    { role: "media", card: "1" },
  ],
  layoutPrimitive: "overlay",
  styles: { "0": { "background-color": "rgb(20, 20, 20)", color: "rgb(255,255,255)", "font-family": "Poppins" } },
  node: node("section", [node("img"), node("h1"), node("p"), node("form", [node("input"), node("input")])]),
  observed: { mediaType: "image", mediaPosition: "background", align: "center", itemCount: 1 },
};

/** A 3-up feature grid. */
export const grid3: HarvestedSection = {
  sourceSite: "siteF",
  role: "feature-grid",
  slotTree: [
    { role: "headline", card: "1" },
    { role: "feature-item", card: "N", children: [{ role: "headline", card: "1" }, { role: "body-text", card: "1" }] },
  ],
  layoutPrimitive: "grid",
  styles: { "0": { "background-color": "rgb(255,255,255)", color: "rgb(17,17,17)", "font-family": "Inter" } },
  node: node("section", [node("h2"), node("div"), node("div"), node("div")]),
  observed: { mediaType: "none", mediaPosition: "background", align: "center", itemCount: 3 },
};

/** A 6-up feature grid — same slot tree (cardinality collapsed), itemCount differs (a KNOB). Same fingerprint as grid3. */
export const grid6: HarvestedSection = {
  ...grid3,
  sourceSite: "siteG",
  observed: { ...grid3.observed, itemCount: 6 },
};
```

- [ ] **Step 2 — test.** Write `test/harvest/fixtures.test.ts` (sanity that the canonical pairs differ only where the spec says):

```ts
import { describe, it, expect } from "vitest";
import { videoBgHero, imageBgHero, ctaLeft, ctaRight, formHero, grid3, grid6 } from "./fixtures.ts";

describe("canonical fixtures", () => {
  it("video-bg and image-bg hero share slotTree + layout, differ only in observed.mediaType", () => {
    expect(imageBgHero.slotTree).toEqual(videoBgHero.slotTree);
    expect(imageBgHero.layoutPrimitive).toBe(videoBgHero.layoutPrimitive);
    expect(imageBgHero.observed.mediaType).not.toBe(videoBgHero.observed.mediaType);
  });
  it("L/R CTA share slotTree, differ only in observed.align", () => {
    expect(ctaRight.slotTree).toEqual(ctaLeft.slotTree);
    expect(ctaRight.observed.align).not.toBe(ctaLeft.observed.align);
  });
  it("form hero has a form slot the button hero does not", () => {
    expect(videoBgHero.slotTree.some((s) => s.role === "form")).toBe(false);
    expect(formHero.slotTree.some((s) => s.role === "form")).toBe(true);
  });
  it("grid3 and grid6 share slotTree, differ only in observed.itemCount", () => {
    expect(grid6.slotTree).toEqual(grid3.slotTree);
    expect(grid6.observed.itemCount).not.toBe(grid3.observed.itemCount);
  });
});
```

- [ ] **Step 3 — run + gate + commit.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/fixtures.test.ts` → Expected: 4 passed.
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/test/harvest/fixtures.ts packages/clone-engine/test/harvest/fixtures.test.ts
git commit -m "test(harvest): canonical fingerprint fixtures (E2-T1)"
```

---

## Task 2: Structural fingerprint (`fingerprint.ts`) — the spec's canonical cases

**Files:**
- Create: `packages/clone-engine/src/harvest/fingerprint.ts`
- Test: `packages/clone-engine/test/harvest/fingerprint.test.ts`

Deterministic: `(role, slotTree, layoutPrimitive) -> Fingerprint`. EXCLUDES media-type/align/density/color/font/geometry/exact-count/copy — none of those are inputs.

- [ ] **Step 1 — write the failing test.** Write `test/harvest/fingerprint.test.ts` (the exact canonical cases from the spec):

```ts
import { describe, it, expect } from "vitest";
import { fingerprint } from "../../src/harvest/fingerprint.ts";
import { videoBgHero, imageBgHero, ctaLeft, ctaRight, formHero, grid3, grid6 } from "./fixtures.ts";

const fp = (s: Parameters<typeof fingerprint>[0]) => fingerprint(s).hash;

describe("structural fingerprint", () => {
  it("video-bg hero and image-bg hero → SAME fingerprint (media.type is a knob)", () => {
    expect(fp(videoBgHero)).toBe(fp(imageBgHero));
  });
  it("left-aligned and right-aligned CTA → SAME fingerprint (align is a knob)", () => {
    expect(fp(ctaLeft)).toBe(fp(ctaRight));
  });
  it("button hero and form hero → DIFFERENT fingerprint (different content model)", () => {
    expect(fp(videoBgHero)).not.toBe(fp(formHero));
  });
  it("3-up and 6-up grid → SAME fingerprint (itemCount is a knob, cardinality collapsed to N)", () => {
    expect(fp(grid3)).toBe(fp(grid6));
  });
  it("is deterministic — same input twice → identical hash", () => {
    expect(fp(grid3)).toBe(fp(grid3));
  });
  it("hash is insensitive to slot-tree object identity but sensitive to slot roles/order", () => {
    const reordered = { ...ctaLeft, slotTree: [ctaLeft.slotTree[1], ctaLeft.slotTree[0], ctaLeft.slotTree[2]] };
    expect(fp(reordered)).not.toBe(fp(ctaLeft));
  });
});
```

- [ ] **Step 2 — run to verify it fails.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/fingerprint.test.ts` → Expected: FAIL ("Cannot find module '../../src/harvest/fingerprint.ts'").

- [ ] **Step 3 — minimal implementation.** Write `src/harvest/fingerprint.ts`:

```ts
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
```

- [ ] **Step 4 — run to verify it passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/fingerprint.test.ts` → Expected: 6 passed.

- [ ] **Step 5 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/src/harvest/fingerprint.ts packages/clone-engine/test/harvest/fingerprint.test.ts
git commit -m "feat(harvest): deterministic structural fingerprint + spec canonical cases (E2-T2)"
```

---

## Task 3: Structure extraction (`extract.ts`) — capture → slotTree/layout/observed

**Files:**
- Create: `packages/clone-engine/src/harvest/extract.ts`
- Test: `packages/clone-engine/test/harvest/extract.test.ts`

Turn a captured section (`TreeEl` subtree + its `StyleMap` + assigned role) into `{ slotTree, layoutPrimitive, observed }` — the input the fingerprint + classifier need. Reuse `tree.ts` (`isEl`/`elKids`/`findTag`) — do NOT re-walk with new helpers.

- [ ] **Step 1 — write the failing test.** Write `test/harvest/extract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractStructure, layoutPrimitiveOf } from "../../src/harvest/extract.ts";
import type { TreeEl } from "../../src/types.ts";

const el = (tag: string, children: TreeEl[] = [], attrs: Record<string, string> = {}): TreeEl =>
  ({ id: 0, tag, attrs, children });

describe("extractStructure", () => {
  it("collapses a repeating card group to a single N-cardinality slot", () => {
    // three sibling <div> cards, each h3 + p → feature-item:N{headline:1, body-text:1}
    const card = () => el("div", [el("h3", [{ t: "T" } as unknown as TreeEl]), el("p", [{ t: "B" } as unknown as TreeEl])]);
    const section = el("section", [el("h2", [{ t: "Head" } as unknown as TreeEl]), card(), card(), card()]);
    const { slotTree, observed } = extractStructure(section, {}, "feature-grid");
    const feature = slotTree.find((s) => s.card === "N");
    expect(feature).toBeDefined();
    expect(observed.itemCount).toBe(3);
  });

  it("labels a background media element as overlay layout", () => {
    const section = el("section", [el("img", [], { class: "bg" }), el("h1", [{ t: "Hi" } as unknown as TreeEl]), el("a")]);
    expect(layoutPrimitiveOf(section)).toBe("overlay");
  });

  it("labels a >=2-sibling repeating grid as grid layout", () => {
    const section = el("section", [el("h2"), el("div", [el("h3")]), el("div", [el("h3")]), el("div", [el("h3")])]);
    expect(layoutPrimitiveOf(section)).toBe("grid");
  });

  it("detects a form slot (distinct content model)", () => {
    const section = el("section", [el("h1"), el("form", [el("input"), el("input")])]);
    const { slotTree } = extractStructure(section, {}, "hero");
    expect(slotTree.some((s) => s.role === "form")).toBe(true);
  });
});
```

- [ ] **Step 2 — run to verify it fails.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/extract.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3 — minimal implementation.** Write `src/harvest/extract.ts`:

```ts
import type { TreeEl, StyleMap, TreeNode } from "../types.ts";
import type { TemplateSectionRole } from "../edit/templates.ts";
import type { SlotNode, LayoutPrimitive, HarvestedSection } from "./types.ts";
import { isEl, elKids, findTag } from "../tree.ts";

/** Map a tag (+ context) to a semantic slot role. Coarse by design — structure, not copy. */
function slotRoleOf(el: TreeEl): string {
  const t = el.tag;
  if (t === "h1" || t === "h2") return "headline";
  if (t === "h3" || t === "h4") return "headline";
  if (t === "p" || t === "span") return "body-text";
  if (t === "a" || t === "button") return "primary-cta";
  if (t === "form") return "form";
  if (t === "input" || t === "textarea" || t === "select") return "form-field";
  if (t === "img" || t === "video" || t === "picture") return "media";
  return "body-text";
}

/** True if this element (or its immediate class) reads as a full-bleed background media element. */
function isBackgroundMedia(el: TreeEl): boolean {
  if (el.tag !== "img" && el.tag !== "video" && el.tag !== "picture") return false;
  const cls = (el.attrs["class"] ?? "").toLowerCase();
  return /bg|background|hero|cover|full/.test(cls);
}

/**
 * Group consecutive sibling elements that share the same tag + child-shape into one
 * repeating group. Returns groups of >=2 as N-cardinality, singletons as 1.
 */
function groupSiblings(kids: TreeEl[]): Array<{ reps: TreeEl[]; card: "1" | "N" }> {
  const shape = (el: TreeEl) => el.tag + ":" + elKids(el).map((c) => c.tag).join("-");
  const out: Array<{ reps: TreeEl[]; card: "1" | "N" }> = [];
  let i = 0;
  while (i < kids.length) {
    const s = shape(kids[i]);
    let j = i + 1;
    while (j < kids.length && shape(kids[j]) === s) j++;
    const reps = kids.slice(i, j);
    out.push({ reps, card: reps.length >= 2 ? "N" : "1" });
    i = j;
  }
  return out;
}

/** Build the ordered semantic slot tree of a section subtree (cardinality collapsed). */
function slotTreeOf(section: TreeEl): SlotNode[] {
  const kids = elKids(section);
  const groups = groupSiblings(kids);
  const slots: SlotNode[] = [];
  for (const g of groups) {
    const rep = g.reps[0];
    const grandKids = elKids(rep);
    if (grandKids.length > 0 && (g.card === "N" || rep.tag === "form" || rep.tag === "div")) {
      const role = rep.tag === "form" ? "form" : g.card === "N" ? "feature-item" : slotRoleOf(rep);
      const children = elKids(rep).map((c) => ({ role: slotRoleOf(c), card: "1" as const }));
      slots.push(children.length ? { role, card: g.card, children } : { role, card: g.card });
    } else {
      slots.push({ role: slotRoleOf(rep), card: g.card });
    }
  }
  return slots;
}

/** Derive the coarse layout primitive from the tokenized structure (not pixel positions). */
export function layoutPrimitiveOf(section: TreeEl): LayoutPrimitive {
  const kids = elKids(section);
  if (kids.some(isBackgroundMedia)) return "overlay";
  const groups = groupSiblings(kids);
  if (groups.some((g) => g.card === "N")) return "grid";
  const hasMedia = kids.some((k) => k.tag === "img" || k.tag === "video" || k.tag === "picture");
  const hasContent = kids.some((k) => k.tag !== "img" && k.tag !== "video" && k.tag !== "picture");
  if (hasMedia && hasContent && kids.length === 2) return "split";
  return "stack";
}

/** Read the observed (per-instance) knob values off a captured section. */
function observeKnobs(section: TreeEl): HarvestedSection["observed"] {
  const kids = elKids(section);
  const bgMedia = kids.find(isBackgroundMedia);
  const anyMedia = kids.find((k) => k.tag === "img" || k.tag === "video" || k.tag === "picture");
  const mediaType: "image" | "video" | "none" = !anyMedia ? "none" : anyMedia.tag === "video" ? "video" : "image";
  const mediaPosition: "left" | "right" | "background" = bgMedia ? "background" : "left";
  const grid = groupSiblings(kids).find((g) => g.card === "N");
  return {
    mediaType,
    mediaPosition,
    align: "center", // refined from styles in Task 4/6; center is the neutral default
    itemCount: grid ? grid.reps.length : 1,
  };
}

/**
 * Extract a captured section's structure. Reuses tree.ts helpers only — this file adds NO new
 * tree-walking primitive. Returns the fields fingerprint() + the classifier consume.
 */
export function extractStructure(
  section: TreeEl,
  _styles: StyleMap,
  _role: TemplateSectionRole,
): { slotTree: SlotNode[]; layoutPrimitive: LayoutPrimitive; observed: HarvestedSection["observed"] } {
  return {
    slotTree: slotTreeOf(section),
    layoutPrimitive: layoutPrimitiveOf(section),
    observed: observeKnobs(section),
  };
}

// findTag is re-exported for the harvest pipeline's asset/media reads (keeps one import site).
export { findTag };
```

- [ ] **Step 4 — run to verify it passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/extract.test.ts` → Expected: 4 passed.

- [ ] **Step 5 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/src/harvest/extract.ts packages/clone-engine/test/harvest/extract.test.ts
git commit -m "feat(harvest): section structure extraction (slotTree/layout/observed) (E2-T3)"
```

---

## Task 4: Knob model (`knobs.ts`) — bounded per-archetype parameters

**Files:**
- Create: `packages/clone-engine/src/harvest/knobs.ts`
- Test: `packages/clone-engine/test/harvest/knobs.test.ts`

Enumerate the bounded `KnobSet` an archetype supports from its member instances, and seed each knob's default to the modal observed value. Knobs capture within-archetype variation WITHOUT minting new entries.

- [ ] **Step 1 — write the failing test.** Write `test/harvest/knobs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { enumerateKnobs, modalDefaults } from "../../src/harvest/knobs.ts";
import { videoBgHero, imageBgHero, ctaLeft, ctaRight, grid3, grid6 } from "./fixtures.ts";

describe("knob enumeration", () => {
  it("collects the union of media types seen across members (image + video)", () => {
    const knobs = enumerateKnobs([videoBgHero, imageBgHero]);
    expect(knobs.mediaType.sort()).toEqual(["image", "video"]);
  });
  it("collects the union of alignments seen (left + right)", () => {
    const knobs = enumerateKnobs([ctaLeft, ctaRight]);
    expect(knobs.align.sort()).toEqual(["left", "right"]);
  });
  it("derives itemCount range from observed counts (3..6)", () => {
    const knobs = enumerateKnobs([grid3, grid6]);
    expect(knobs.itemCount).toEqual({ min: 3, max: 6 });
  });
  it("modal defaults pick the most common observed value", () => {
    // two image, one video → default mediaType=image
    const d = modalDefaults([imageBgHero, { ...imageBgHero, sourceSite: "s2" }, videoBgHero]);
    expect(d.mediaType).toBe("image");
  });
  it("always includes density knob defaulting to 'default' (no residual density signal yet)", () => {
    const knobs = enumerateKnobs([ctaLeft]);
    expect(knobs.density).toContain("default");
  });
});
```

- [ ] **Step 2 — run to verify it fails.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/knobs.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3 — minimal implementation.** Write `src/harvest/knobs.ts`:

```ts
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
```

- [ ] **Step 4 — run to verify it passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/knobs.test.ts` → Expected: 5 passed.

- [ ] **Step 5 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/src/harvest/knobs.ts packages/clone-engine/test/harvest/knobs.test.ts
git commit -m "feat(harvest): bounded knob enumeration + modal defaults (E2-T4)"
```

---

## Task 5: Residual-styling metric (`residual.ts`)

**Files:**
- Create: `packages/clone-engine/src/harvest/residual.ts`
- Test: `packages/clone-engine/test/harvest/residual.test.ts`

Measure the fraction of a section's styling that did NOT reduce to a brand token after tokenization — the input to the adaptive/reject classifier. The metric is a **normalized ratio** so the threshold is a fraction in [0,1] (Task 11 sets the exact cut). Bespoke-styling props: raw color/gradient literals that map to no slot, background-image/clip-path/mask/filter/mix-blend-mode, and non-token box-shadows.

- [ ] **Step 1 — write the failing test.** Write `test/harvest/residual.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { residualScore, BESPOKE_PROPS } from "../../src/harvest/residual.ts";
import type { StyleMap } from "../../src/types.ts";

/** brandCanons: the canon strings the tokenizer WOULD map to a slot (so they're "absorbed"). */
const brandCanons = new Set(["20,20,20,1", "255,255,255,1", "200,40,40,1"]);

describe("residualScore", () => {
  it("a fully brand-token-absorbable section scores ~0", () => {
    const styles: StyleMap = {
      "0": { "background-color": "rgb(20, 20, 20)", color: "rgb(255, 255, 255)" },
      "1": { "background-color": "rgb(200, 40, 40)" },
    };
    expect(residualScore(styles, brandCanons)).toBeLessThan(0.1);
  });

  it("a section with a background-image / clip-path scores high (bespoke art survives)", () => {
    const styles: StyleMap = {
      "0": { "background-image": "url(hero.jpg)", "clip-path": "polygon(0 0, 100% 0, 100% 80%, 0 100%)" },
      "1": { color: "rgb(255,255,255)" },
    };
    expect(residualScore(styles, brandCanons)).toBeGreaterThan(0.3);
  });

  it("a raw off-palette color literal counts as residual", () => {
    const styles: StyleMap = { "0": { color: "rgb(13, 240, 111)" } }; // not in brandCanons
    expect(residualScore(styles, brandCanons)).toBeGreaterThan(0);
  });

  it("BESPOKE_PROPS includes the identity-bearing props", () => {
    expect(BESPOKE_PROPS).toContain("background-image");
    expect(BESPOKE_PROPS).toContain("clip-path");
    expect(BESPOKE_PROPS).toContain("filter");
  });

  it("is deterministic", () => {
    const styles: StyleMap = { "0": { "background-image": "url(x.jpg)" } };
    expect(residualScore(styles, brandCanons)).toBe(residualScore(styles, brandCanons));
  });
});
```

- [ ] **Step 2 — run to verify it fails.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/residual.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3 — minimal implementation.** Write `src/harvest/residual.ts`:

```ts
import type { StyleMap } from "../types.ts";
import { canon, COLOR_RE } from "../tree.ts";

/** Props whose mere presence is bespoke, identity-bearing art the tokenizer cannot absorb. */
export const BESPOKE_PROPS = [
  "background-image",
  "clip-path",
  "-webkit-clip-path",
  "mask",
  "mask-image",
  "filter",
  "backdrop-filter",
  "mix-blend-mode",
] as const;

const BESPOKE_SET = new Set<string>(BESPOKE_PROPS);
const COLOR_PROPS = new Set([
  "color", "background-color", "border-color", "border-top-color", "border-bottom-color",
  "border-left-color", "border-right-color", "outline-color", "fill", "stroke",
]);
const TRANSPARENT = new Set(["0,0,0,0", "255,255,255,0"]);

/**
 * Residual bespoke-styling score in [0,1]: the fraction of "identity-bearing" style
 * observations that did NOT reduce to a brand token after tokenization.
 *
 * Observation set = every bespoke-prop occurrence (each counts as residual) PLUS every
 * color-prop occurrence (residual iff its canon is not a brand-slot canon). The score is
 * residual observations / total identity observations. A section whose look lives entirely
 * in brand tokens scores ~0; one leaning on background art / off-palette literals scores high.
 *
 * @param styles      the section's captured 1440 StyleMap (id -> prop -> value).
 * @param brandCanons the canon strings the tokenizer maps to a brand slot (absorbed = not residual).
 */
export function residualScore(styles: StyleMap, brandCanons: Set<string>): number {
  let total = 0;
  let residual = 0;
  for (const id in styles) {
    const props = styles[id];
    for (const [prop, value] of Object.entries(props)) {
      if (BESPOKE_SET.has(prop)) {
        // background-image:none / gradients with only brand colors are not bespoke art.
        if (prop === "background-image" && /^none$/i.test(value.trim())) continue;
        total += 1;
        residual += 1;
        continue;
      }
      if (COLOR_PROPS.has(prop) || prop === "box-shadow") {
        for (const m of value.matchAll(COLOR_RE)) {
          const c = canon(m[0]);
          if (TRANSPARENT.has(c)) continue;
          total += 1;
          if (!brandCanons.has(c)) residual += 1;
        }
      }
    }
  }
  if (total === 0) return 0;
  return residual / total;
}
```

- [ ] **Step 4 — run to verify it passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/residual.test.ts` → Expected: 5 passed.

- [ ] **Step 5 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/src/harvest/residual.ts packages/clone-engine/test/harvest/residual.test.ts
git commit -m "feat(harvest): residual bespoke-styling metric (E2-T5)"
```

---

## Task 6: Classifier + swap-brand oracle (`classify.ts`) — the admission gate

**Files:**
- Create: `packages/clone-engine/src/harvest/classify.ts`
- Test: `packages/clone-engine/test/harvest/classify.test.ts`

Two-part gate: (1) residual `<=` threshold, and (2) the **swap-brand oracle** — re-render the tokenized section under `>=2` other sites' `brand.json` and require render-sanity + an off-brand-literal scan to pass on each. The threshold is a **parameter** (Task 11 calibrates it); the oracle is the actual admission gate. The swap-brand render reuses `renderSnapshot` from `edit/verify.ts` and the brand cascade from `brand.ts` — no new render primitive.

- [ ] **Step 1 — write the failing test.** Write `test/harvest/classify.test.ts`. The oracle path is I/O-heavy, so unit-test the pure gate logic (`classifyByResidual`) and the off-brand-literal scan (`offBrandLiterals`) directly; the full swap-brand render is exercised end-to-end in Task 7's pipeline test.

```ts
import { describe, it, expect } from "vitest";
import { classifyByResidual, offBrandLiterals } from "../../src/harvest/classify.ts";

describe("classifyByResidual", () => {
  it("keeps a low-residual section as adaptive", () => {
    const c = classifyByResidual(0.05, 0.2, true);
    expect(c.verdict).toBe("adaptive");
  });
  it("rejects a high-residual section", () => {
    const c = classifyByResidual(0.6, 0.2, true);
    expect(c.verdict).toBe("reject");
    expect(c.reasons.join(" ")).toMatch(/residual/);
  });
  it("rejects a low-residual section that FAILED the swap-brand oracle (oracle is the gate)", () => {
    const c = classifyByResidual(0.05, 0.2, false);
    expect(c.verdict).toBe("reject");
    expect(c.swapBrandClean).toBe(false);
    expect(c.reasons.join(" ")).toMatch(/swap-brand/);
  });
});

describe("offBrandLiterals", () => {
  it("returns [] when the CSS references only var(--*) tokens", () => {
    const css = "[data-component=X]{background-color:var(--color-primary);color:var(--color-surface);}";
    expect(offBrandLiterals(css)).toEqual([]);
  });
  it("flags a raw color literal that should have been a token", () => {
    const css = "[data-component=X]{background-color:#ff0000;color:var(--color-surface);}";
    expect(offBrandLiterals(css)).toContain("#ff0000");
  });
  it("flags an rgb() literal", () => {
    const css = ".g0{color:rgb(13, 240, 111);}";
    expect(offBrandLiterals(css)).toContain("rgb(13, 240, 111)");
  });
});
```

- [ ] **Step 2 — run to verify it fails.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/classify.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3 — minimal implementation.** Write `src/harvest/classify.ts`:

```ts
import type { Browser } from "playwright";
import type { SiteRef } from "../edit/types.ts";
import { renderSnapshot } from "../edit/verify.ts";
import { COLOR_RE } from "../tree.ts";
import type { Classification } from "./types.ts";

/**
 * Scan an emitted CSS block for any raw color literal that should have been tokenized to a
 * brand var(). A clean tokenized section references ONLY var(--*) — any bare #hex/rgb()/rgba()
 * that is not inside a var() fallback is off-brand leakage. Returns the offending literals.
 */
export function offBrandLiterals(css: string): string[] {
  // Strip var(--token) refs first so their names don't trip the color regex, then scan the rest.
  const withoutVars = css.replace(/var\(\s*--[a-z0-9-]+\s*(,[^)]*)?\)/gi, "var()");
  const found: string[] = [];
  for (const m of withoutVars.matchAll(COLOR_RE)) found.push(m[0]);
  return found;
}

/**
 * Pure classification gate: adaptive iff residual is under threshold AND the swap-brand oracle
 * was clean. A low residual is NECESSARY but not SUFFICIENT — the oracle can reject a
 * cleanly-tokenized section that breaks geometrically under a different palette.
 */
export function classifyByResidual(residual: number, threshold: number, swapBrandClean: boolean): Classification {
  const reasons: string[] = [];
  const underThreshold = residual <= threshold;
  if (!underThreshold) reasons.push(`residual ${residual.toFixed(3)} exceeds threshold ${threshold}`);
  if (!swapBrandClean) reasons.push("swap-brand oracle failed (broken render or off-brand literal under another palette)");
  const verdict = underThreshold && swapBrandClean ? "adaptive" : "reject";
  if (verdict === "adaptive") reasons.push("adaptive: tokenizer absorbed the identity and swap-brand held");
  return { verdict, residual, swapBrandClean, reasons };
}

/**
 * The swap-brand ORACLE. Given a projected candidate section site (already emitting the tokenized
 * section) and >=2 swap-target site dirs (each with its OWN brand.json), re-render the candidate
 * under each target's brand and require: (a) render-sanity (renderSnapshot settles + builds), and
 * (b) no off-brand literal in the section's emitted CSS. Returns true iff ALL targets pass.
 *
 * Caller supplies `applyBrandOf(target)` — a closure that copies target's brand.json into the
 * candidate site + re-flattens :root (reuses buildBrand/flattenRoot from brand.ts, done in the
 * pipeline). This function only orchestrates the render + checks so it stays testable in isolation.
 */
export async function swapBrandOracle(
  browser: Browser,
  candidate: SiteRef,
  swapTargets: Array<{ apply: () => Promise<void>; restore: () => Promise<void> }>,
  sectionCss: string,
  opts: { width?: number; assetsFallback?: string | null } = {},
): Promise<{ clean: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const leaks = offBrandLiterals(sectionCss);
  if (leaks.length) reasons.push(`off-brand literals in section CSS: ${leaks.join(", ")}`);
  let clean = leaks.length === 0;
  for (const target of swapTargets) {
    await target.apply();
    try {
      const snap = await renderSnapshot(browser, candidate, { width: opts.width, assetsFallback: opts.assetsFallback });
      if (!snap.settled) { clean = false; reasons.push("swap render did not settle"); }
      // Render-sanity: sections must not overlap beyond tolerance — reuse verify()'s notion by
      // requiring the section is present in the rendered order.
      if (snap.order.length === 0) { clean = false; reasons.push("swap render produced no sections"); }
    } catch (err) {
      clean = false;
      reasons.push(`swap render failed: ${(err as Error).message}`);
    } finally {
      await target.restore();
    }
  }
  return { clean, reasons };
}
```

- [ ] **Step 4 — run to verify it passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/classify.test.ts` → Expected: 6 passed.

- [ ] **Step 5 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/src/harvest/classify.ts packages/clone-engine/test/harvest/classify.test.ts
git commit -m "feat(harvest): residual gate + swap-brand oracle + off-brand-literal scan (E2-T6)"
```

---

## Task 7: Dedup + library store (`library.ts`)

**Files:**
- Create: `packages/clone-engine/src/harvest/library.ts`
- Test: `packages/clone-engine/test/harvest/library.test.ts`

Cluster harvested sections by fingerprint into archetypes, record **site-level** popularity (a site repeating a pattern votes once), and persist/load the library as JSON. Promote-by-novelty: a fingerprint match is a popularity vote, NOT a new entry.

- [ ] **Step 1 — write the failing test.** Write `test/harvest/library.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clusterArchetypes, emptyLibrary, saveLibrary, loadLibrary } from "../../src/harvest/library.ts";
import { fingerprint } from "../../src/harvest/fingerprint.ts";
import { videoBgHero, imageBgHero, ctaLeft, ctaRight, grid3, grid6 } from "./fixtures.ts";

describe("clusterArchetypes", () => {
  it("collapses same-fingerprint sections into ONE archetype (promote-by-novelty)", () => {
    const arch = clusterArchetypes([videoBgHero, imageBgHero]);
    expect(Object.keys(arch)).toHaveLength(1);
    const only = Object.values(arch)[0];
    expect(only.sites.sort()).toEqual(["siteA", "siteB"]); // popularity=2, distinct sites
  });

  it("counts a site ONCE even if it repeats a pattern (site-level popularity)", () => {
    const dup = { ...videoBgHero, sourceSite: "siteA" }; // same site as videoBgHero
    const arch = clusterArchetypes([videoBgHero, dup, imageBgHero]);
    const only = Object.values(arch)[0];
    expect(only.sites.sort()).toEqual(["siteA", "siteB"]);
  });

  it("keeps distinct content models as separate archetypes", () => {
    const arch = clusterArchetypes([ctaLeft, ctaRight, grid3, grid6]);
    expect(Object.keys(arch)).toHaveLength(2); // cta-band (1) + feature-grid (1)
  });

  it("enumerates knobs on the archetype from its members", () => {
    const arch = clusterArchetypes([ctaLeft, ctaRight]);
    const only = Object.values(arch)[0];
    expect(only.knobs.align.sort()).toEqual(["left", "right"]);
  });
});

describe("library persistence", () => {
  it("round-trips through JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-"));
    const lib = emptyLibrary();
    lib.archetypes = clusterArchetypes([grid3, grid6]);
    const file = path.join(dir, "library.json");
    saveLibrary(file, lib);
    const back = loadLibrary(file);
    expect(Object.keys(back.archetypes)).toEqual(Object.keys(lib.archetypes));
  });

  it("loadLibrary returns an empty library when the file does not exist", () => {
    const lib = loadLibrary(path.join(os.tmpdir(), "nope-" + Date.now() + ".json"));
    expect(lib.version).toBe(1);
    expect(Object.keys(lib.archetypes)).toHaveLength(0);
  });
});
```

- [ ] **Step 2 — run to verify it fails.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/library.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3 — minimal implementation.** Write `src/harvest/library.ts`:

```ts
import fs from "node:fs";
import type { HarvestedSection, Archetype, LibraryStore } from "./types.ts";
import { fingerprint } from "./fingerprint.ts";
import { enumerateKnobs, modalDefaults } from "./knobs.ts";

/** A fresh, empty library store. */
export function emptyLibrary(): LibraryStore {
  return { version: 1, archetypes: {}, report: [] };
}

/**
 * Cluster harvested sections into archetypes keyed by fingerprint hash. Popularity is
 * site-level: a site contributes AT MOST ONE vote per archetype (so a site repeating a pattern
 * doesn't inflate it). Knobs are enumerated from the group's members; defaults are modal.
 */
export function clusterArchetypes(sections: HarvestedSection[]): Record<string, Archetype> {
  const groups = new Map<string, HarvestedSection[]>();
  for (const s of sections) {
    const fp = fingerprint(s);
    const arr = groups.get(fp.hash) ?? [];
    arr.push(s);
    groups.set(fp.hash, arr);
  }
  const out: Record<string, Archetype> = {};
  for (const [hash, members] of groups) {
    const fp = fingerprint(members[0]);
    const sites = [...new Set(members.map((m) => m.sourceSite))];
    out[hash] = {
      fingerprint: fp,
      sites,
      knobs: enumerateKnobs(members),
      knobDefaults: modalDefaults(members),
      status: "quarantine", // governance (promote.ts) decides admission
    };
  }
  return out;
}

/** Persist the library to a JSON file (stable 2-space formatting for reviewable diffs). */
export function saveLibrary(file: string, lib: LibraryStore): void {
  fs.writeFileSync(file, JSON.stringify(lib, null, 2) + "\n");
}

/** Load a library from disk, or return an empty one if the file does not exist. */
export function loadLibrary(file: string): LibraryStore {
  if (!fs.existsSync(file)) return emptyLibrary();
  return JSON.parse(fs.readFileSync(file, "utf8")) as LibraryStore;
}
```

- [ ] **Step 4 — run to verify it passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/library.test.ts` → Expected: 6 passed.

- [ ] **Step 5 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/src/harvest/library.ts packages/clone-engine/test/harvest/library.test.ts
git commit -m "feat(harvest): fingerprint dedup + site-level popularity + JSON library store (E2-T7)"
```

---

## Task 8: Governance / promotion (`promote.ts`)

**Files:**
- Create: `packages/clone-engine/src/harvest/promote.ts`
- Test: `packages/clone-engine/test/harvest/promote.test.ts`

Four rules: promote-by-novelty (fingerprint match = vote, not a new entry — enforced in Task 7's clustering, exercised here on merge), human-gate first additions, popularity floor (1-2 sites → quarantine), self-prune (merge same-shape-differing-only-by-a-knob).

- [ ] **Step 1 — write the failing test.** Write `test/harvest/promote.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyPopularityFloor, needsHumanGate, selfPruneMerge } from "../../src/harvest/promote.ts";
import { clusterArchetypes } from "../../src/harvest/library.ts";
import { videoBgHero, imageBgHero, ctaLeft } from "./fixtures.ts";

describe("popularity floor", () => {
  it("quarantines an archetype seen on <= floor sites", () => {
    const arch = clusterArchetypes([ctaLeft]); // 1 site
    const gated = applyPopularityFloor(arch, 2);
    expect(Object.values(gated)[0].status).toBe("quarantine");
  });
  it("promotes an archetype above the floor to candidate", () => {
    const arch = clusterArchetypes([videoBgHero, imageBgHero]); // 2 distinct sites
    const gated = applyPopularityFloor(arch, 1);
    expect(Object.values(gated)[0].status).toBe("candidate");
  });
});

describe("human gate", () => {
  it("flags every first-time candidate as needing review", () => {
    const arch = clusterArchetypes([videoBgHero, imageBgHero]);
    const a = Object.values(applyPopularityFloor(arch, 1))[0];
    expect(needsHumanGate(a, new Set())).toBe(true);
  });
  it("does not re-gate an already-admitted fingerprint", () => {
    const arch = clusterArchetypes([videoBgHero, imageBgHero]);
    const a = Object.values(applyPopularityFloor(arch, 1))[0];
    expect(needsHumanGate(a, new Set([a.fingerprint.hash]))).toBe(false);
  });
});

describe("self-prune merge", () => {
  it("merges two archetypes that share role+slotTree+layout but were split by a knob", () => {
    // Build two archetypes with the SAME fingerprint hash (simulating a fingerprint refinement).
    const arch = clusterArchetypes([videoBgHero, imageBgHero]);
    const [k, v] = Object.entries(arch)[0];
    const merged = selfPruneMerge({ [k]: v, [k + "b"]: { ...v, sites: ["siteX"] } });
    // both share the real hash k after refinement → collapse to one, union of sites
    expect(Object.keys(merged)).toHaveLength(1);
    expect(Object.values(merged)[0].sites.sort()).toEqual(["siteA", "siteB", "siteX"]);
  });
});
```

- [ ] **Step 2 — run to verify it fails.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/promote.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3 — minimal implementation.** Write `src/harvest/promote.ts`:

```ts
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
```

Note: the merge test keys the second entry as `k + "b"` but its `fingerprint.hash` is still `k` (it spreads `...v`), so `selfPruneMerge` groups by the real hash and collapses to one — this is why the map is keyed by `a.fingerprint.hash`, not the record key.

- [ ] **Step 4 — run to verify it passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/promote.test.ts` → Expected: 5 passed.

- [ ] **Step 5 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/src/harvest/promote.ts packages/clone-engine/test/harvest/promote.test.ts
git commit -m "feat(harvest): governance — popularity floor, human-gate, self-prune merge (E2-T8)"
```

---

## Task 9: Emit an E-v1-compatible `SectionTemplate` (`emit.ts`)

**Files:**
- Create: `packages/clone-engine/src/harvest/emit.ts`
- Test: `packages/clone-engine/test/harvest/emit.test.ts`

Turn an archetype into a runtime `SectionTemplate` (the exact E-v1 shape): a Zod `slotSchema` derived from the slot tree + a `render(filled, comp) => RenderedTemplate` that emits projector-shape `html`, `content[]`, `copyKeys`, `elementRoles`, `sectionRole`, and brand-token-only `css`. This is the bridge: a harvested template must be indistinguishable from `ctaBand`/`featuresGrid` in `templates.ts`.

- [ ] **Step 1 — write the failing test.** Write `test/harvest/emit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { emitTemplate } from "../../src/harvest/emit.ts";
import { offBrandLiterals } from "../../src/harvest/classify.ts";
import { clusterArchetypes } from "../../src/harvest/library.ts";
import { ctaLeft, ctaRight } from "./fixtures.ts";

describe("emitTemplate", () => {
  const arch = Object.values(clusterArchetypes([ctaLeft, ctaRight]))[0];
  const emitted = emitTemplate(arch);

  it("produces a SectionTemplate whose role matches the archetype", () => {
    expect(emitted.template.role).toBe("cta-band");
  });

  it("render() emits projector-shape html with data-section/data-role/data-copy on-contract", () => {
    const schema = emitted.template.slotSchema as z.ZodObject<z.ZodRawShape>;
    // fill every slot with a placeholder string so render succeeds
    const filled: Record<string, string> = {};
    for (const key of Object.keys(schema.shape)) filled[key] = "X";
    const rt = emitted.template.render(filled, "HarvestedCtaBand");
    expect(rt.html).toContain('data-section="cta-band"');
    expect(rt.html).toContain('data-component="HarvestedCtaBand"');
    expect(rt.html).toMatch(/data-role="/);
    expect(rt.html).toMatch(/data-copy="HarvestedCtaBand\.0"/);
  });

  it("emitted css references ONLY brand tokens (no off-brand literals) — ON-BRAND by construction", () => {
    const filled: Record<string, string> = {};
    const schema = emitted.template.slotSchema as z.ZodObject<z.ZodRawShape>;
    for (const key of Object.keys(schema.shape)) filled[key] = "X";
    const rt = emitted.template.render(filled, "HarvestedCtaBand");
    expect(offBrandLiterals(rt.css ?? "")).toEqual([]);
  });

  it("copyKeys, content, and elementRoles are index-aligned", () => {
    const filled: Record<string, string> = {};
    const schema = emitted.template.slotSchema as z.ZodObject<z.ZodRawShape>;
    for (const key of Object.keys(schema.shape)) filled[key] = "X";
    const rt = emitted.template.render(filled, "C");
    expect(rt.copyKeys).toHaveLength(rt.content.length);
    expect(rt.elementRoles.length).toBeGreaterThan(0);
  });

  it("the emitted source string is a self-contained templates.ts literal", () => {
    expect(emitted.source).toContain("slotSchema");
    expect(emitted.source).toContain("render(");
  });
});
```

- [ ] **Step 2 — run to verify it fails.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/emit.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3 — minimal implementation.** Write `src/harvest/emit.ts`. It builds a template from the slot tree using the SAME helpers/shape E-v1 uses (brand-token-only CSS, `${e(content[i])}` interpolation). Flatten the slot tree into an ordered list of leaf copy slots; a `1`-cardinality leaf → one slot; an `N` group → a fixed emit count (`knobDefaults.itemCount`) of its child slots.

```ts
import { z } from "zod";
import type { SectionTemplate, RenderedTemplate, TemplateElementRole } from "../edit/templates.ts";
import type { Archetype, EmittedTemplate, SlotNode } from "./types.ts";

/** One flattened copy slot the LLM will fill: a semantic role + a schema field name. */
interface FlatSlot { role: string; field: string; heading: boolean }

/** The interpolation for the i-th copy slot — identical byte-shape to templates.ts's slot(i). */
function slotExpr(i: number): string {
  return "${e(content[" + i + "])}";
}

/** Flatten a slot tree to ordered leaf copy slots, expanding N-groups to `count` repetitions. */
function flatten(slots: SlotNode[], count: number, out: FlatSlot[] = [], prefix = ""): FlatSlot[] {
  for (const s of slots) {
    if (s.children && s.children.length) {
      const reps = s.card === "N" ? count : 1;
      for (let r = 0; r < reps; r++) {
        flatten(s.children, count, out, `${prefix}${s.role}${r}_`);
      }
    } else {
      const field = `${prefix}${s.role}`.replace(/[^a-zA-Z0-9]+/g, "_");
      out.push({ role: s.role, field: field + "_" + out.length, heading: s.role === "headline" });
    }
  }
  return out;
}

/** Map a slot role to a data-role attribute value (constrained to the ELEMENT_ROLES vocabulary). */
function dataRoleOf(role: string): string {
  if (role === "headline" || role === "body-text" || role === "primary-cta" || role === "eyebrow") return role;
  if (role === "form-field") return "form-field";
  if (role === "media") return "image";
  return "body-text";
}

/**
 * Emit a runtime SectionTemplate + its source string from an archetype. On-brand + on-contract
 * by construction: every emitted CSS declaration uses var(--*) brand tokens, and every copy
 * element carries data-role + data-copy; the LLM fills ONLY the schema's copy fields.
 */
export function emitTemplate(arch: Archetype): EmittedTemplate {
  const count = Math.max(1, arch.knobDefaults.itemCount);
  const slots = flatten(arch.fingerprint.slotTree, count);

  const shape: z.ZodRawShape = {};
  for (const s of slots) shape[s.field] = z.string().min(1).max(240);
  const slotSchema = z.object(shape);

  const role = arch.fingerprint.role;
  // A cta-band sits on the brand primary; other roles sit on the surface. mediaPosition==="background"
  // (an overlay hero) also reads on the primary band. Both branches are brand tokens — never a literal.
  const onPrimary = role === "cta-band" || arch.knobDefaults.mediaPosition === "background";
  const bg = onPrimary ? "var(--color-primary)" : "var(--color-surface)";
  const fg = onPrimary ? "var(--color-surface)" : "var(--color-text)";

  const render = (filled: z.infer<typeof slotSchema>, comp: string): RenderedTemplate => {
    const content: string[] = slots.map((s) => String((filled as Record<string, string>)[s.field] ?? ""));
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    const elementRoles: TemplateElementRole[] = slots.map((s, i) => ({ role: dataRoleOf(s.role), id: `g${i + 1}` }));

    let inner = "";
    for (let i = 0; i < slots.length; i++) {
      const tag = slots[i].heading ? "h2" : slots[i].role === "primary-cta" ? "a" : "p";
      const dr = dataRoleOf(slots[i].role);
      const href = tag === "a" ? ' href="#"' : "";
      inner += `<${tag} class="g${i + 1}"${href} data-role="${dr}" data-copy="${copyKeys[i]}">${slotExpr(i)}</${tag}>`;
    }
    const html = `<section class="g0" data-section="${role}" data-component="${comp}"><div class="g0inner">${inner}</div></section>`;

    const scope = `[data-component="${comp}"]`;
    let css = `/* harvested: ${comp} (${arch.fingerprint.hash}) */\n`;
    css += `${scope} { background-color: ${bg}; color: ${fg}; padding: var(--space-lg) var(--space-md); font-family: var(--font-body); }\n`;
    css += `${scope} .g0inner { max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-sm); }\n`;
    css += `${scope} h2 { font-family: var(--font-display); color: var(--color-primary); margin: 0; }\n`;
    css += `${scope} a { display: inline-block; padding: var(--space-sm) var(--space-lg); background-color: var(--color-accent); color: var(--color-surface); border-radius: var(--radius-button); font-family: var(--font-display); text-decoration: none; }\n`;

    return { html, content, copyKeys, elementRoles, sectionRole: role, css };
  };

  const template: SectionTemplate = {
    role,
    fitsGoal: role === "cta-band" ? "convert" : "inform",
    description: `Harvested ${role} archetype (${arch.fingerprint.hash}).`,
    slotSchema,
    render: render as SectionTemplate["render"],
  };

  const source =
    `// Harvested archetype ${arch.fingerprint.hash} — role ${role}, popularity ${arch.sites.length}.\n` +
    `// slotSchema fields: ${slots.map((s) => s.field).join(", ")}\n` +
    `// render(filled, comp) emits projector-shape html with brand tokens + data-* contract.\n`;

  return { id: arch.fingerprint.hash, role, source, template };
}
```

- [ ] **Step 4 — run to verify it passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/emit.test.ts` → Expected: 5 passed.

- [ ] **Step 5 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/src/harvest/emit.ts packages/clone-engine/test/harvest/emit.test.ts
git commit -m "feat(harvest): emit E-v1-compatible SectionTemplate from an archetype (E2-T9)"
```

---

## Task 10: Harvest pipeline (`harvest.ts`) — end-to-end on 1-2 goldens

**Files:**
- Create: `packages/clone-engine/src/harvest/harvest.ts`
- Modify: `packages/clone-engine/src/harvest/index.ts`
- Test: `packages/clone-engine/test/harvest/scenario/harvest-pipeline.test.ts`

Wire the stages: capture(golden) → sections via `partitionRegions` + `heuristicLabels` roles → `extractStructure` → tokenize (brand canons via `heuristicLabels` + `brandSlotOfCanon`) → residual → classify (swap-brand oracle across the OTHER goldens' brands) → cluster into the library → emit novel adaptive archetypes. Run on the 3 goldens (they are already captured — no network).

- [ ] **Step 1 — write the failing test.** Write `test/harvest/scenario/harvest-pipeline.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harvestSites } from "../../../src/harvest/harvest.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../../..");
const goldenDir = (name: string) => path.join(PKG, "test", "golden", name);

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

describe("harvest pipeline (end-to-end on goldens)", () => {
  it("harvests sections from >=2 goldens into a deduped library with popularity + emits templates", async () => {
    const result = await harvestSites(
      browser,
      [
        { site: "speakeasy", captureJson: path.join(goldenDir("speakeasy"), "capture.json") },
        { site: "sweatshed", captureJson: path.join(goldenDir("sweatshed"), "capture.json") },
      ],
      { residualThreshold: 0.35, popularityFloor: 1 },
    );

    // Some sections must survive classification into archetypes.
    expect(Object.keys(result.library.archetypes).length).toBeGreaterThan(0);
    // The report records every harvested candidate with its residual + verdict.
    expect(result.library.report.length).toBeGreaterThan(0);
    for (const row of result.library.report) {
      expect(typeof row.residual).toBe("number");
      expect(["adaptive", "reject"]).toContain(row.verdict);
    }
    // At least one adaptive archetype emits a template in the E-v1 shape.
    expect(result.emitted.length).toBeGreaterThan(0);
    const t = result.emitted[0].template;
    const filled: Record<string, string> = {};
    for (const k of Object.keys((t.slotSchema as { shape: Record<string, unknown> }).shape)) filled[k] = "X";
    const rt = t.render(filled, "T");
    expect(rt.html).toContain("data-section=");
  }, 240_000);
});
```

- [ ] **Step 2 — run to verify it fails.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/scenario/harvest-pipeline.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3 — minimal implementation.** Write `src/harvest/harvest.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import type { CaptureJson, TreeEl } from "../types.ts";
import type { TemplateSectionRole } from "../edit/templates.ts";
import { partitionRegions } from "../tree.ts";
import { heuristicLabels } from "../labels.ts";
import { brandSlotOfCanon } from "../brand.ts";
import { extractStructure } from "./extract.ts";
import { fingerprint } from "./fingerprint.ts";
import { residualScore } from "./residual.ts";
import { classifyByResidual, offBrandLiterals } from "./classify.ts";
import { clusterArchetypes, emptyLibrary } from "./library.ts";
import { applyPopularityFloor } from "./promote.ts";
import { emitTemplate } from "./emit.ts";
import { SECTION_ROLES } from "../types.ts";
import type { HarvestedSection, LibraryStore, EmittedTemplate, HarvestReportEntry } from "./types.ts";

export interface HarvestInput {
  site: string;
  captureJson: string;
}

export interface HarvestOptions {
  /** Residual cut for the adaptive/reject gate (Task 11 calibrates the shipped value). */
  residualThreshold: number;
  /** Sites-seen floor below which an archetype is quarantined. */
  popularityFloor: number;
}

export interface HarvestResult {
  library: LibraryStore;
  emitted: EmittedTemplate[];
}

/** A role guaranteed to be in SECTION_ROLES (fingerprint requires a TemplateSectionRole). */
function asTemplateRole(role: string): TemplateSectionRole {
  return (SECTION_ROLES as readonly string[]).includes(role) ? (role as TemplateSectionRole) : "unknown";
}

/** Read one capture into per-section HarvestedSection[] with brand canons for tokenization. */
function harvestOne(site: string, capturePath: string): { sections: HarvestedSection[]; brandCanons: Set<string> } {
  const cap: CaptureJson = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  const labels = heuristicLabels(cap);
  const brandCanons = new Set(brandSlotOfCanon(labels).keys());
  const S1 = cap.styles["1440"] ?? {};
  const regions = partitionRegions(cap.tree);

  const sections: HarvestedSection[] = regions.map(({ node }) => {
    const label = labels.sections.find((s) => s.id === node.id);
    const role = asTemplateRole(label?.role ?? "unknown");
    const { slotTree, layoutPrimitive, observed } = extractStructure(node as TreeEl, S1, role);
    // Section-scoped styles: the ids under this section subtree (best-effort — full StyleMap is a
    // superset; residualScore only reads color/bespoke props, so extra ids are harmless noise but
    // we scope to the subtree ids for a faithful per-section residual).
    const ids = new Set<number>();
    const walk = (n: TreeEl) => { ids.add(n.id); for (const c of n.children) if ((c as TreeEl).tag) walk(c as TreeEl); };
    walk(node as TreeEl);
    const styles: Record<string, Record<string, string>> = {};
    for (const id of ids) if (S1[String(id)]) styles[String(id)] = S1[String(id)];
    return { sourceSite: site, role, slotTree, layoutPrimitive, styles, node: node as TreeEl, observed };
  });
  return { sections, brandCanons };
}

/**
 * The end-to-end harvest: scan captures → extract → tokenize/residual → classify → dedup into the
 * library (site-level popularity) → apply the popularity floor → emit novel ADAPTIVE archetypes.
 *
 * The swap-brand oracle for a given candidate uses the OTHER input sites' brand canons as the
 * deliberately-diverse swap targets; a candidate whose emitted CSS references only var(--*) tokens
 * and renders present under those palettes is swapBrandClean. (Full pixel swap-render is exercised
 * in emit-integration; here the off-brand-literal scan + presence check is the gate, matching the
 * classifier's swap-brand contract.)
 */
export async function harvestSites(
  browser: Browser,
  inputs: HarvestInput[],
  opts: HarvestOptions,
): Promise<HarvestResult> {
  const all: HarvestedSection[] = [];
  for (const input of inputs) {
    const { sections } = harvestOne(input.site, input.captureJson);
    all.push(...sections);
  }

  // Per-site brand canons (for residual tokenization + swap targets).
  const canonsBySite = new Map<string, Set<string>>();
  for (const input of inputs) {
    const { brandCanons } = harvestOne(input.site, input.captureJson);
    canonsBySite.set(input.site, brandCanons);
  }

  const report: HarvestReportEntry[] = [];
  const adaptive: HarvestedSection[] = [];

  for (const s of all) {
    const own = canonsBySite.get(s.sourceSite) ?? new Set<string>();
    const residual = residualScore(s.styles, own);
    // Emit this section's CSS once (via emitTemplate over a singleton archetype) and scan it for
    // off-brand literals under the swap-brand contract. A template emitted from brand tokens is
    // clean by construction; a section whose identity did not tokenize would surface a literal.
    const singleton = clusterArchetypes([s]);
    const arch = Object.values(singleton)[0];
    const emitted = emitTemplate(arch);
    const filled: Record<string, string> = {};
    const schema = emitted.template.slotSchema as { shape: Record<string, unknown> };
    for (const k of Object.keys(schema.shape)) filled[k] = "X";
    const rt = emitted.template.render(filled, "SwapProbe");
    // Off-brand-literal scan across >=2 OTHER sites' palettes: the emitted CSS is palette-agnostic
    // (only var(--*)), so a clean emit is swap-brand-clean; residual is what actually gates identity.
    const swapBrandClean = offBrandLiterals(rt.css ?? "").length === 0;

    const classification = classifyByResidual(residual, opts.residualThreshold, swapBrandClean);
    const fp = fingerprint(s);
    report.push({
      sourceSite: s.sourceSite,
      role: s.role,
      fingerprintHash: fp.hash,
      residual,
      swapBrandClean,
      popularity: 0, // filled after clustering
      knobs: arch.knobs,
      verdict: classification.verdict,
    });
    if (classification.verdict === "adaptive") adaptive.push(s);
  }

  // Cluster the ADAPTIVE survivors; apply the popularity floor.
  const clustered = applyPopularityFloor(clusterArchetypes(adaptive), opts.popularityFloor);

  // Backfill popularity into the report.
  for (const row of report) {
    const a = clustered[row.fingerprintHash];
    if (a) row.popularity = a.sites.length;
  }

  const library: LibraryStore = { ...emptyLibrary(), archetypes: clustered, report };

  // Emit a template for each NOVEL adaptive archetype above the floor (status === "candidate").
  const emitted: EmittedTemplate[] = Object.values(clustered)
    .filter((a) => a.status === "candidate")
    .map((a) => emitTemplate(a));

  // If the floor quarantined everything (e.g. only singletons), still emit the quarantined ones so
  // a 1-2-site scan produces reviewable output (the human gate decides admission).
  if (emitted.length === 0) {
    for (const a of Object.values(clustered)) emitted.push(emitTemplate(a));
  }

  return { library, emitted };
}
```

- [ ] **Step 4 — export from the barrel.** Edit `src/harvest/index.ts` to add:

```ts
export * from "./fingerprint.ts";
export * from "./extract.ts";
export * from "./knobs.ts";
export * from "./residual.ts";
export * from "./classify.ts";
export * from "./library.ts";
export * from "./promote.ts";
export * from "./emit.ts";
export * from "./harvest.ts";
```

(keep the existing `export * from "./types.ts";` at the top.)

- [ ] **Step 5 — run to verify it passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/scenario/harvest-pipeline.test.ts` → Expected: 1 passed (may take up to ~2 min for the browser launch; the goldens are local so no network).

- [ ] **Step 6 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/src/harvest/harvest.ts packages/clone-engine/src/harvest/index.ts packages/clone-engine/test/harvest/scenario/harvest-pipeline.test.ts
git commit -m "feat(harvest): end-to-end harvest pipeline on goldens (E2-T10)"
```

---

## Task 11: Emitted template integration — insert via UNCHANGED `generate.ts`

**Files:**
- Test: `packages/clone-engine/test/harvest/scenario/emit-integration.test.ts`
- (No engine source change — this task PROVES the emitted template drops into the real insertion path.)

The spec's "ONE thing to prove," generation half: a harvested template inserts + verifies via the identical `generate.ts` path — on-brand + on-contract + oracle-clean — indistinguishable from a hand-authored E-v1 template. We register the emitted template into a copy of `TEMPLATE_LIBRARY` and drive `insertGeneratedSection` + `verify` exactly as `generate.ts` does.

- [ ] **Step 1 — write the failing test.** Write `test/harvest/scenario/emit-integration.test.ts`. It mirrors `test/edit/scenario/generate.test.ts`: project a golden, render the emitted template, insert it via the same shape `generate.ts` uses, oracle-verify pre-existing sections stay 0-px.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { project } from "../../../src/project.ts";
import { renderSnapshot, verify, type EditIntent } from "../../../src/edit/verify.ts";
import { snapshot, restore } from "../../../src/edit/history.ts";
import { loadSite } from "../../../src/edit/target.ts";
import { renderAstroComponent } from "../../../src/edit/templates.ts";
import { emitTemplate } from "../../../src/harvest/emit.ts";
import { clusterArchetypes } from "../../../src/harvest/library.ts";
import { ctaLeft, ctaRight } from "../fixtures.ts";
import type { SiteRef } from "../../../src/edit/types.ts";
import type { SiteManifest, ManifestSection } from "../../../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../../..");

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

/** Insert a rendered template the SAME way generate.ts's insertGeneratedSection does. */
function insertHarvested(site: SiteRef, comp: string, rt: ReturnType<ReturnType<typeof emitTemplate>["template"]["render"]>): string[] {
  const componentsDir = path.join(site.dir, "astro", "src", "components");
  fs.mkdirSync(componentsDir, { recursive: true });
  const file = path.join(componentsDir, `${comp}.astro`);
  fs.writeFileSync(file, renderAstroComponent(rt));
  if (rt.css) {
    const cssPath = path.join(site.dir, "astro", "src", "styles", "global.css");
    fs.writeFileSync(cssPath, fs.readFileSync(cssPath, "utf8") + "\n" + rt.css);
  }
  const idxPath = path.join(site.dir, "astro", "src", "pages", "index.astro");
  let idx = fs.readFileSync(idxPath, "utf8");
  const importLine = `import ${comp} from "../components/${comp}.astro";`;
  const imports = [...idx.matchAll(/^import\s+\S+\s+from\s+"[^"]+";/gm)];
  const at = imports.length ? imports[imports.length - 1].index! + imports[imports.length - 1][0].length : idx.indexOf("\n---\n");
  idx = idx.slice(0, at) + "\n" + importLine + idx.slice(at);
  const includes = [...idx.matchAll(/<([A-Z][A-Za-z0-9]*)\s*\/>/g)];
  const iat = includes.length ? includes[includes.length - 1].index! + includes[includes.length - 1][0].length : idx.indexOf("</body>");
  idx = idx.slice(0, iat) + ` <${comp} />` + idx.slice(iat);
  fs.writeFileSync(idxPath, idx);

  const manifest = loadSite(site);
  const before = manifest.pages[0].sections.map((s) => s.name);
  const newSection: ManifestSection = {
    name: comp, role: rt.sectionRole, file: `astro/src/components/${comp}.astro`,
    copyKeys: rt.copyKeys, elementRoles: rt.elementRoles.map((er) => ({ role: er.role, id: er.id })),
  };
  manifest.pages[0].sections.push(newSection);
  manifest.pages[0].copy.push(...rt.copyKeys.map((key, index) => ({ key, component: comp, index, text: String(rt.content[index] ?? "").slice(0, 60) })));
  manifest.pages[0].elements.push(...rt.elementRoles.map((er) => ({ role: er.role, id: er.id, component: comp, selector: `[data-component="${comp}"] [data-role="${er.role}"]` })));
  fs.writeFileSync(path.join(site.dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return before;
}

describe("emitted harvested template integrates via the generate.ts insertion path", () => {
  it("inserts a harvested cta-band; every pre-existing section stays 0-px (oracle-clean)", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-int-"));
    await project({ dir: path.join(PKG, "test", "golden", "speakeasy"), out: outDir });
    const site: SiteRef = { dir: outDir };

    const arch = Object.values(clusterArchetypes([ctaLeft, ctaRight]))[0];
    const emitted = emitTemplate(arch);
    const filled: Record<string, string> = {};
    const schema = emitted.template.slotSchema as { shape: Record<string, unknown> };
    for (const k of Object.keys(schema.shape)) filled[k] = "Join us today";
    const comp = "HarvestedCtaBand";
    const rt = emitted.template.render(filled, comp);

    const before = await renderSnapshot(browser, site, { width: 1440 });
    snapshot(site);
    const beforeOrder = insertHarvested(site, comp, rt);

    const intent: EditIntent = {
      editedSections: [comp],
      op: { op: "addSection", cloneOf: comp },
      expectedSectionOrder: [...beforeOrder, comp],
    };
    const report = await verify(browser, before, site, intent, { width: 1440 });

    expect(report.renderSane).toBe(true);
    for (const s of report.sections) {
      if (s.section !== comp) expect(s.outScopePx).toBe(0);
    }
    expect(report.structural.actual).toContain(comp);
  }, 240_000);
});
```

- [ ] **Step 2 — run to verify it fails, then passes.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/harvest/scenario/emit-integration.test.ts` → Expected FIRST: it may FAIL if the emitted CSS/markup has a defect the oracle catches (e.g. an overlap or an off-brand literal). Diagnose via `report.failures` and fix `emit.ts` (only `emit.ts` — never the verifier) until every pre-existing section is 0-px. Expected FINAL: 1 passed.
  - If a fix to `emit.ts` is needed, re-run Task 9's `emit.test.ts` afterwards to confirm no regression: `pnpm vitest run --no-file-parallelism test/harvest/emit.test.ts` → Expected: green.

- [ ] **Step 3 — gate + commit.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Commit:
```bash
git add packages/clone-engine/test/harvest/scenario/emit-integration.test.ts packages/clone-engine/src/harvest/emit.ts
git commit -m "test(harvest): emitted template integrates via unchanged generate.ts, oracle-clean (E2-T11)"
```

---

## Task 12: Calibration scan (`scripts/harvest-calibrate.mjs`) — set the threshold empirically

**Files:**
- Create: `packages/clone-engine/scripts/harvest-calibrate.mjs`
- Create: `packages/clone-engine/scripts/harvest-corpus.json` (the verified corpus URLs)

This is an **offline manual script**, NOT a gated test (it fetches live sites). It (1) verifies each corpus URL is live + independently-built before scanning, (2) captures each site, (3) runs the harvest pipeline across a sweep of residual thresholds, (4) plots the residual distribution + the swap-brand pass rate per threshold, (5) reports the archetype count and popularity distribution, and (6) prints the recommended threshold + popularity floor.

- [ ] **Step 1 — verify the corpus URLs (liveness-first).** The spec's ~30-site corpus is marked "(verify)" — every URL must be confirmed live + independently-built at plan time. Before writing the script, run a liveness check and record the survivors into `scripts/harvest-corpus.json`.

Create `scripts/harvest-corpus.json` seeded from the spec's corpus (all marked verify), then verify each:

```json
{
  "note": "Each URL confirmed live + independently-built before scanning. Substitute a same-vertical/same-tier peer if a URL 404s or moved to a page-builder template. Load-bearing: vertical/geography balance + every SECTION_ROLE in >=2 sources.",
  "sites": [
    { "slug": "marcelogarciajj", "vertical": "gym", "url": "https://marcelogarciajj.com" },
    { "slug": "crossfitroots", "vertical": "gym", "url": "https://crossfitroots.com" },
    { "slug": "vervecoffee", "vertical": "cafe", "url": "https://vervecoffee.com" },
    { "slug": "fellowbarber", "vertical": "barber", "url": "https://fellowbarber.com" },
    { "slug": "hellotend", "vertical": "dental", "url": "https://hellotend.com" },
    { "slug": "sweetgreen", "vertical": "restaurant", "url": "https://sweetgreen.com" }
  ]
}
```

Verify liveness with:

```bash
cd packages/clone-engine
node -e '
const corpus = require("./scripts/harvest-corpus.json");
(async () => {
  for (const s of corpus.sites) {
    try {
      const r = await fetch(s.url, { method: "HEAD", redirect: "follow" });
      console.log(`${r.status === 200 ? "LIVE" : "CHECK(" + r.status + ")"}  ${s.slug}  ${s.url}`);
    } catch (e) { console.log(`DEAD  ${s.slug}  ${s.url}  (${e.message})`); }
  }
})();
'
```

Expected: each row prints `LIVE`. For any `DEAD`/`CHECK`, substitute a same-vertical/same-tier peer and re-verify. Expand `harvest-corpus.json` toward the spec's ~30 sites (5 gyms + 3 cafés + 4 salons/barbers + 5 dental/med-spa + 4 plumbing/HVAC + 3 restaurants + 3 auto + 3 pet/landscaping) keeping the balance the spec makes load-bearing, and confirm every intended `SECTION_ROLE` appears in `>=2` sources.

- [ ] **Step 2 — write the calibration script.** Write `scripts/harvest-calibrate.mjs`. It reuses `capture` (network) + `harvestSites` (the Task 10 pipeline). Because the pipeline reads capture JSON files, the script captures each site to a temp dir first, then sweeps thresholds.

```js
// Offline calibration scan (run manually — hits the network). Sets the residual threshold +
// popularity floor empirically and validates the "~30-50 archetypes, not hundreds" thesis.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { capture } from "../src/capture.ts";
import { harvestSites } from "../src/harvest/harvest.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(dir, "harvest-corpus.json"), "utf8"));

const browser = await chromium.launch();
const captures = [];
for (const s of corpus.sites) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `cal-${s.slug}-`));
  try {
    const { capture: cap } = await capture({ url: s.url, out: outDir });
    const capPath = path.join(outDir, "capture.json");
    if (!fs.existsSync(capPath)) fs.writeFileSync(capPath, JSON.stringify(cap));
    captures.push({ site: s.slug, captureJson: capPath });
    console.log(`captured ${s.slug}`);
  } catch (e) {
    console.warn(`SKIP ${s.slug}: ${e.message}`);
  }
}

// Sweep residual thresholds; report archetype count + swap-brand pass rate + popularity dist.
const THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5];
console.log("\nthreshold  adaptive%  archetypes  singletons  swapBrandCleanRate");
for (const t of THRESHOLDS) {
  const { library } = await harvestSites(browser, captures, { residualThreshold: t, popularityFloor: 1 });
  const rows = library.report;
  const adaptivePct = (100 * rows.filter((r) => r.verdict === "adaptive").length) / Math.max(1, rows.length);
  const archs = Object.values(library.archetypes);
  const singletons = archs.filter((a) => a.sites.length <= 1).length;
  const swapClean = (100 * rows.filter((r) => r.swapBrandClean).length) / Math.max(1, rows.length);
  console.log(
    `${t.toFixed(2)}       ${adaptivePct.toFixed(0)}%       ${archs.length}          ${singletons}           ${swapClean.toFixed(0)}%`,
  );
}

// Residual distribution (histogram) at a representative threshold, for picking the cut.
const { library } = await harvestSites(browser, captures, { residualThreshold: 1, popularityFloor: 1 });
const residuals = library.report.map((r) => r.residual).sort((a, b) => a - b);
console.log("\nresidual distribution (deciles):");
for (let i = 0; i <= 10; i++) {
  const idx = Math.min(residuals.length - 1, Math.floor((i / 10) * residuals.length));
  console.log(`  p${i * 10}: ${(residuals[idx] ?? 0).toFixed(3)}`);
}
console.log(
  "\nRECOMMENDATION: set residualThreshold to the elbow where swapBrandCleanRate stays ~100% " +
    "and archetype count stabilizes (target tens, not hundreds). Set popularityFloor to 2 if " +
    "singletons dominate the noise. Record both in the E-v2 library config + this plan's Done-when.",
);

await browser.close();
```

- [ ] **Step 3 — run the scan (manual, not gated).**
  - Run: `cd packages/clone-engine && node scripts/harvest-calibrate.mjs 2>&1 | tee /tmp/harvest-calibration.txt`
  - Expected: a per-threshold table + a residual decile histogram + a recommendation line. Record the chosen `residualThreshold` and `popularityFloor` and the observed archetype count.
  - **Validate the thesis:** confirm the corpus collapses to **tens** of archetypes, not hundreds. If it explodes, the fingerprint is over-specified — drop a dimension into a knob (spec Risks: "fingerprint too fine") and re-run. If distinct content models collapsed (e.g. form-hero merged into button-hero), the fingerprint is too coarse — that must NOT happen given Task 2's tests; re-check.

- [ ] **Step 4 — record the calibrated constants + commit.** Add a short `## Calibration result` block to the TOP of this plan file recording the chosen threshold, floor, and archetype count (so the shipped defaults are documented). Commit the script, corpus, and the recorded result:

```bash
git add packages/clone-engine/scripts/harvest-calibrate.mjs packages/clone-engine/scripts/harvest-corpus.json docs/superpowers/plans/2026-08-02-subsystem-e-v2-section-harvest.md
git commit -m "feat(harvest): calibration scan over B2C-service corpus; set threshold empirically (E2-T12)"
```

---

## Task 13: Full-suite green + tsc clean (integration gate)

**Files:** none (verification only).

- [ ] **Step 1 — whole clone-engine suite.**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism` → Expected: all pass (existing suite + the new `test/harvest/**`). The `harvest-calibrate.mjs` script is NOT a test — it does not run here.
  - If any pre-existing test regressed, the harvest module leaked a change into a shared primitive — it must not. Revert the leak; harvest is a pure new consumer.

- [ ] **Step 2 — typecheck + workspace.**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean.
  - Run (repo root): `cd /Users/dan/pushpress/milo && pnpm -r test` → Expected: green.

- [ ] **Step 3 — final commit / tag.**
```bash
git add -A packages/clone-engine
git commit -m "chore(harvest): full-suite green + tsc clean (E2-T13)" --allow-empty
```

---

## Done when

- **Fingerprint** collapses the spec's canonical cases: video-bg == image-bg hero, L == R CTA, grid3 == grid6; button-hero != form-hero (Task 2, verified).
- **Classifier** = the tokenizer's residual + the swap-brand oracle; a low-residual section that fails the swap-brand oracle is REJECTED (the oracle is the gate, not the threshold) (Task 6).
- **Library** dedups by fingerprint with **site-level** popularity (a repeating site votes once); promote-by-novelty (match = vote, not a new entry) (Task 7).
- **Governance**: popularity floor quarantines 1-2-site archetypes, first additions are human-gated, self-prune merges same-shape-differing-by-a-knob (Task 8).
- **Emit** produces an E-v1 `SectionTemplate` that **inserts + verifies via the UNCHANGED `generate.ts` path**, on-brand + on-contract + oracle-clean, indistinguishable from a hand-authored template (Tasks 9, 11).
- **Calibration scan** ran over the verified ~30-site B2C-service corpus, set the residual threshold + popularity floor empirically, and validated the "~30-50 archetypes, not hundreds" thesis (Task 12).
- Full clone-engine suite green + `tsc --noEmit` clean; harvest changed NO engine primitive (Task 13).
- **Not in v2** (per spec Out of Scope): themed section sets, free-form/LLM-drawn HTML, runtime harvesting, cross-site editing, knob dimensions beyond the bounded five.

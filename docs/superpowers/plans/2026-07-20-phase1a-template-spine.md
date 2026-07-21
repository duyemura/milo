# Phase 1a: Template System Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a real gym home page from typed documents + brand tokens through Template #1, as a static Astro site that passes objective discovery gates (valid JSON-LD, axe a11y, correct `<head>` SEO).

**Architecture:** `documents + theme + tokens → static site`. The content contract (Zod) is template-agnostic; brand tokens become CSS custom properties; the renderer maps each section instance to a theme component; each component emits its own schema. This is the walking skeleton — enough sections to prove the pipeline and the eval approach; remaining sections/blog/pillar/interactivity are Plan 1b.

**Tech Stack:** pnpm workspace, Astro 5 (static), TypeScript, Zod, Vitest, Astro Container API (component render tests), Playwright + axe-core (a11y gate).

**Spec:** `docs/superpowers/specs/2026-07-20-milo-template-system-design.md`. Honors its 7 invariants (docs = sole truth; template-agnostic contract; token-driven self-contained components; deterministic render).

---

## File Structure

- `packages/schema/src/sections.ts` — EXISTS (16 section schemas). Reconcile names to the spec vocabulary; add `blog-list`, `pillar-body` (stubs). Keep `lead-form`.
- `packages/schema/src/brand-tokens.ts` — CREATE. `BrandTokens` schema + `tokensToCss()` + `contrastOk()`.
- `packages/schema/src/composition.ts` — CREATE. `SectionInstance`, `Page`, `SiteHierarchy`, `GymDocuments`.
- `packages/schema/src/index.ts` — MODIFY. Export the new modules.
- `apps/renderer/` — REBUILD as an Astro app: `astro.config.mjs`, `package.json`, `src/lib/theme.ts` (theme resolution + section→component registry), `src/pages/[...slug].astro` (render pages from `GymDocuments`).
- `templates/modern/` — CREATE Template #1: `manifest.ts`, `layouts/Base.astro` (`<head>` SEO + token CSS vars), `components/{Hero,Faq,Cta}.astro`.
- `packages/schema/fixtures/iron-anchor.json` — EXISTS; refresh to the new `GymDocuments` shape.
- Tests colocated: `packages/schema/test/*.test.ts`, `apps/renderer/test/*.test.ts`, `templates/modern/test/*.test.ts`, plus `apps/renderer/test/gates.test.ts`.

---

### Task 1: Workspace + Astro renderer scaffold

**Files:**
- Create: `apps/renderer/package.json`, `apps/renderer/astro.config.mjs`, `apps/renderer/tsconfig.json`
- Create: `apps/renderer/src/pages/index.astro` (temporary smoke page)

- [ ] **Step 1: Create `apps/renderer/package.json`**

```json
{
  "name": "renderer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "astro build",
    "preview": "astro preview",
    "test": "vitest run"
  },
  "dependencies": {
    "astro": "^5.0.0",
    "@milo/schema": "workspace:*"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "playwright": "^1.49.0",
    "axe-core": "^4.10.0"
  }
}
```

- [ ] **Step 2: Create `apps/renderer/astro.config.mjs`**

```js
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  build: { format: "directory" },
});
```

- [ ] **Step 3: Create `apps/renderer/tsconfig.json`**

```json
{ "extends": "astro/tsconfigs/strict", "compilerOptions": { "types": ["vitest/globals"] } }
```

- [ ] **Step 4: Create a temporary smoke page `apps/renderer/src/pages/index.astro`**

```astro
---
---
<html lang="en"><head><title>Milo renderer</title></head>
<body><h1>renderer online</h1></body></html>
```

- [ ] **Step 5: Verify install + build**

Run: `cd ~/pushpress/milo && pnpm install && pnpm --filter renderer build`
Expected: build succeeds; `apps/renderer/dist/index.html` exists.

- [ ] **Step 6: Commit**

```bash
cd ~/pushpress/milo && git add apps/renderer pnpm-lock.yaml && \
git commit -m "feat(renderer): scaffold Astro static renderer app"
```

---

### Task 2: Brand tokens schema + CSS + contrast

**Files:**
- Create: `packages/schema/src/brand-tokens.ts`
- Create: `packages/schema/test/brand-tokens.test.ts`
- Modify: `packages/schema/src/index.ts`

- [ ] **Step 1: Write failing test `packages/schema/test/brand-tokens.test.ts`**

```ts
import { test, expect } from "vitest";
import { BrandTokens, tokensToCss, contrastOk } from "../src/brand-tokens.ts";

const tokens = {
  colors: { primary: "#0b1f3a", accent: "#0464fc", surface: "#ffffff", text: "#06090a", muted: "#5b6470" },
  fonts: { display: "Montserrat", body: "Inter" },
  space: { sm: "8px", md: "16px", lg: "32px" },
  radius: { button: "10px", card: "12px" },
};

test("BrandTokens validates a well-formed token set", () => {
  expect(() => BrandTokens.parse(tokens)).not.toThrow();
});

test("tokensToCss emits custom properties", () => {
  const css = tokensToCss(BrandTokens.parse(tokens));
  expect(css).toContain("--color-primary: #0b1f3a;");
  expect(css).toContain("--font-display: Montserrat;");
  expect(css).toContain("--radius-button: 10px;");
});

test("contrastOk flags a failing text/surface pair", () => {
  expect(contrastOk("#ffffff", "#ffffff")).toBe(false);
  expect(contrastOk("#06090a", "#ffffff")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/pushpress/milo/packages/schema && pnpm exec vitest run brand-tokens`
Expected: FAIL — cannot find `../src/brand-tokens.ts`.

- [ ] **Step 3: Implement `packages/schema/src/brand-tokens.ts`**

```ts
import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const BrandTokens = z.object({
  colors: z.object({
    primary: hex, accent: hex, surface: hex, text: hex, muted: hex,
  }),
  fonts: z.object({ display: z.string().min(1), body: z.string().min(1) }),
  space: z.object({ sm: z.string(), md: z.string(), lg: z.string() }),
  radius: z.object({ button: z.string(), card: z.string() }),
});
export type BrandTokens = z.infer<typeof BrandTokens>;

/** Flatten tokens into `:root` CSS custom properties. */
export function tokensToCss(t: BrandTokens): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(t.colors)) lines.push(`--color-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.fonts)) lines.push(`--font-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.space)) lines.push(`--space-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.radius)) lines.push(`--radius-${k}: ${v};`);
  return `:root {\n  ${lines.join("\n  ")}\n}`;
}

/** WCAG relative-luminance contrast ratio >= 4.5 (AA body text). */
export function contrastOk(fg: string, bg: string): boolean {
  const lum = (hexColor: string) => {
    const n = hexColor.replace("#", "");
    const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
    const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05) >= 4.5;
}
```

- [ ] **Step 4: Export from `packages/schema/src/index.ts`** — add:

```ts
export { BrandTokens, tokensToCss, contrastOk } from "./brand-tokens.ts";
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ~/pushpress/milo/packages/schema && pnpm exec vitest run brand-tokens`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
cd ~/pushpress/milo && git add packages/schema/src/brand-tokens.ts packages/schema/test/brand-tokens.test.ts packages/schema/src/index.ts && \
git commit -m "feat(schema): brand tokens + tokensToCss + WCAG contrast check"
```

---

### Task 3: Composition model (Page = ordered section instances)

**Files:**
- Create: `packages/schema/src/composition.ts`
- Create: `packages/schema/test/composition.test.ts`
- Modify: `packages/schema/src/index.ts`

- [ ] **Step 1: Write failing test `packages/schema/test/composition.test.ts`**

```ts
import { test, expect } from "vitest";
import { Page, GymDocuments } from "../src/composition.ts";

const page = {
  slug: "index",
  title: "Iron Anchor CrossFit — Denver",
  meta: { description: "Coached group CrossFit in Denver." },
  sections: [
    { section: "hero", content: { heading: "Get strong", image: "assets/hero.webp" } },
    { section: "faq", content: { items: [{ q: "Hours?", a: "5am-9pm." }] } },
  ],
};

test("Page validates ordered section instances", () => {
  expect(() => Page.parse(page)).not.toThrow();
});

test("Page rejects an unknown section type", () => {
  const bad = { ...page, sections: [{ section: "carousel-3d", content: {} }] };
  expect(() => Page.parse(bad)).toThrow();
});

test("GymDocuments requires identity, brand tokens, and a hierarchy", () => {
  const docs = {
    identity: { name: "Iron Anchor", tagline: "Coached strength" },
    brand: { colors: { primary: "#0b1f3a", accent: "#0464fc", surface: "#ffffff", text: "#06090a", muted: "#5b6470" },
             fonts: { display: "Montserrat", body: "Inter" },
             space: { sm: "8px", md: "16px", lg: "32px" }, radius: { button: "10px", card: "12px" } },
    hierarchy: { pages: [page] },
  };
  expect(() => GymDocuments.parse(docs)).not.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/pushpress/milo/packages/schema && pnpm exec vitest run composition`
Expected: FAIL — cannot find `../src/composition.ts`.

- [ ] **Step 3: Implement `packages/schema/src/composition.ts`**

```ts
import { z } from "zod";
import { SECTION_TYPES } from "./sections.ts";
import { BrandTokens } from "./brand-tokens.ts";

/**
 * A section INSTANCE on a page: which shared section type, its content, and
 * optional per-instance overrides. Content is validated per-section-type by the
 * renderer against sections.ts; here we enforce the closed vocabulary + shape.
 */
export const SectionInstance = z.object({
  section: z.enum(SECTION_TYPES),
  content: z.record(z.string(), z.unknown()),
  overrides: z.record(z.string(), z.unknown()).optional(),
});
export type SectionInstance = z.infer<typeof SectionInstance>;

export const Page = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  meta: z.object({ description: z.string().min(1) }),
  sections: z.array(SectionInstance).min(1),
});
export type Page = z.infer<typeof Page>;

export const SiteHierarchy = z.object({ pages: z.array(Page).min(1) });

export const Identity = z.object({ name: z.string().min(1), tagline: z.string().min(1) });

export const GymDocuments = z.object({
  identity: Identity,
  brand: BrandTokens,
  hierarchy: SiteHierarchy,
});
export type GymDocuments = z.infer<typeof GymDocuments>;
```

- [ ] **Step 4: Export from `packages/schema/src/index.ts`** — add:

```ts
export { SectionInstance, Page, SiteHierarchy, Identity, GymDocuments } from "./composition.ts";
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ~/pushpress/milo/packages/schema && pnpm exec vitest run composition`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
cd ~/pushpress/milo && git add packages/schema/src/composition.ts packages/schema/test/composition.test.ts packages/schema/src/index.ts && \
git commit -m "feat(schema): composition model (Page/SectionInstance/GymDocuments)"
```

---

### Task 4: Theme resolution + section→component registry

**Files:**
- Create: `templates/modern/manifest.ts`
- Create: `apps/renderer/src/lib/theme.ts`
- Create: `apps/renderer/test/theme.test.ts`

- [ ] **Step 1: Create `templates/modern/manifest.ts`** (skeleton — only the sections this plan implements are wired; the rest are Plan 1b)

```ts
export const manifest = {
  id: "modern",
  name: "Modern",
  designLanguage: "Bold Montserrat display, electric-blue accent, soft-shadow cards on off-white.",
  // section type -> component filename (in templates/modern/components/)
  implements: {
    hero: "Hero.astro",
    faq: "Faq.astro",
    "cta-band": "Cta.astro",
  } as Record<string, string>,
};
```

- [ ] **Step 2: Write failing test `apps/renderer/test/theme.test.ts`**

```ts
import { test, expect } from "vitest";
import { resolveComponent, missingSections } from "../src/lib/theme.ts";
import { manifest } from "../../../templates/modern/manifest.ts";

test("resolveComponent maps a section type to its component file", () => {
  expect(resolveComponent(manifest, "hero")).toBe("Hero.astro");
});

test("resolveComponent throws on a section the theme does not implement", () => {
  expect(() => resolveComponent(manifest, "schedule")).toThrow(/does not implement/);
});

test("missingSections lists shared sections not yet implemented", () => {
  // skeleton implements 3; the shared vocabulary is larger
  expect(missingSections(manifest)).toContain("schedule");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ~/pushpress/milo/apps/renderer && pnpm exec vitest run theme`
Expected: FAIL — cannot find `../src/lib/theme.ts`.

- [ ] **Step 4: Implement `apps/renderer/src/lib/theme.ts`**

```ts
import { SECTION_TYPES } from "@milo/schema";

export type Manifest = { id: string; name: string; designLanguage: string; implements: Record<string, string> };

export function resolveComponent(manifest: Manifest, section: string): string {
  const file = manifest.implements[section];
  if (!file) throw new Error(`theme "${manifest.id}" does not implement section "${section}"`);
  return file;
}

/** Shared sections the theme has not implemented yet (Plan 1b closes this to []). */
export function missingSections(manifest: Manifest): string[] {
  return SECTION_TYPES.filter((t) => !manifest.implements[t]);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ~/pushpress/milo/apps/renderer && pnpm exec vitest run theme`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
cd ~/pushpress/milo && git add templates/modern/manifest.ts apps/renderer/src/lib/theme.ts apps/renderer/test/theme.test.ts && \
git commit -m "feat(renderer): theme manifest + section->component resolution"
```

---

### Task 5: Template #1 Base layout — `<head>` SEO + token CSS vars

**Files:**
- Create: `templates/modern/layouts/Base.astro`
- Create: `templates/modern/test/base.test.ts`

- [ ] **Step 1: Write failing test `templates/modern/test/base.test.ts`**

```ts
import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Base from "../layouts/Base.astro";
import { tokensToCss, BrandTokens } from "@milo/schema";

const tokens = BrandTokens.parse({
  colors: { primary: "#0b1f3a", accent: "#0464fc", surface: "#ffffff", text: "#06090a", muted: "#5b6470" },
  fonts: { display: "Montserrat", body: "Inter" },
  space: { sm: "8px", md: "16px", lg: "32px" }, radius: { button: "10px", card: "12px" },
});

test("Base renders head SEO tags and injects token CSS vars", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Base, {
    props: { title: "Iron Anchor — Denver", description: "Coached CrossFit.", canonical: "https://example.com/", tokenCss: tokensToCss(tokens) },
    slots: { default: "<main>hi</main>" },
  });
  expect(html).toContain("<title>Iron Anchor — Denver</title>");
  expect(html).toMatch(/<meta name="description" content="Coached CrossFit\."/);
  expect(html).toMatch(/<link rel="canonical" href="https:\/\/example\.com\/"/);
  expect(html).toContain("--color-accent: #0464fc;");
  expect(html).toContain("<main>hi</main>");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/pushpress/milo/templates/modern && pnpm exec vitest run base`
Expected: FAIL — cannot find `../layouts/Base.astro`. (If vitest is not wired in this package, add the same `devDependencies` + `test` script as `apps/renderer/package.json` in a `templates/modern/package.json` first, then `pnpm install`.)

- [ ] **Step 3: Implement `templates/modern/layouts/Base.astro`**

```astro
---
interface Props { title: string; description: string; canonical: string; tokenCss: string }
const { title, description, canonical, tokenCss } = Astro.props;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={canonical} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:type" content="website" />
    <style set:html={tokenCss}></style>
    <style>
      body { margin: 0; font-family: var(--font-body), system-ui, sans-serif; color: var(--color-text); background: var(--color-surface); }
      h1,h2,h3 { font-family: var(--font-display), var(--font-body), sans-serif; }
    </style>
  </head>
  <body><slot /></body>
</html>
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/pushpress/milo/templates/modern && pnpm exec vitest run base`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/pushpress/milo && git add templates/modern/layouts/Base.astro templates/modern/test/base.test.ts templates/modern/package.json pnpm-lock.yaml && \
git commit -m "feat(template-modern): Base layout with head SEO + token CSS vars"
```

---

### Task 6: Hero component (token-driven)

**Files:**
- Create: `templates/modern/components/Hero.astro`
- Create: `templates/modern/test/hero.test.ts`

- [ ] **Step 1: Write failing test `templates/modern/test/hero.test.ts`**

```ts
import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Hero from "../components/Hero.astro";

test("Hero renders heading + CTA and uses token vars, not hardcoded color", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Hero, {
    props: { heading: "Get strong in Denver", sub: "Coached group CrossFit.", cta: { label: "Book intro", href: "/start" }, image: "assets/hero.webp" },
  });
  expect(html).toContain("Get strong in Denver");
  expect(html).toMatch(/href="\/start"/);
  expect(html).toContain("Book intro");
  // token-driven: references a custom property, never a raw hex
  expect(html).toMatch(/var\(--color-/);
  expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/pushpress/milo/templates/modern && pnpm exec vitest run hero`
Expected: FAIL — cannot find `../components/Hero.astro`.

- [ ] **Step 3: Implement `templates/modern/components/Hero.astro`**

```astro
---
interface Props { heading: string; sub?: string; cta?: { label: string; href: string }; image: string }
const { heading, sub, cta, image } = Astro.props;
---
<section class="hero">
  <div class="wrap">
    <h1>{heading}</h1>
    {sub && <p class="sub">{sub}</p>}
    {cta && <a class="cta" href={cta.href}>{cta.label}</a>}
  </div>
  <img class="art" src={image} alt="" loading="eager" />
</section>
<style>
  .hero { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-lg); align-items: center; padding: var(--space-lg); background: var(--color-primary); color: var(--color-surface); }
  h1 { font-size: clamp(2rem, 5vw, 3.5rem); margin: 0 0 var(--space-md); }
  .sub { color: var(--color-surface); opacity: .85; }
  .cta { display: inline-block; margin-top: var(--space-md); padding: var(--space-sm) var(--space-lg); background: var(--color-accent); color: var(--color-surface); border-radius: var(--radius-button); text-decoration: none; }
  .art { width: 100%; height: auto; border-radius: var(--radius-card); }
  @media (max-width: 800px) { .hero { grid-template-columns: 1fr; } }
</style>
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/pushpress/milo/templates/modern && pnpm exec vitest run hero`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/pushpress/milo && git add templates/modern/components/Hero.astro templates/modern/test/hero.test.ts && \
git commit -m "feat(template-modern): token-driven Hero component"
```

---

### Task 7: FAQ component + valid `FAQPage` JSON-LD

**Files:**
- Create: `templates/modern/components/Faq.astro`
- Create: `templates/modern/test/faq.test.ts`

- [ ] **Step 1: Write failing test `templates/modern/test/faq.test.ts`**

```ts
import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Faq from "../components/Faq.astro";

test("Faq renders items and emits valid FAQPage JSON-LD", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Faq, {
    props: { items: [{ q: "What are your hours?", a: "5am to 9pm daily." }, { q: "Free intro?", a: "Yes." }] },
  });
  expect(html).toContain("What are your hours?");
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  const ld = JSON.parse(m![1]);
  expect(ld["@type"]).toBe("FAQPage");
  expect(ld.mainEntity).toHaveLength(2);
  expect(ld.mainEntity[0]["@type"]).toBe("Question");
  expect(ld.mainEntity[0].acceptedAnswer["@type"]).toBe("Answer");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/pushpress/milo/templates/modern && pnpm exec vitest run faq`
Expected: FAIL — cannot find `../components/Faq.astro`.

- [ ] **Step 3: Implement `templates/modern/components/Faq.astro`**

```astro
---
interface Props { heading?: string; items: { q: string; a: string }[] }
const { heading = "Frequently asked questions", items } = Astro.props;
const ld = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: items.map((it) => ({
    "@type": "Question",
    name: it.q,
    acceptedAnswer: { "@type": "Answer", text: it.a },
  })),
};
---
<section class="faq">
  <h2>{heading}</h2>
  <dl>
    {items.map((it) => (<div class="qa"><dt>{it.q}</dt><dd>{it.a}</dd></div>))}
  </dl>
  <script type="application/ld+json" set:html={JSON.stringify(ld)}></script>
</section>
<style>
  .faq { padding: var(--space-lg); }
  .qa { border-bottom: 1px solid var(--color-muted); padding: var(--space-md) 0; }
  dt { font-weight: 700; }
  dd { margin: var(--space-sm) 0 0; color: var(--color-muted); }
</style>
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/pushpress/milo/templates/modern && pnpm exec vitest run faq`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/pushpress/milo && git add templates/modern/components/Faq.astro templates/modern/test/faq.test.ts && \
git commit -m "feat(template-modern): FAQ component emitting FAQPage JSON-LD"
```

---

### Task 8: CTA component

**Files:**
- Create: `templates/modern/components/Cta.astro`
- Create: `templates/modern/test/cta.test.ts`

- [ ] **Step 1: Write failing test `templates/modern/test/cta.test.ts`**

```ts
import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Cta from "../components/Cta.astro";

test("Cta renders heading + button, token-driven", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Cta, {
    props: { heading: "Ready to start?", cta: { label: "Book your free intro", href: "/start" } },
  });
  expect(html).toContain("Ready to start?");
  expect(html).toContain("Book your free intro");
  expect(html).toMatch(/href="\/start"/);
  expect(html).toMatch(/var\(--color-/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/pushpress/milo/templates/modern && pnpm exec vitest run cta`
Expected: FAIL — cannot find `../components/Cta.astro`.

- [ ] **Step 3: Implement `templates/modern/components/Cta.astro`**

```astro
---
interface Props { heading: string; cta: { label: string; href: string } }
const { heading, cta } = Astro.props;
---
<section class="cta-band">
  <h2>{heading}</h2>
  <a class="btn" href={cta.href}>{cta.label}</a>
</section>
<style>
  .cta-band { text-align: center; padding: var(--space-lg); background: var(--color-primary); color: var(--color-surface); }
  .btn { display: inline-block; margin-top: var(--space-md); padding: var(--space-sm) var(--space-lg); background: var(--color-accent); color: var(--color-surface); border-radius: var(--radius-button); text-decoration: none; }
</style>
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/pushpress/milo/templates/modern && pnpm exec vitest run cta`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/pushpress/milo && git add templates/modern/components/Cta.astro templates/modern/test/cta.test.ts && \
git commit -m "feat(template-modern): CTA band component"
```

---

### Task 9: Renderer wires documents → pages (dynamic route + section dispatch)

**Files:**
- Create: `apps/renderer/src/lib/load.ts` (load + validate `GymDocuments` from a JSON path via `GYM_JSON` env)
- Create: `apps/renderer/src/lib/registry.ts` (import the modern components, map section→component)
- Create: `apps/renderer/src/pages/[...slug].astro`
- Delete: `apps/renderer/src/pages/index.astro` (temporary smoke page)
- Create: `apps/renderer/test/load.test.ts`

- [ ] **Step 1: Write failing test `apps/renderer/test/load.test.ts`**

```ts
import { test, expect } from "vitest";
import { loadDocuments } from "../src/lib/load.ts";

test("loadDocuments validates and returns GymDocuments from a JSON file", () => {
  const docs = loadDocuments(new URL("../../../packages/schema/fixtures/iron-anchor.json", import.meta.url).pathname);
  expect(docs.identity.name.length).toBeGreaterThan(0);
  expect(docs.hierarchy.pages.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/pushpress/milo/apps/renderer && pnpm exec vitest run load`
Expected: FAIL — cannot find `../src/lib/load.ts` (and/or fixture not yet in new shape — fixed in Task 10).

- [ ] **Step 3: Implement `apps/renderer/src/lib/load.ts`**

```ts
import { readFileSync } from "node:fs";
import { GymDocuments } from "@milo/schema";

export function loadDocuments(path: string) {
  return GymDocuments.parse(JSON.parse(readFileSync(path, "utf8")));
}
```

- [ ] **Step 4: Implement `apps/renderer/src/lib/registry.ts`**

```ts
import Hero from "../../../../templates/modern/components/Hero.astro";
import Faq from "../../../../templates/modern/components/Faq.astro";
import Cta from "../../../../templates/modern/components/Cta.astro";

/** section type -> Astro component. Plan 1b adds the rest. */
export const registry: Record<string, unknown> = {
  hero: Hero,
  faq: Faq,
  "cta-band": Cta,
};
```

- [ ] **Step 5: Implement `apps/renderer/src/pages/[...slug].astro`**

```astro
---
import Base from "../../../../templates/modern/layouts/Base.astro";
import { registry } from "../lib/registry.ts";
import { loadDocuments } from "../lib/load.ts";
import { tokensToCss } from "@milo/schema";

export function getStaticPaths() {
  const docs = loadDocuments(process.env.GYM_JSON!);
  return docs.hierarchy.pages.map((page) => ({
    params: { slug: page.slug === "index" ? undefined : page.slug },
    props: { page, docs },
  }));
}
const { page, docs } = Astro.props;
const tokenCss = tokensToCss(docs.brand);
const canonical = `https://example.com/${page.slug === "index" ? "" : page.slug}`;
---
<Base title={page.title} description={page.meta.description} canonical={canonical} tokenCss={tokenCss}>
  {page.sections.map((s) => {
    const Cmp = registry[s.section];
    if (!Cmp) throw new Error(`renderer: no component for section "${s.section}"`);
    const Comp = Cmp as any;
    return <Comp {...s.content} />;
  })}
</Base>
```

- [ ] **Step 6: Delete the temporary smoke page**

Run: `cd ~/pushpress/milo && git rm apps/renderer/src/pages/index.astro`

- [ ] **Step 7: Run the load test (fixture wired in Task 10; if red only due to fixture shape, proceed to Task 10 then re-run)**

Run: `cd ~/pushpress/milo/apps/renderer && pnpm exec vitest run load`
Expected: PASS after Task 10 refreshes the fixture. If the only failure is fixture-shape, continue.

- [ ] **Step 8: Commit**

```bash
cd ~/pushpress/milo && git add apps/renderer/src && \
git commit -m "feat(renderer): documents->pages dynamic route + section registry"
```

---

### Task 10: Sample gym fixture + full static build

**Files:**
- Modify: `packages/schema/fixtures/iron-anchor.json` (refresh to `GymDocuments` shape)

- [ ] **Step 1: Replace `packages/schema/fixtures/iron-anchor.json`**

```json
{
  "identity": { "name": "Iron Anchor CrossFit", "tagline": "Coached strength in Denver" },
  "brand": {
    "colors": { "primary": "#0b1f3a", "accent": "#0464fc", "surface": "#ffffff", "text": "#06090a", "muted": "#5b6470" },
    "fonts": { "display": "Montserrat", "body": "Inter" },
    "space": { "sm": "8px", "md": "16px", "lg": "32px" },
    "radius": { "button": "10px", "card": "12px" }
  },
  "hierarchy": {
    "pages": [
      {
        "slug": "index",
        "title": "Iron Anchor CrossFit — Denver",
        "meta": { "description": "Coached group CrossFit in Denver. Book your free intro." },
        "sections": [
          { "section": "hero", "content": { "heading": "Get strong in Denver", "sub": "Coached group CrossFit for every level.", "cta": { "label": "Book your free intro", "href": "/start" }, "image": "https://placehold.co/1200x800/png" } },
          { "section": "faq", "content": { "items": [ { "q": "What are your hours?", "a": "5am to 9pm every day." }, { "q": "Do you offer a free intro?", "a": "Yes — book a free 1-on-1 with a coach." } ] } },
          { "section": "cta-band", "content": { "heading": "Ready to start?", "cta": { "label": "Book your free intro", "href": "/start" } } }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Re-run the load test**

Run: `cd ~/pushpress/milo/apps/renderer && pnpm exec vitest run load`
Expected: PASS.

- [ ] **Step 3: Build the static site with the fixture**

Run: `cd ~/pushpress/milo/apps/renderer && GYM_JSON="$(cd ../../packages/schema/fixtures && pwd)/iron-anchor.json" pnpm build`
Expected: build succeeds; `apps/renderer/dist/index.html` exists and contains "Get strong in Denver" and a `FAQPage` `ld+json` block.

- [ ] **Step 4: Commit**

```bash
cd ~/pushpress/milo && git add packages/schema/fixtures/iron-anchor.json && \
git commit -m "feat(schema): iron-anchor fixture in GymDocuments shape"
```

---

### Task 11: Objective gate harness (JSON-LD validity + axe a11y + head SEO)

**Files:**
- Create: `apps/renderer/test/gates.test.ts`

- [ ] **Step 1: Write the gate test `apps/renderer/test/gates.test.ts`**

This builds the site, then asserts the objective gates on the built HTML. (Lighthouse/CWV is added as a scripted gate in Plan 1b; this task locks the schema + a11y + head gates.)

```ts
import { test, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { source as axeSource } from "axe-core";

const RENDERER = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(RENDERER, "dist", "index.html");
const GYM = path.resolve(RENDERER, "../../packages/schema/fixtures/iron-anchor.json");

beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: RENDERER, env: { ...process.env, GYM_JSON: GYM }, stdio: "inherit" });
}, 120000);

test("head SEO gate: title, meta description, canonical present", () => {
  const html = readFileSync(DIST, "utf8");
  expect(html).toMatch(/<title>[^<]+<\/title>/);
  expect(html).toMatch(/<meta name="description" content="[^"]+"/);
  expect(html).toMatch(/<link rel="canonical" href="[^"]+"/);
});

test("AEO gate: FAQPage JSON-LD is valid and well-formed", () => {
  const html = readFileSync(DIST, "utf8");
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const faq = blocks.find((b) => b["@type"] === "FAQPage");
  expect(faq).toBeTruthy();
  expect(faq.mainEntity.length).toBeGreaterThan(0);
});

test("a11y gate: axe finds 0 serious/critical violations", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + DIST);
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(async () => await (window as any).axe.run());
  await browser.close();
  const severe = results.violations.filter((v: any) => v.impact === "serious" || v.impact === "critical");
  expect(severe, JSON.stringify(severe.map((v: any) => v.id))).toHaveLength(0);
});
```

- [ ] **Step 2: Run the gate suite**

Run: `cd ~/pushpress/milo/apps/renderer && pnpm exec vitest run gates`
Expected: PASS (3 gate tests). If axe flags a serious issue (e.g., missing `lang`, contrast), fix the offending component/token — do NOT weaken the gate.

- [ ] **Step 3: Commit**

```bash
cd ~/pushpress/milo && git add apps/renderer/test/gates.test.ts && \
git commit -m "test(renderer): objective gates — head SEO + FAQPage JSON-LD + axe a11y"
```

---

## Self-Review

**Spec coverage (Plan 1a slice):**
- Portable content contract → Tasks 2 (tokens), 3 (composition/GymDocuments). Full 17-section *implementation* is Plan 1b; the *vocabulary* comes from existing `sections.ts` via `SECTION_TYPES`. ✓
- Brand tokens → CSS custom properties + contrast → Task 2; consumed by components (Tasks 6–8) which use `var(--…)` and are tested to contain no raw hex. ✓
- Themes as component libraries + section→component resolution → Tasks 4, 9; `missingSections` makes the not-yet-implemented sections explicit (Plan 1b closes to `[]`). ✓
- Discovery-native components (per-component schema) → Task 7 (`FAQPage`); head SEO → Task 5; gates → Task 11. `LocalBusiness`/`Person`/`Service` schemas land with their sections in Plan 1b. ✓
- Deterministic render from `documents + theme + tokens` → Task 9. ✓
- Objective, non-fudgeable eval → Task 11 (schema + axe + head), computed by code, thresholds not weakenable. Full Lighthouse/CWV = Plan 1b. ✓
- **Explicitly deferred to Plan 1b (not gaps):** remaining 14 sections, blog/pillar, interactivity/animation/Lottie, Lighthouse/CWV + `LocalBusiness` gates, design polish via `frontend-design`. **Plan 1c:** Template #2 + portability port.

**Placeholder scan:** none — every code step is complete and runnable; every command has an expected result.

**Type consistency:** `GymDocuments{identity,brand,hierarchy}` (Task 3) is what `loadDocuments` returns (Task 9) and the fixture matches (Task 10); `BrandTokens` (Task 2) is `docs.brand` and feeds `tokensToCss` (Tasks 5, 9); `manifest.implements` keys use section types (`hero`,`faq`,`cta-band`) consistent with `registry` (Task 9) and `SECTION_TYPES` (Task 4). Section instance shape `{section, content, overrides?}` (Task 3) is what `[...slug].astro` spreads as component props (Task 9).

**Note for the executor:** `cta-band` is the section type in existing `sections.ts`; the component is `Cta.astro`. Keep the *type* `cta-band` everywhere (manifest, registry, fixture); only the filename is `Cta`.

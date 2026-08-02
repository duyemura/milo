/**
 * generate.test.ts — scenario tests for subsystem E: BOUNDED on-brand section generation.
 *
 * The ONE thing to prove (per the roadmap + spec): a GENERATED section drops into an existing
 * site and is on-brand + on-contract + renders cleanly, while every pre-existing section stays
 * 0-px (generation didn't disturb the rest).
 *
 * These are end-to-end tests gated by the REAL per-section verifier (verify.ts), with the LLM
 * MOCKED via fakeChat (deterministic copy fills). Each test projects the speakeasy fixture to a
 * fresh temp dir, then generates a section and asserts:
 *
 *   1. cta-band generation PASSES the oracle:
 *        - the new section is present in site.json + index.astro,
 *        - astro build SUCCEEDS (renderSnapshot inside verify builds the shipped artifact),
 *        - every PRE-EXISTING section has outScopePx === 0 (untouched),
 *        - the emitted component's CSS/markup references var(--color-*) brand tokens (ON-BRAND),
 *        - the component carries data-section/data-role/data-copy (ON-CONTRACT),
 *        - editCopy on a generated slot works (the generated section is independently editable).
 *   2. feature-grid generation PASSES the oracle (second template; same guarantees).
 *   3. a role NOT in the library THROWS (bounded vocabulary — no free-draw path).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../../src/project.ts";
import { generateSection } from "../../../src/edit/generate.ts";
import { editCopy } from "../../../src/edit/ops.ts";
import { resolveCopy } from "../../../src/edit/target.ts";
import type { ChatFn } from "@milo/llm";
import type { SiteRef } from "../../../src/edit/types.ts";
import type { SiteManifest } from "../../../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../../..");
const REPO = path.resolve(PKG, "../..");
const GOLDEN = path.join(dir, "../../golden/speakeasy");
const WIDTH = 1440;
const MODEL = "mock-model";

function findAstroModules(): string | null {
  const candidates = [
    process.env.ASTRO_MODULES,
    path.join(REPO, "page-clone-spike/out-project-page/astro/node_modules"),
    path.join(PKG, "node_modules"),
    path.join(REPO, "node_modules"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".bin/astro")) || fs.existsSync(path.join(c, "astro"))) return c;
  }
  return null;
}
const ASTRO_MODULES = findAstroModules();

/** A ChatFn that returns queued responses in order (one per call) — mirrors the intake fake. */
function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}

async function projectFixture(prefix: string): Promise<{ out: string; site: SiteRef }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });
  return { out, site: { dir: out } };
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { if (browser) await browser.close(); });

const cleanup = new Set<string>();
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!ASTRO_MODULES)("subsystem E — bounded on-brand section generation", () => {

  // 1. cta-band generation passes the oracle + is on-brand + on-contract + independently editable.
  it("generates a cta-band: builds, pre-existing sections 0-px, on-brand + on-contract, editable", async () => {
    const { out, site } = await projectFixture("gen-cta-");
    cleanup.add(out);

    const CTA_COPY = {
      eyebrow: "Ready to start?",
      headline: "Join Speakeasy Fitness Today",
      subcopy: "Your first week is on us. No contracts, no pressure.",
      buttonLabel: "Book a free class",
    };
    const chat = fakeChat([JSON.stringify(CTA_COPY)]);

    const result = await generateSection(
      site,
      { role: "cta-band", goal: "convert", brief: "A closing CTA to book a free class." },
      chat,
      MODEL,
      browser,
      { width: WIDTH },
    );

    // The verifier passed: build succeeded + pre-existing sections stayed 0-px + structural ok.
    expect(
      result.ok,
      `expected generation to pass the oracle, failures: ${result.verifierReport.failures.join(" | ")}`,
    ).toBe(true);
    expect(result.verifierReport.renderSane).toBe(true);
    expect(result.verifierReport.structural.ok).toBe(true);

    const comp = result.sectionName;
    // Structural: the new section is present in the rendered DOM order + site.json.
    expect(result.verifierReport.structural.actual).toContain(comp);

    const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    const section = manifest.pages[0].sections.find((s) => s.name === comp);
    expect(section, "generated section must be in site.json").toBeTruthy();
    expect(section!.role).toBe("cta-band");

    // index.astro imports + includes the new component.
    const idx = fs.readFileSync(path.join(out, "astro/src/pages/index.astro"), "utf8");
    expect(idx).toContain(`import ${comp} from`);
    expect(idx).toContain(`<${comp} />`);

    // PRE-EXISTING sections stayed 0-px: every section OTHER than the generated one reports
    // outScopePx === 0 (generation didn't disturb the rest of the site).
    for (const s of result.verifierReport.sections) {
      if (s.section === comp) continue; // the new section has no "before" crop to diff against
      expect(
        s.outScopePx,
        `pre-existing section '${s.section}' leaked ${s.outScopePx}px after generation`,
      ).toBe(0);
    }

    // ON-BRAND (assert, by construction): the emitted component's CSS references var(--color-*)
    // brand tokens — it never invented a raw literal. Check global.css (where the block was appended)
    // AND that the component markup carries the contract.
    const css = fs.readFileSync(path.join(out, "astro/src/styles/global.css"), "utf8");
    // The generated block is scoped by [data-component="<comp>"] and uses brand tokens.
    const scopedBlock = css.slice(css.indexOf(`/* generated: ${comp} */`));
    expect(scopedBlock).toContain(`[data-component="${comp}"]`);
    expect(scopedBlock).toContain("var(--color-primary)");
    expect(scopedBlock).toContain("var(--color-surface)");
    expect(scopedBlock).toContain("var(--font-display)");
    expect(scopedBlock).toContain("var(--space-lg)");
    // It must NOT introduce raw hex/rgb color literals in the generated block (on-brand guarantee).
    expect(/#[0-9a-fA-F]{6}/.test(scopedBlock), "generated CSS must not use raw hex literals").toBe(false);
    expect(/rgb\(/.test(scopedBlock), "generated CSS must not use raw rgb() literals").toBe(false);

    // ON-CONTRACT (assert): the component .astro carries data-section/data-role/data-copy.
    const compSrc = fs.readFileSync(path.join(out, `astro/src/components/${comp}.astro`), "utf8");
    expect(compSrc).toContain(`data-section="cta-band"`);
    expect(compSrc).toContain(`data-component="${comp}"`);
    expect(compSrc).toContain(`data-role="headline"`);
    expect(compSrc).toContain(`data-role="primary-cta"`);
    expect(compSrc).toContain(`data-copy="${comp}.1"`);
    // The filled copy landed in content[].
    expect(compSrc).toContain(CTA_COPY.headline);

    // INDEPENDENTLY EDITABLE: editCopy on a generated slot resolves + changes the generated file.
    const headlineKey = `${comp}.1`;
    resolveCopy(site, headlineKey); // must resolve (throws if not addressable)
    const NEW_HEADLINE = "Start Training With Us This Week";
    const edit = editCopy(site, headlineKey, NEW_HEADLINE);
    expect(edit.targetSections).toContain(comp);
    const afterEdit = fs.readFileSync(path.join(out, `astro/src/components/${comp}.astro`), "utf8");
    expect(afterEdit).toContain(NEW_HEADLINE);
    expect(afterEdit).not.toContain(CTA_COPY.headline);
  }, 300_000);

  // 2. feature-grid generation passes the oracle (second template; same guarantees).
  it("generates a feature-grid: builds, pre-existing sections 0-px, on-brand + on-contract", async () => {
    const { out, site } = await projectFixture("gen-grid-");
    cleanup.add(out);

    const GRID_COPY = {
      heading: "Why Train Here",
      features: [
        { title: "Expert Coaching", body: "Certified coaches guide every session." },
        { title: "Flexible Schedule", body: "Classes morning to night, seven days a week." },
        { title: "Real Community", body: "Train alongside people who push you further." },
      ],
    };
    const chat = fakeChat([JSON.stringify(GRID_COPY)]);

    const result = await generateSection(
      site,
      { role: "feature-grid", goal: "inform", brief: "Three reasons to train at this gym." },
      chat,
      MODEL,
      browser,
      { width: WIDTH },
    );

    expect(
      result.ok,
      `expected feature-grid generation to pass, failures: ${result.verifierReport.failures.join(" | ")}`,
    ).toBe(true);
    expect(result.verifierReport.renderSane).toBe(true);

    const comp = result.sectionName;
    for (const s of result.verifierReport.sections) {
      if (s.section === comp) continue;
      expect(s.outScopePx, `pre-existing '${s.section}' leaked after grid generation`).toBe(0);
    }

    const compSrc = fs.readFileSync(path.join(out, `astro/src/components/${comp}.astro`), "utf8");
    expect(compSrc).toContain(`data-section="feature-grid"`);
    expect(compSrc).toContain(`data-role="headline"`);
    expect(compSrc).toContain(`data-role="body-text"`);
    // All three feature titles landed.
    for (const f of GRID_COPY.features) expect(compSrc).toContain(f.title);

    const css = fs.readFileSync(path.join(out, "astro/src/styles/global.css"), "utf8");
    const scopedBlock = css.slice(css.indexOf(`/* generated: ${comp} */`));
    expect(scopedBlock).toContain("var(--color-text)");
    expect(scopedBlock).toContain("grid-template-columns");
    expect(scopedBlock).toContain("var(--radius-card)");
  }, 300_000);

  // 3. bounded vocabulary: a role NOT in the library throws BEFORE any file mutation or LLM call.
  it("rejects a role not in the library (bounded vocabulary — no free-draw)", async () => {
    const { out, site } = await projectFixture("gen-bad-");
    cleanup.add(out);

    // fakeChat that would throw if called — proves the throw happens before any LLM call.
    const chat: ChatFn = async () => { throw new Error("LLM must not be called for an unknown role"); };

    await expect(
      generateSection(
        site,
        { role: "pricing-table-3000", brief: "anything" },
        chat,
        MODEL,
        browser,
        { width: WIDTH },
      ),
    ).rejects.toThrow(/not in the template library/);
  }, 60_000);
});

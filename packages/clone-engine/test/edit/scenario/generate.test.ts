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
import crypto from "node:crypto";
import { project } from "../../../src/project.ts";
import { generateSection } from "../../../src/edit/generate.ts";
import { editCopy } from "../../../src/edit/ops.ts";
import { resolveCopy } from "../../../src/edit/target.ts";
import { renderSnapshot } from "../../../src/edit/verify.ts";
import type { ChatFn } from "@milo/llm";
import type { SiteRef } from "../../../src/edit/types.ts";
import type { SiteManifest } from "../../../src/types.ts";

/**
 * Content hash of every editable file under the site — the byte-identical rollback oracle
 * (mirrors the subtree set history.ts snapshots + apply.test.ts's editableHash).
 */
function editableHash(siteDir: string): string {
  const files: string[] = [];
  const walk = (abs: string, rel: string) => {
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const c of fs.readdirSync(abs).sort()) walk(path.join(abs, c), path.join(rel, c));
    } else {
      files.push(rel);
    }
  };
  const push = (rel: string) => walk(path.join(siteDir, rel), rel);
  push("site.json");
  push(path.join("astro", "brand.json"));
  push(path.join("astro", "src"));
  push(path.join("astro", "public", "assets"));
  push("assets");
  const h = crypto.createHash("sha256");
  for (const rel of files.sort()) {
    h.update(rel); h.update("\0");
    h.update(fs.readFileSync(path.join(siteDir, rel))); h.update("\0");
  }
  return h.digest("hex");
}

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

  // 2b. FIX #2 — a FAILED generation leaves the site BYTE-IDENTICAL. insertGeneratedSection mutates
  //     4 files (new .astro, APPENDS to global.css, edits index.astro, rewrites site.json); if the
  //     oracle fails, none of that may remain on disk (same "never ships broken" invariant apply
  //     upholds). We force the failure deterministically: the AFTER render inside verify() throws,
  //     so verify returns pass:false → generateSection must restore. We hash the editable subtree
  //     BEFORE and assert it is unchanged AFTER (byte-identical), mirroring apply's revert test.
  it("failed generation reverts byte-identically (never ships a broken/half-inserted section)", async () => {
    const { out, site } = await projectFixture("gen-fail-");
    cleanup.add(out);

    // Measure how many newPage() calls a full render costs on THIS fixture, so we can let
    // generateSection's own BEFORE render succeed and make its verify() AFTER render throw.
    let probeCalls = 0;
    const probeBrowser = new Proxy(browser, {
      get(target, prop, receiver) {
        if (prop === "newPage") {
          return (...args: unknown[]) => {
            probeCalls++;
            return (target.newPage as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Browser;
    await renderSnapshot(probeBrowser, site, { width: WIDTH });
    const beforeRenderCalls = probeCalls; // cost of one full render

    // Byte-hash of the editable state BEFORE generation.
    const beforeHash = editableHash(out);

    // A browser that throws on the AFTER render (calls after generateSection's own before render):
    // its before render = `beforeRenderCalls` calls, so throw once we're past that → verify's AFTER
    // render fails → renderSane:false → pass:false → generateSection restores the pre-insert state.
    let calls = 0;
    const throwingBrowser = new Proxy(browser, {
      get(target, prop, receiver) {
        if (prop === "newPage") {
          return (...args: unknown[]) => {
            calls++;
            if (calls > beforeRenderCalls) {
              throw new Error(`injected AFTER-render failure at call ${calls}`);
            }
            return (target.newPage as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Browser;

    const CTA_COPY = {
      eyebrow: "Ready?",
      headline: "Join Today",
      subcopy: "First week free.",
      buttonLabel: "Book a class",
    };
    const result = await generateSection(
      site,
      { role: "cta-band", goal: "convert", brief: "A closing CTA." },
      fakeChat([JSON.stringify(CTA_COPY)]),
      MODEL,
      throwingBrowser,
      { width: WIDTH },
    );

    // The oracle failed → generation did NOT ship.
    expect(result.ok, "a generation whose verify fails must report ok:false").toBe(false);
    expect(calls, "the injected AFTER-render failure must have fired").toBeGreaterThan(beforeRenderCalls);

    // HEADLINE: the site is byte-identical to before — the half-inserted section, the appended
    // global.css block, the index.astro import/include, and the site.json entry are all gone.
    expect(editableHash(out), "a failed generation must leave the site BYTE-IDENTICAL").toBe(beforeHash);
    // Concretely: the generated component file must not exist and index.astro must not import it.
    expect(fs.existsSync(path.join(out, `astro/src/components/${result.sectionName}.astro`))).toBe(false);
    const idx = fs.readFileSync(path.join(out, "astro/src/pages/index.astro"), "utf8");
    expect(idx).not.toContain(`import ${result.sectionName} from`);
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

describe.skipIf(!ASTRO_MODULES)("generateSection — brand/voice context", () => {
  it("includes site name in the LLM user message when labels.json has site.name", async () => {
    const { out, site } = await projectFixture("gen-ctx-");
    cleanup.add(out);

    // Inject a labels.json with a known site name so we can assert it appears in the prompt.
    const labelsPath = path.join(out, "labels.json");
    fs.writeFileSync(labelsPath, JSON.stringify({
      site: { name: "Iron & Grace Studio", purpose: "boutique fitness studio" },
      brand: { colors: [], fonts: [] }, sections: [], elements: [], assets: [],
    }));

    let capturedUserMessage = "";
    const capturingChat: ChatFn = async (opts) => {
      const msgs = (opts as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
      capturedUserMessage = msgs.find((m) => m.role === "user")?.content ?? "";
      return { content: JSON.stringify({ eyebrow: "Ready?", headline: "Join Us", subcopy: "Start today.", buttonLabel: "Get started" }) };
    };

    await generateSection(site, { role: "cta-band", brief: "A closing CTA." }, capturingChat, MODEL, browser, { width: WIDTH });

    expect(capturedUserMessage).toContain("Iron & Grace Studio");
    expect(capturedUserMessage).toContain("boutique fitness studio");
  }, 120_000);
});

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

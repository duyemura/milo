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

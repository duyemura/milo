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

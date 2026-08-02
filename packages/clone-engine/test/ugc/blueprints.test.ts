import { describe, it, expect } from "vitest";
import { BLUEPRINTS, titleFromRoute, slugify, routeOf, type ContentKind } from "../../src/ugc/blueprints.ts";
import { isGenerateRole } from "../../src/edit/templates.ts";

describe("BLUEPRINTS", () => {
  const KINDS: ContentKind[] = ["blog", "local-seo", "recipe", "event", "challenge"];

  it("has an entry for every ContentKind", () => {
    for (const k of KINDS) {
      expect(BLUEPRINTS[k], `missing blueprint for kind '${k}'`).toBeTruthy();
      expect(BLUEPRINTS[k].length, `blueprint '${k}' must not be empty`).toBeGreaterThan(0);
    }
  });

  it("every role in every blueprint is a real template-library role (bounded vocabulary)", () => {
    for (const k of KINDS) {
      for (const role of BLUEPRINTS[k]) {
        expect(isGenerateRole(role), `blueprint '${k}' role '${role}' is not in TEMPLATE_LIBRARY`).toBe(true);
      }
    }
  });

  it("every blueprint leads with a hero", () => {
    for (const k of KINDS) {
      expect(BLUEPRINTS[k][0], `blueprint '${k}' should lead with a hero`).toBe("hero");
    }
  });

  it("matches the documented blueprints exactly", () => {
    expect(BLUEPRINTS.blog).toEqual(["hero", "content-block", "content-block", "media-block", "cta-band"]);
    expect(BLUEPRINTS["local-seo"]).toEqual(["hero", "content-block", "feature-grid", "faq", "cta-band"]);
    expect(BLUEPRINTS.recipe).toEqual(["hero", "content-block", "media-block", "cta-band"]);
    expect(BLUEPRINTS.event).toEqual(["hero", "content-block", "stats-band", "lead-form"]);
    expect(BLUEPRINTS.challenge).toEqual(["hero", "content-block", "stats-band", "lead-form"]);
  });
});

describe("slugify", () => {
  it("collapses a nested route to a single flat slug (matches addPage's sanitizer)", () => {
    expect(slugify("/blog/best-crossfit-brooklyn/")).toBe("blog-best-crossfit-brooklyn");
  });
  it("strips leading/trailing slashes and lowercases", () => {
    expect(slugify("/About-US/")).toBe("about-us");
  });
  it("collapses non-alphanumerics to hyphens and trims stray hyphens", () => {
    expect(slugify("/events/summer bash!/")).toBe("events-summer-bash");
  });
  it("throws on a route with no usable characters", () => {
    expect(() => slugify("///")).toThrow(/invalid route/);
    expect(() => slugify("---")).toThrow(/invalid route/);
  });
});

describe("routeOf / titleFromRoute", () => {
  it("routeOf wraps a sanitized slug as /slug/", () => {
    expect(routeOf("/blog/best-crossfit-brooklyn/")).toBe("/blog-best-crossfit-brooklyn/");
  });
  it("titleFromRoute renders a Title-Cased human label from a route", () => {
    expect(titleFromRoute("/blog-best-crossfit-brooklyn/")).toBe("Blog Best Crossfit Brooklyn");
    expect(titleFromRoute("/about-us/")).toBe("About Us");
  });
});

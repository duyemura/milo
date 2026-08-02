/**
 * templates.ts — the bounded SECTION-TEMPLATE library for subsystem E.
 *
 * This is the guardrail that makes generation safe: each template is authored ONCE, by
 * hand, to (a) use ONLY the site's brand tokens (`var(--color-*)`, `var(--font-*)`,
 * `var(--space-*)`, `var(--radius-*)`) and (b) carry the full data-* contract
 * (`data-section` on the root, `data-component`, `data-role` on headline/cta/etc.,
 * `data-copy` keyed to content[] indices). The LLM never writes HTML or CSS — it fills
 * ONLY the copy slots (a Zod schema per template). So on-brand + on-contract are
 * GUARANTEED by construction: a schema-valid fill is, by definition, only words.
 *
 * A template is a pure function `(filled) => RenderedTemplate`. It emits the SAME shape
 * project.ts emits for a captured region:
 *
 *   ---
 *   const content = [ ...copy strings... ];
 *   const e = (s) => String(s).replace(/[&<>]/g, ...);   // matches project.ts exactly
 *   const html = `<section class="..." data-section="..." data-component="Comp"> ... `;
 *   ---
 *   <Fragment set:html={html} />
 *
 * generate.ts binds the real (unique) component name in at render time so copyKeys +
 * data-copy + data-component all agree with the site.json entries it writes.
 */
import { z } from "zod";
import type { SECTION_ROLES, PageGoal } from "../types.ts";

/** A section role from the A+B vocabulary this template emits (must be in SECTION_ROLES). */
export type TemplateSectionRole = (typeof SECTION_ROLES)[number];

/** One addressable element the template stamps (role → synthetic class handle). */
export interface TemplateElementRole {
  role: string;
  /** Synthetic CSS class handle, e.g. "g0" (generated). Distinct from captured p<n> handles. */
  id: string;
}

/** The output of rendering a template with filled copy — everything generate.ts needs to insert. */
export interface RenderedTemplate {
  /** The template-literal body (projector shape) — `${e(content[i])}` interpolations for copy. */
  html: string;
  /** The ordered copy array that becomes `const content = [...]`. */
  content: string[];
  /** Stable copy keys "<Comp>.<i>" bound to the real component name. */
  copyKeys: string[];
  /** Element roles + their synthetic class handles, for site.json elements[]. */
  elementRoles: TemplateElementRole[];
  /** The A+B section role stamped as data-section. */
  sectionRole: TemplateSectionRole;
  /**
   * Optional per-component CSS block appended to global.css. References ONLY brand tokens.
   * Class selectors are namespaced by the component name (injected at render time) so a
   * generated section's styles never collide with another section's `.p<n>` / `.g<n>`.
   */
  css?: string;
}

/** A section template: a Zod schema for the copy slots + a renderer bound to a component name. */
export interface SectionTemplate<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** The A+B section role this template produces. */
  role: TemplateSectionRole;
  /** The page goal this template best fits (advisory — informs picking). Utility pages have no
   *  engagement goal, so `"none"` is excluded — a template always fits a measurable goal. */
  fitsGoal: Exclude<PageGoal, "none">;
  /** Human-readable one-liner for prompts / logs. */
  description: string;
  /** Zod schema for the ONLY thing the LLM fills: structured copy. */
  slotSchema: S;
  /**
   * Render the template with validated copy + the real (unique) component name.
   * Pure: same (filled, componentName) → same bytes.
   */
  render(filled: z.infer<S>, componentName: string): RenderedTemplate;
}

// ---------------------------------------------------------------------------
// Shared emit helpers — keep every template byte-consistent with project.ts.
// ---------------------------------------------------------------------------

/**
 * Escape a STATIC string that goes into the html template literal verbatim (not via content[]).
 * Mirrors project.ts's tplSafe + attribute escaping needs: we author templates by hand so we
 * only need to keep backticks / ${ from breaking the literal. Static text here is ASCII markup.
 */
function tpl(strings: TemplateStringsArray, ...exprs: string[]): string {
  // Join without transformation — template authors write valid literal-safe markup. The one
  // hazard is an accidental `${` in static copy, but all dynamic copy flows through content[].
  let out = strings[0];
  for (let i = 0; i < exprs.length; i++) out += exprs[i] + strings[i + 1];
  return out;
}

/** The interpolation for the i-th copy slot — identical to project.ts's `${e(content[i])}`. */
function slot(i: number): string {
  return "${e(content[" + i + "])}";
}

/**
 * Scope a list of `[selectorSuffix, declarations]` rules under the section's own
 * `[data-component="<comp>"]` so a generated section's styles can NEVER collide with another
 * section's (two generated sections both use `.g0`..`.gN` handles). Declarations reference ONLY
 * brand tokens — the caller authors them; this helper just namespaces them.
 */
function scopeCss(comp: string, rules: Array<[string, string]>): string {
  const scope = `[data-component="${comp}"]`;
  let out = `/* generated: ${comp} */\n`;
  for (const [sel, decl] of rules) {
    // sel === "" targets the section root itself; else it's a descendant selector.
    out += `${scope}${sel ? " " + sel : ""} { ${decl} }\n`;
  }
  return out;
}

/** Wrap a rendered body into the full projector-shape .astro source. Used by generate.ts. */
export function renderAstroComponent(rt: RenderedTemplate): string {
  const content = JSON.stringify(rt.content, null, 2);
  const e = `const e = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));`;
  return `---\nconst content = ${content};\n${e}\nconst html = \`${rt.html}\`;\n---\n<Fragment set:html={html} />\n`;
}

// ---------------------------------------------------------------------------
// Template 1 — CTA band (role: cta-band, goal: convert)
// ---------------------------------------------------------------------------

const ctaBandSchema = z.object({
  /** Optional small eyebrow above the headline. */
  eyebrow: z.string().max(60).optional(),
  /** The main conversion headline. */
  headline: z.string().min(1).max(120),
  /** One line of supporting copy under the headline. */
  subcopy: z.string().min(1).max(240),
  /** The call-to-action button label (verb + object, e.g. "Book a free class"). */
  buttonLabel: z.string().min(1).max(40),
});

/**
 * CTA band: a full-width band on the brand PRIMARY color with a display-font headline,
 * body-text subcopy, and a rounded primary-cta button. Every color/font/space/radius is a
 * brand token; every editable element carries its data-role + data-copy handle.
 */
const ctaBand: SectionTemplate<typeof ctaBandSchema> = {
  role: "cta-band",
  fitsGoal: "convert",
  description: "A call-to-action band: headline + subcopy + button, on the brand primary color.",
  slotSchema: ctaBandSchema,
  render(filled, comp) {
    // content[] order is fixed so copyKeys are stable. Optional eyebrow always occupies a slot
    // (empty string when absent) → indices never shift, so copy keys are deterministic.
    const content: string[] = [
      filled.eyebrow ?? "",
      filled.headline,
      filled.subcopy,
      filled.buttonLabel,
    ];
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    // Synthetic class handles (g-prefixed, generated) — never collide with captured p<n>.
    const rootId = "g0", ebId = "g1", hId = "g2", subId = "g3", ctaId = "g4";

    const html = tpl`<section class="${rootId}" data-section="cta-band" data-component="${comp}"><div class="g0inner"><p class="${ebId}" data-role="eyebrow" data-copy="${copyKeys[0]}">${slot(0)}</p><h2 class="${hId}" data-role="headline" data-copy="${copyKeys[1]}">${slot(1)}</h2><p class="${subId}" data-role="body-text" data-copy="${copyKeys[2]}">${slot(2)}</p><a class="${ctaId}" href="#" data-role="primary-cta" data-copy="${copyKeys[3]}">${slot(3)}</a></div></section>`;

    // CSS references ONLY brand tokens, scoped under [data-component] so no cross-section collision.
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-primary); color: var(--color-surface); padding: var(--space-lg) var(--space-md); text-align: center; font-family: var(--font-body);"],
      [".g0inner", "max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-sm); align-items: center;"],
      [`.${ebId}`, "font-family: var(--font-body); text-transform: uppercase; letter-spacing: 2px; margin: 0; color: var(--color-surface);"],
      [`.${hId}`, "font-family: var(--font-display); font-size: 40px; line-height: 1.1; margin: 0; color: var(--color-surface);"],
      [`.${subId}`, "font-family: var(--font-body); font-size: 18px; margin: 0; color: var(--color-surface);"],
      [`.${ctaId}`, "display: inline-block; margin-top: var(--space-sm); padding: var(--space-sm) var(--space-lg); background-color: var(--color-accent); color: var(--color-surface); border-radius: var(--radius-button); font-family: var(--font-display); text-decoration: none;"],
    ]);

    return {
      html,
      content,
      copyKeys,
      elementRoles: [
        { role: "eyebrow", id: ebId },
        { role: "headline", id: hId },
        { role: "body-text", id: subId },
        { role: "primary-cta", id: ctaId },
      ],
      sectionRole: "cta-band",
      css,
    };
  },
};

// ---------------------------------------------------------------------------
// Template 2 — Features grid (role: feature-grid, goal: inform)
// ---------------------------------------------------------------------------

const featureItemSchema = z.object({
  title: z.string().min(1).max(60),
  body: z.string().min(1).max(200),
});

const featuresGridSchema = z.object({
  /** The section heading above the grid. */
  heading: z.string().min(1).max(120),
  /** Exactly three feature items (title + body each). */
  features: z.tuple([featureItemSchema, featureItemSchema, featureItemSchema]),
});

/**
 * Features grid: a heading over a responsive 3-up grid of feature cards. Surface background,
 * display-font heading + card titles, body-text card copy. Brand tokens throughout; each
 * card title + body carries its data-role + data-copy handle.
 */
const featuresGrid: SectionTemplate<typeof featuresGridSchema> = {
  role: "feature-grid",
  fitsGoal: "inform",
  description: "A features grid: a heading over three feature cards (title + body each).",
  slotSchema: featuresGridSchema,
  render(filled, comp) {
    // content[] order: heading, then (title, body) per feature in order.
    const content: string[] = [filled.heading];
    for (const f of filled.features) { content.push(f.title, f.body); }
    const copyKeys = content.map((_, i) => `${comp}.${i}`);

    const rootId = "g0", headId = "g1";
    // Per-card element handles: title/body for cards 0..2.
    const cardTitleIds = ["g2", "g4", "g6"];
    const cardBodyIds = ["g3", "g5", "g7"];

    let cards = "";
    for (let c = 0; c < 3; c++) {
      const titleIdx = 1 + c * 2;
      const bodyIdx = 2 + c * 2;
      cards += tpl`<div class="g0card"><h3 class="${cardTitleIds[c]}" data-role="headline" data-copy="${copyKeys[titleIdx]}">${slot(titleIdx)}</h3><p class="${cardBodyIds[c]}" data-role="body-text" data-copy="${copyKeys[bodyIdx]}">${slot(bodyIdx)}</p></div>`;
    }

    const html = tpl`<section class="${rootId}" data-section="feature-grid" data-component="${comp}"><h2 class="${headId}" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><div class="g0grid">${cards}</div></section>`;

    const scope = `[data-component="${comp}"]`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [`.${headId}`, "font-family: var(--font-display); font-size: 36px; text-align: center; margin: 0 0 var(--space-lg); color: var(--color-text);"],
      [".g0grid", "display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-lg); max-width: 1080px; margin: 0 auto;"],
      [".g0card", "background-color: var(--color-surface); border-radius: var(--radius-card); padding: var(--space-md); border: 1px solid var(--color-muted);"],
      [".g0card h3", "font-family: var(--font-display); font-size: 22px; margin: 0 0 var(--space-sm); color: var(--color-primary);"],
      [".g0card p", "font-family: var(--font-body); font-size: 16px; margin: 0; color: var(--color-text);"],
    ]) +
      // Responsive collapse — scoped to this component's grid.
      `@media (max-width: 768px) { ${scope} .g0grid { grid-template-columns: 1fr; } }\n`;

    return {
      html,
      content,
      copyKeys,
      elementRoles: [
        { role: "headline", id: headId },
        { role: "headline", id: cardTitleIds[0] },
        { role: "body-text", id: cardBodyIds[0] },
        { role: "headline", id: cardTitleIds[1] },
        { role: "body-text", id: cardBodyIds[1] },
        { role: "headline", id: cardTitleIds[2] },
        { role: "body-text", id: cardBodyIds[2] },
      ],
      sectionRole: "feature-grid",
      css,
    };
  },
};

// ---------------------------------------------------------------------------
// Template 3 — Hero (role: hero, goal: convert)
// Full-width hero: eyebrow + large headline + subcopy + primary CTA + optional secondary CTA.
// Based on real gym hero structures: speakeasy (h1 + CTA), sweatshed (h1 + subcopy + 2 CTAs).
// ---------------------------------------------------------------------------

const heroSchema = z.object({
  eyebrow: z.string().max(80).optional(),
  headline: z.string().min(1).max(120),
  subcopy: z.string().min(1).max(240),
  primaryCta: z.string().min(1).max(40),
  secondaryCta: z.string().max(40).optional(),
});

const hero: SectionTemplate<typeof heroSchema> = {
  role: "hero",
  fitsGoal: "convert",
  description: "Full-width hero: eyebrow + headline + subcopy + primary CTA, on the brand primary color.",
  slotSchema: heroSchema,
  render(filled, comp) {
    const content = [filled.eyebrow ?? "", filled.headline, filled.subcopy, filled.primaryCta, filled.secondaryCta ?? ""];
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    const secondaryHtml = filled.secondaryCta
      ? tpl`<a class="g5" href="#" data-role="primary-cta" data-copy="${copyKeys[4]}">${slot(4)}</a>`
      : "";
    const html = tpl`<section class="g0" data-section="hero" data-component="${comp}"><div class="g0inner"><p class="g1" data-role="eyebrow" data-copy="${copyKeys[0]}">${slot(0)}</p><h1 class="g2" data-role="headline" data-copy="${copyKeys[1]}">${slot(1)}</h1><p class="g3" data-role="body-text" data-copy="${copyKeys[2]}">${slot(2)}</p><div class="g0ctas"><a class="g4" href="#" data-role="primary-cta" data-copy="${copyKeys[3]}">${slot(3)}</a>${secondaryHtml}</div></div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-primary); color: var(--color-surface); padding: var(--space-lg) var(--space-md); font-family: var(--font-body); min-height: 480px; display: flex; align-items: center;"],
      [".g0inner", "max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-sm); text-align: center; align-items: center;"],
      [".g1", "font-family: var(--font-body); text-transform: uppercase; letter-spacing: 2px; font-size: 14px; margin: 0; color: var(--color-surface); opacity: 0.8;"],
      [".g2", "font-family: var(--font-display); font-size: 64px; line-height: 1.05; margin: 0; color: var(--color-surface);"],
      [".g3", "font-family: var(--font-body); font-size: 20px; line-height: 1.5; margin: 0; color: var(--color-surface); max-width: 560px;"],
      [".g0ctas", "display: flex; gap: var(--space-sm); flex-wrap: wrap; justify-content: center; margin-top: var(--space-sm);"],
      [".g4", "display: inline-block; padding: var(--space-sm) var(--space-lg); background-color: var(--color-accent); color: var(--color-surface); border-radius: var(--radius-button); font-family: var(--font-display); text-decoration: none; font-size: 18px;"],
      [".g5", "display: inline-block; padding: var(--space-sm) var(--space-lg); background-color: transparent; color: var(--color-surface); border: 2px solid var(--color-surface); border-radius: var(--radius-button); font-family: var(--font-display); text-decoration: none; font-size: 18px;"],
    ]);
    return { html, content, copyKeys, elementRoles: [{ role: "eyebrow", id: "g1" }, { role: "headline", id: "g2" }, { role: "body-text", id: "g3" }, { role: "primary-cta", id: "g4" }], sectionRole: "hero", css };
  },
};

// ---------------------------------------------------------------------------
// Template 4 — Coach grid (role: coach-grid, goal: inform)
// Heading over a 2×2 grid of coach cards. Each card: name + title + bio.
// Based on all 3 goldens (speakeasy, sweatshed, torrance all have coach sections).
// ---------------------------------------------------------------------------

const coachSchema = z.object({ name: z.string().min(1).max(60), title: z.string().min(1).max(80), bio: z.string().min(1).max(240) });
const coachGridSchema = z.object({
  heading: z.string().min(1).max(120),
  coaches: z.tuple([coachSchema, coachSchema, coachSchema, coachSchema]),
});

const coachGrid: SectionTemplate<typeof coachGridSchema> = {
  role: "coach-grid",
  fitsGoal: "inform",
  description: "A 2×2 grid of coach cards: name + title + bio per coach.",
  slotSchema: coachGridSchema,
  render(filled, comp) {
    const content = [filled.heading];
    for (const c of filled.coaches) content.push(c.name, c.title, c.bio);
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    let cards = "";
    for (let i = 0; i < 4; i++) {
      const ni = 1 + i * 3, ti = 2 + i * 3, bi = 3 + i * 3;
      const nhId = `g${ni + 1}`, thId = `g${ti + 1}`, bhId = `g${bi + 1}`;
      cards += tpl`<div class="g0card"><div class="g0avatar"></div><h3 class="${nhId}" data-role="headline" data-copy="${copyKeys[ni]}">${slot(ni)}</h3><p class="${thId}" data-role="eyebrow" data-copy="${copyKeys[ti]}">${slot(ti)}</p><p class="${bhId}" data-role="body-text" data-copy="${copyKeys[bi]}">${slot(bi)}</p></div>`;
    }
    const html = tpl`<section class="g0" data-section="coach-grid" data-component="${comp}"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><div class="g0grid">${cards}</div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g1", "font-family: var(--font-display); font-size: 36px; text-align: center; margin: 0 0 var(--space-lg); color: var(--color-text);"],
      [".g0grid", "display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-lg); max-width: 900px; margin: 0 auto;"],
      [".g0card", "display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-md); background-color: var(--color-surface); border-radius: var(--radius-card); border: 1px solid var(--color-muted);"],
      [".g0avatar", "width: 80px; height: 80px; border-radius: 50%; background-color: var(--color-muted);"],
      [".g0card h3", "font-family: var(--font-display); font-size: 22px; margin: 0; color: var(--color-text);"],
      [".g0card p:first-of-type", "font-family: var(--font-body); font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--color-primary); margin: 0;"],
      [".g0card p:last-of-type", "font-family: var(--font-body); font-size: 15px; color: var(--color-text); margin: 0; line-height: 1.5;"],
    ]) + `@media (max-width: 600px) { [data-component="${comp}"] .g0grid { grid-template-columns: 1fr; } }\n`;
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }], sectionRole: "coach-grid", css };
  },
};

// ---------------------------------------------------------------------------
// Template 5 — Program cards (role: program-cards, goal: convert)
// Heading over a 3-up grid of program cards: name + description + CTA.
// Based on all 3 goldens.
// ---------------------------------------------------------------------------

const programSchema = z.object({ name: z.string().min(1).max(60), description: z.string().min(1).max(200), cta: z.string().min(1).max(40) });
const programCardsSchema = z.object({
  heading: z.string().min(1).max(120),
  programs: z.tuple([programSchema, programSchema, programSchema]),
});

const programCards: SectionTemplate<typeof programCardsSchema> = {
  role: "program-cards",
  fitsGoal: "convert",
  description: "A 3-up grid of program cards: name + description + CTA button per program.",
  slotSchema: programCardsSchema,
  render(filled, comp) {
    const content = [filled.heading];
    for (const p of filled.programs) content.push(p.name, p.description, p.cta);
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    let cards = "";
    for (let i = 0; i < 3; i++) {
      const ni = 1 + i * 3, di = 2 + i * 3, ci = 3 + i * 3;
      const nhId = `g${ni + 1}`, dhId = `g${di + 1}`, chId = `g${ci + 1}`;
      cards += tpl`<div class="g0card"><h3 class="${nhId}" data-role="headline" data-copy="${copyKeys[ni]}">${slot(ni)}</h3><p class="${dhId}" data-role="body-text" data-copy="${copyKeys[di]}">${slot(di)}</p><a class="${chId}" href="#" data-role="primary-cta" data-copy="${copyKeys[ci]}">${slot(ci)}</a></div>`;
    }
    const html = tpl`<section class="g0" data-section="program-cards" data-component="${comp}"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><div class="g0grid">${cards}</div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g1", "font-family: var(--font-display); font-size: 36px; text-align: center; margin: 0 0 var(--space-lg); color: var(--color-text);"],
      [".g0grid", "display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-lg); max-width: 1080px; margin: 0 auto;"],
      [".g0card", "display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-md); background-color: var(--color-surface); border-radius: var(--radius-card); border: 1px solid var(--color-muted);"],
      [".g0card h3", "font-family: var(--font-display); font-size: 24px; margin: 0; color: var(--color-primary);"],
      [".g0card p", "font-family: var(--font-body); font-size: 15px; margin: 0; color: var(--color-text); line-height: 1.6; flex: 1;"],
      [".g0card a", "display: inline-block; margin-top: auto; padding: var(--space-sm) var(--space-md); background-color: var(--color-primary); color: var(--color-surface); border-radius: var(--radius-button); font-family: var(--font-display); text-decoration: none; text-align: center;"],
    ]) + `@media (max-width: 768px) { [data-component="${comp}"] .g0grid { grid-template-columns: 1fr; } }\n`;
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }], sectionRole: "program-cards", css };
  },
};

// ---------------------------------------------------------------------------
// Template 6 — Testimonials (role: testimonials, goal: inform)
// Heading over a 3-up grid of testimonial cards: quote + member name + detail.
// Based on speakeasy + sweatshed.
// ---------------------------------------------------------------------------

const testimonialSchema = z.object({ quote: z.string().min(1).max(300), name: z.string().min(1).max(60), detail: z.string().max(80).optional() });
const testimonialsSchema = z.object({
  heading: z.string().min(1).max(120),
  items: z.tuple([testimonialSchema, testimonialSchema, testimonialSchema]),
});

const testimonials: SectionTemplate<typeof testimonialsSchema> = {
  role: "testimonials",
  fitsGoal: "inform",
  description: "A 3-up grid of testimonial cards: quote + member name + optional detail.",
  slotSchema: testimonialsSchema,
  render(filled, comp) {
    const content = [filled.heading];
    for (const t of filled.items) content.push(t.quote, t.name, t.detail ?? "");
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    let cards = "";
    for (let i = 0; i < 3; i++) {
      const qi = 1 + i * 3, ni = 2 + i * 3, di = 3 + i * 3;
      cards += tpl`<div class="g0card"><p class="g0quote" data-role="body-text" data-copy="${copyKeys[qi]}">"${slot(qi)}"</p><p class="g0name" data-role="headline" data-copy="${copyKeys[ni]}">${slot(ni)}</p><p class="g0detail" data-role="body-text" data-copy="${copyKeys[di]}">${slot(di)}</p></div>`;
    }
    const html = tpl`<section class="g0" data-section="testimonials" data-component="${comp}"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><div class="g0grid">${cards}</div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-muted); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g1", "font-family: var(--font-display); font-size: 36px; text-align: center; margin: 0 0 var(--space-lg); color: var(--color-text);"],
      [".g0grid", "display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-md); max-width: 1080px; margin: 0 auto;"],
      [".g0card", "background-color: var(--color-surface); border-radius: var(--radius-card); padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-sm);"],
      [".g0quote", "font-family: var(--font-body); font-size: 16px; line-height: 1.6; margin: 0; color: var(--color-text); flex: 1; font-style: italic;"],
      [".g0name", "font-family: var(--font-display); font-size: 18px; margin: 0; color: var(--color-primary);"],
      [".g0detail", "font-family: var(--font-body); font-size: 13px; margin: 0; color: var(--color-text); opacity: 0.6;"],
    ]) + `@media (max-width: 768px) { [data-component="${comp}"] .g0grid { grid-template-columns: 1fr; } }\n`;
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }], sectionRole: "testimonials", css };
  },
};

// ---------------------------------------------------------------------------
// Template 7 — Stats band (role: stats-band, goal: inform)
// A horizontal band of 4 stats: number + label each. Based on torrance.
// ---------------------------------------------------------------------------

const statSchema = z.object({ number: z.string().min(1).max(20), label: z.string().min(1).max(60) });
const statsBandSchema = z.object({ items: z.tuple([statSchema, statSchema, statSchema, statSchema]) });

const statsBand: SectionTemplate<typeof statsBandSchema> = {
  role: "stats-band",
  fitsGoal: "inform",
  description: "A horizontal band of 4 stats: a bold number + a label each.",
  slotSchema: statsBandSchema,
  render(filled, comp) {
    const content: string[] = [];
    for (const s of filled.items) content.push(s.number, s.label);
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    let items = "";
    for (let i = 0; i < 4; i++) {
      const ni = i * 2, li = i * 2 + 1;
      items += tpl`<div class="g0stat"><p class="g0num" data-role="headline" data-copy="${copyKeys[ni]}">${slot(ni)}</p><p class="g0lbl" data-role="body-text" data-copy="${copyKeys[li]}">${slot(li)}</p></div>`;
    }
    const html = tpl`<section class="g0" data-section="stats-band" data-component="${comp}"><div class="g0inner">${items}</div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-primary); color: var(--color-surface); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g0inner", "display: flex; justify-content: center; gap: var(--space-lg); max-width: 1080px; margin: 0 auto; flex-wrap: wrap;"],
      [".g0stat", "display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 160px;"],
      [".g0num", "font-family: var(--font-display); font-size: 56px; line-height: 1; margin: 0; color: var(--color-surface);"],
      [".g0lbl", "font-family: var(--font-body); font-size: 16px; margin: 0; color: var(--color-surface); text-align: center; opacity: 0.85;"],
    ]);
    return { html, content, copyKeys, elementRoles: [], sectionRole: "stats-band", css };
  },
};

// ---------------------------------------------------------------------------
// Template 8 — Schedule (role: schedule, goal: inform)
// Heading over a table of 6 class slots: time + class name + coach. Based on torrance.
// ---------------------------------------------------------------------------

const classSlotSchema = z.object({ time: z.string().min(1).max(40), name: z.string().min(1).max(60), coach: z.string().min(1).max(60) });
const scheduleSchema = z.object({
  heading: z.string().min(1).max(120),
  classes: z.tuple([classSlotSchema, classSlotSchema, classSlotSchema, classSlotSchema, classSlotSchema, classSlotSchema]),
});

const schedule: SectionTemplate<typeof scheduleSchema> = {
  role: "schedule",
  fitsGoal: "inform",
  description: "A class schedule: heading + 6 class slots showing time, class name, and coach.",
  slotSchema: scheduleSchema,
  render(filled, comp) {
    const content = [filled.heading];
    for (const c of filled.classes) content.push(c.time, c.name, c.coach);
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    let rows = "";
    for (let i = 0; i < 6; i++) {
      const ti = 1 + i * 3, ni = 2 + i * 3, ci = 3 + i * 3;
      rows += tpl`<div class="g0row"><span class="g0time" data-role="body-text" data-copy="${copyKeys[ti]}">${slot(ti)}</span><span class="g0name" data-role="headline" data-copy="${copyKeys[ni]}">${slot(ni)}</span><span class="g0coach" data-role="body-text" data-copy="${copyKeys[ci]}">${slot(ci)}</span></div>`;
    }
    const html = tpl`<section class="g0" data-section="schedule" data-component="${comp}"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><div class="g0table">${rows}</div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g1", "font-family: var(--font-display); font-size: 36px; text-align: center; margin: 0 0 var(--space-lg); color: var(--color-text);"],
      [".g0table", "display: flex; flex-direction: column; gap: 2px; max-width: 760px; margin: 0 auto;"],
      [".g0row", "display: grid; grid-template-columns: 140px 1fr 1fr; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); background-color: var(--color-surface); border-bottom: 1px solid var(--color-muted); align-items: center;"],
      [".g0row:nth-child(even)", "background-color: var(--color-muted);"],
      [".g0time", "font-family: var(--font-body); font-size: 14px; color: var(--color-primary); font-weight: bold;"],
      [".g0name", "font-family: var(--font-display); font-size: 18px; color: var(--color-text);"],
      [".g0coach", "font-family: var(--font-body); font-size: 14px; color: var(--color-text); opacity: 0.7;"],
    ]);
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }], sectionRole: "schedule", css };
  },
};

// ---------------------------------------------------------------------------
// Template 9 — FAQ (role: faq, goal: inform)
// Heading over 6 question/answer pairs. Based on KSAC (large FAQ at bottom of homepage).
// ---------------------------------------------------------------------------

const faqItemSchema = z.object({ question: z.string().min(1).max(160), answer: z.string().min(1).max(400) });
const faqSchema = z.object({
  heading: z.string().min(1).max(120),
  items: z.tuple([faqItemSchema, faqItemSchema, faqItemSchema, faqItemSchema, faqItemSchema, faqItemSchema]),
});

const faq: SectionTemplate<typeof faqSchema> = {
  role: "faq",
  fitsGoal: "inform",
  description: "A FAQ section: heading + 6 question/answer pairs.",
  slotSchema: faqSchema,
  render(filled, comp) {
    const content = [filled.heading];
    for (const item of filled.items) content.push(item.question, item.answer);
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    let items = "";
    for (let i = 0; i < 6; i++) {
      const qi = 1 + i * 2, ai = 2 + i * 2;
      items += tpl`<div class="g0item"><h3 class="g0q" data-role="headline" data-copy="${copyKeys[qi]}">${slot(qi)}</h3><p class="g0a" data-role="body-text" data-copy="${copyKeys[ai]}">${slot(ai)}</p></div>`;
    }
    const html = tpl`<section class="g0" data-section="faq" data-component="${comp}"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><div class="g0list">${items}</div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g1", "font-family: var(--font-display); font-size: 36px; text-align: center; margin: 0 0 var(--space-lg); color: var(--color-text);"],
      [".g0list", "display: flex; flex-direction: column; max-width: 760px; margin: 0 auto;"],
      [".g0item", "border-bottom: 1px solid var(--color-muted); padding: var(--space-md) 0; display: flex; flex-direction: column; gap: var(--space-sm);"],
      [".g0q", "font-family: var(--font-display); font-size: 20px; margin: 0; color: var(--color-text);"],
      [".g0a", "font-family: var(--font-body); font-size: 16px; margin: 0; color: var(--color-text); line-height: 1.6; opacity: 0.85;"],
    ]);
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }], sectionRole: "faq", css };
  },
};

// ---------------------------------------------------------------------------
// Template 10 — Pricing (role: pricing, goal: convert)
// Heading over 3 pricing tiers: name + price + period + description + CTA.
// ---------------------------------------------------------------------------

const tierSchema = z.object({ name: z.string().min(1).max(40), price: z.string().min(1).max(20), period: z.string().min(1).max(30), description: z.string().min(1).max(200), cta: z.string().min(1).max(40) });
const pricingSchema = z.object({
  heading: z.string().min(1).max(120),
  tiers: z.tuple([tierSchema, tierSchema, tierSchema]),
});

const pricing: SectionTemplate<typeof pricingSchema> = {
  role: "pricing",
  fitsGoal: "convert",
  description: "A 3-tier pricing section: name + price + period + description + CTA per tier.",
  slotSchema: pricingSchema,
  render(filled, comp) {
    const content = [filled.heading];
    for (const t of filled.tiers) content.push(t.name, t.price, t.period, t.description, t.cta);
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    let cards = "";
    for (let i = 0; i < 3; i++) {
      const base = 1 + i * 5;
      const [ni, pri, pei, di, ci] = [base, base + 1, base + 2, base + 3, base + 4];
      cards += tpl`<div class="g0card${i === 1 ? " g0featured" : ""}"><p class="g0name" data-role="headline" data-copy="${copyKeys[ni]}">${slot(ni)}</p><p class="g0price" data-role="headline" data-copy="${copyKeys[pri]}">${slot(pri)}</p><p class="g0period" data-role="body-text" data-copy="${copyKeys[pei]}">${slot(pei)}</p><p class="g0desc" data-role="body-text" data-copy="${copyKeys[di]}">${slot(di)}</p><a class="g0cta" href="#" data-role="primary-cta" data-copy="${copyKeys[ci]}">${slot(ci)}</a></div>`;
    }
    const html = tpl`<section class="g0" data-section="pricing" data-component="${comp}"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><div class="g0grid">${cards}</div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g1", "font-family: var(--font-display); font-size: 36px; text-align: center; margin: 0 0 var(--space-lg); color: var(--color-text);"],
      [".g0grid", "display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-md); max-width: 960px; margin: 0 auto; align-items: start;"],
      [".g0card", "display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-md); border: 1px solid var(--color-muted); border-radius: var(--radius-card);"],
      [".g0featured", "border-color: var(--color-primary); border-width: 2px; background-color: var(--color-muted);"],
      [".g0name", "font-family: var(--font-display); font-size: 22px; margin: 0; color: var(--color-primary);"],
      [".g0price", "font-family: var(--font-display); font-size: 48px; margin: 0; color: var(--color-text); line-height: 1;"],
      [".g0period", "font-family: var(--font-body); font-size: 13px; margin: 0; color: var(--color-text); opacity: 0.6;"],
      [".g0desc", "font-family: var(--font-body); font-size: 14px; margin: 0; color: var(--color-text); line-height: 1.5; flex: 1;"],
      [".g0cta", "display: block; margin-top: auto; padding: var(--space-sm) var(--space-md); background-color: var(--color-primary); color: var(--color-surface); border-radius: var(--radius-button); font-family: var(--font-display); text-decoration: none; text-align: center;"],
    ]) + `@media (max-width: 768px) { [data-component="${comp}"] .g0grid { grid-template-columns: 1fr; } }\n`;
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }], sectionRole: "pricing", css };
  },
};

// ---------------------------------------------------------------------------
// Template 11 — Logo strip (role: logo-strip, goal: inform)
// A subtle band of partner/press logo names. Renders text — no image assets needed.
// ---------------------------------------------------------------------------

const logoStripSchema = z.object({
  heading: z.string().max(80).optional(),
  names: z.tuple([z.string().min(1).max(40), z.string().min(1).max(40), z.string().min(1).max(40), z.string().min(1).max(40), z.string().min(1).max(40), z.string().min(1).max(40)]),
});

const logoStrip: SectionTemplate<typeof logoStripSchema> = {
  role: "logo-strip",
  fitsGoal: "inform",
  description: "A press/partner logo strip: optional heading + 6 partner names displayed as styled text.",
  slotSchema: logoStripSchema,
  render(filled, comp) {
    const content = [filled.heading ?? "", ...filled.names];
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    let logos = "";
    for (let i = 0; i < 6; i++) logos += tpl`<span class="g0logo" data-role="body-text" data-copy="${copyKeys[i + 1]}">${slot(i + 1)}</span>`;
    const html = tpl`<section class="g0" data-section="logo-strip" data-component="${comp}"><p class="g1" data-role="eyebrow" data-copy="${copyKeys[0]}">${slot(0)}</p><div class="g0logos">${logos}</div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-muted); color: var(--color-text); padding: var(--space-md) var(--space-md); font-family: var(--font-body); text-align: center;"],
      [".g1", "font-family: var(--font-body); font-size: 13px; text-transform: uppercase; letter-spacing: 2px; color: var(--color-text); opacity: 0.5; margin: 0 0 var(--space-sm);"],
      [".g0logos", "display: flex; flex-wrap: wrap; gap: var(--space-lg); justify-content: center; align-items: center; max-width: 1080px; margin: 0 auto;"],
      [".g0logo", "font-family: var(--font-display); font-size: 20px; color: var(--color-text); opacity: 0.4; letter-spacing: 1px;"],
    ]);
    return { html, content, copyKeys, elementRoles: [], sectionRole: "logo-strip", css };
  },
};

// ---------------------------------------------------------------------------
// Template 12 — Media block (role: media-block, goal: inform)
// A split section: text on one side (eyebrow + heading + body + CTA) + image placeholder on the other.
// ---------------------------------------------------------------------------

const mediaBlockSchema = z.object({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().min(1).max(120),
  body: z.string().min(1).max(400),
  cta: z.string().min(1).max(40),
});

const mediaBlock: SectionTemplate<typeof mediaBlockSchema> = {
  role: "media-block",
  fitsGoal: "inform",
  description: "A split section: eyebrow + heading + body copy + CTA on the left, image area on the right.",
  slotSchema: mediaBlockSchema,
  render(filled, comp) {
    const content = [filled.eyebrow ?? "", filled.heading, filled.body, filled.cta];
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    const html = tpl`<section class="g0" data-section="media-block" data-component="${comp}"><div class="g0split"><div class="g0text"><p class="g1" data-role="eyebrow" data-copy="${copyKeys[0]}">${slot(0)}</p><h2 class="g2" data-role="headline" data-copy="${copyKeys[1]}">${slot(1)}</h2><p class="g3" data-role="body-text" data-copy="${copyKeys[2]}">${slot(2)}</p><a class="g4" href="#" data-role="primary-cta" data-copy="${copyKeys[3]}">${slot(3)}</a></div><div class="g0media" role="img" aria-label="Section image"></div></div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g0split", "display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-lg); max-width: 1080px; margin: 0 auto; align-items: center;"],
      [".g0text", "display: flex; flex-direction: column; gap: var(--space-sm);"],
      [".g1", "font-family: var(--font-body); font-size: 13px; text-transform: uppercase; letter-spacing: 2px; color: var(--color-primary); margin: 0;"],
      [".g2", "font-family: var(--font-display); font-size: 36px; margin: 0; color: var(--color-text); line-height: 1.1;"],
      [".g3", "font-family: var(--font-body); font-size: 16px; margin: 0; color: var(--color-text); line-height: 1.6;"],
      [".g4", "display: inline-block; padding: var(--space-sm) var(--space-lg); background-color: var(--color-primary); color: var(--color-surface); border-radius: var(--radius-button); font-family: var(--font-display); text-decoration: none;"],
      [".g0media", "background-color: var(--color-muted); border-radius: var(--radius-card); aspect-ratio: 4/3;"],
    ]) + `@media (max-width: 768px) { [data-component="${comp}"] .g0split { grid-template-columns: 1fr; } }\n`;
    return { html, content, copyKeys, elementRoles: [{ role: "eyebrow", id: "g1" }, { role: "headline", id: "g2" }, { role: "body-text", id: "g3" }, { role: "primary-cta", id: "g4" }], sectionRole: "media-block", css };
  },
};

// ---------------------------------------------------------------------------
// Template 13 — Content block (role: content-block, goal: inform)
// Centered prose: heading + body copy + optional CTA. For about/story sections.
// ---------------------------------------------------------------------------

const contentBlockSchema = z.object({
  heading: z.string().min(1).max(120),
  body: z.string().min(1).max(600),
  cta: z.string().max(40).optional(),
});

const contentBlock: SectionTemplate<typeof contentBlockSchema> = {
  role: "content-block",
  fitsGoal: "inform",
  description: "Centered prose: heading + body copy + optional CTA. Good for About/Story sections.",
  slotSchema: contentBlockSchema,
  render(filled, comp) {
    const content = [filled.heading, filled.body, filled.cta ?? ""];
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    const ctaHtml = filled.cta
      ? tpl`<a class="g3" href="#" data-role="primary-cta" data-copy="${copyKeys[2]}">${slot(2)}</a>`
      : "";
    const html = tpl`<section class="g0" data-section="content-block" data-component="${comp}"><div class="g0inner"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><p class="g2" data-role="body-text" data-copy="${copyKeys[1]}">${slot(1)}</p>${ctaHtml}</div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g0inner", "max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-md); text-align: center; align-items: center;"],
      [".g1", "font-family: var(--font-display); font-size: 36px; margin: 0; color: var(--color-text); line-height: 1.1;"],
      [".g2", "font-family: var(--font-body); font-size: 18px; margin: 0; color: var(--color-text); line-height: 1.7;"],
      [".g3", "display: inline-block; padding: var(--space-sm) var(--space-lg); background-color: var(--color-primary); color: var(--color-surface); border-radius: var(--radius-button); font-family: var(--font-display); text-decoration: none;"],
    ]);
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }, { role: "body-text", id: "g2" }], sectionRole: "content-block", css };
  },
};

// ---------------------------------------------------------------------------
// Template 14 — Contact form (role: contact-form, goal: convert)
// Heading + subcopy + a name/email/message form + submit button.
// ---------------------------------------------------------------------------

const contactFormSchema = z.object({
  heading: z.string().min(1).max(120),
  subcopy: z.string().min(1).max(240),
  submitLabel: z.string().min(1).max(40),
});

const contactForm: SectionTemplate<typeof contactFormSchema> = {
  role: "contact-form",
  fitsGoal: "convert",
  description: "A contact form: heading + subcopy + name/email/message fields + submit button.",
  slotSchema: contactFormSchema,
  render(filled, comp) {
    const content = [filled.heading, filled.subcopy, filled.submitLabel];
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    const html = tpl`<section class="g0" data-section="contact-form" data-component="${comp}"><div class="g0inner"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><p class="g2" data-role="body-text" data-copy="${copyKeys[1]}">${slot(1)}</p><form class="g0form" onsubmit="return false"><input class="g0field" type="text" placeholder="Your name" aria-label="Name"><input class="g0field" type="email" placeholder="Email address" aria-label="Email"><textarea class="g0field g0textarea" placeholder="Your message" aria-label="Message"></textarea><button class="g3" type="submit" data-role="primary-cta" data-copy="${copyKeys[2]}">${slot(2)}</button></form></div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g0inner", "max-width: 560px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-md); text-align: center;"],
      [".g1", "font-family: var(--font-display); font-size: 36px; margin: 0; color: var(--color-text);"],
      [".g2", "font-family: var(--font-body); font-size: 16px; margin: 0; color: var(--color-text); opacity: 0.75;"],
      [".g0form", "display: flex; flex-direction: column; gap: var(--space-sm); text-align: left;"],
      [".g0field", "font-family: var(--font-body); font-size: 16px; padding: var(--space-sm) var(--space-md); border: 1px solid var(--color-muted); border-radius: var(--radius-card); background-color: var(--color-surface); color: var(--color-text); outline-color: var(--color-primary);"],
      [".g0textarea", "min-height: 120px; resize: vertical;"],
      [".g3", "padding: var(--space-sm) var(--space-lg); background-color: var(--color-primary); color: var(--color-surface); border: none; border-radius: var(--radius-button); font-family: var(--font-display); font-size: 18px; cursor: pointer;"],
    ]);
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }, { role: "body-text", id: "g2" }, { role: "primary-cta", id: "g3" }], sectionRole: "contact-form", css };
  },
};

// ---------------------------------------------------------------------------
// Template 15 — Lead form (role: lead-form, goal: convert)
// A compact inline lead-capture: headline + subcopy + email field + CTA button.
// ---------------------------------------------------------------------------

const leadFormSchema = z.object({
  heading: z.string().min(1).max(120),
  subcopy: z.string().min(1).max(200),
  placeholder: z.string().min(1).max(60),
  cta: z.string().min(1).max(40),
});

const leadForm: SectionTemplate<typeof leadFormSchema> = {
  role: "lead-form",
  fitsGoal: "convert",
  description: "A compact lead-capture band: headline + subcopy + inline email field + CTA button.",
  slotSchema: leadFormSchema,
  render(filled, comp) {
    const content = [filled.heading, filled.subcopy, filled.placeholder, filled.cta];
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    const html = tpl`<section class="g0" data-section="lead-form" data-component="${comp}"><div class="g0inner"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><p class="g2" data-role="body-text" data-copy="${copyKeys[1]}">${slot(1)}</p><form class="g0form" onsubmit="return false"><input class="g0email" type="email" data-copy="${copyKeys[2]}" placeholder="${slot(2)}" aria-label="Email address"><button class="g3" type="submit" data-role="primary-cta" data-copy="${copyKeys[3]}">${slot(3)}</button></form></div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-primary); color: var(--color-surface); padding: var(--space-lg) var(--space-md); font-family: var(--font-body); text-align: center;"],
      [".g0inner", "max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-sm); align-items: center;"],
      [".g1", "font-family: var(--font-display); font-size: 36px; margin: 0; color: var(--color-surface);"],
      [".g2", "font-family: var(--font-body); font-size: 16px; margin: 0; color: var(--color-surface); opacity: 0.85;"],
      [".g0form", "display: flex; gap: var(--space-sm); width: 100%; max-width: 480px; flex-wrap: wrap; justify-content: center;"],
      [".g0email", "flex: 1; min-width: 200px; font-family: var(--font-body); font-size: 16px; padding: var(--space-sm) var(--space-md); border: none; border-radius: var(--radius-button); background-color: var(--color-surface); color: var(--color-text);"],
      [".g3", "padding: var(--space-sm) var(--space-lg); background-color: var(--color-accent); color: var(--color-surface); border: none; border-radius: var(--radius-button); font-family: var(--font-display); font-size: 16px; cursor: pointer; white-space: nowrap;"],
    ]);
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }, { role: "body-text", id: "g2" }, { role: "primary-cta", id: "g3" }], sectionRole: "lead-form", css };
  },
};

// ---------------------------------------------------------------------------
// Template 16 — Location map (role: location-map, goal: convert)
// Address + hours + phone + CTA, with a map placeholder. Based on speakeasy (multi-location).
// ---------------------------------------------------------------------------

const locationMapSchema = z.object({
  heading: z.string().min(1).max(120),
  address: z.string().min(1).max(160),
  city: z.string().min(1).max(80),
  phone: z.string().min(1).max(40),
  hours: z.string().min(1).max(200),
  cta: z.string().min(1).max(40),
});

const locationMap: SectionTemplate<typeof locationMapSchema> = {
  role: "location-map",
  fitsGoal: "convert",
  description: "Location info: heading + address + city + phone + hours + CTA, with a map placeholder.",
  slotSchema: locationMapSchema,
  render(filled, comp) {
    const content = [filled.heading, filled.address, filled.city, filled.phone, filled.hours, filled.cta];
    const copyKeys = content.map((_, i) => `${comp}.${i}`);
    const html = tpl`<section class="g0" data-section="location-map" data-component="${comp}"><div class="g0split"><div class="g0map" role="img" aria-label="Location map"></div><div class="g0info"><h2 class="g1" data-role="headline" data-copy="${copyKeys[0]}">${slot(0)}</h2><p class="g2" data-role="body-text" data-copy="${copyKeys[1]}">${slot(1)}</p><p class="g3" data-role="body-text" data-copy="${copyKeys[2]}">${slot(2)}</p><p class="g4" data-role="body-text" data-copy="${copyKeys[3]}">${slot(3)}</p><p class="g5" data-role="body-text" data-copy="${copyKeys[4]}">${slot(4)}</p><a class="g6" href="#" data-role="primary-cta" data-copy="${copyKeys[5]}">${slot(5)}</a></div></div></section>`;
    const css = scopeCss(comp, [
      ["", "background-color: var(--color-surface); color: var(--color-text); padding: var(--space-lg) var(--space-md); font-family: var(--font-body);"],
      [".g0split", "display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-lg); max-width: 1080px; margin: 0 auto; align-items: center;"],
      [".g0map", "background-color: var(--color-muted); border-radius: var(--radius-card); aspect-ratio: 4/3;"],
      [".g0info", "display: flex; flex-direction: column; gap: var(--space-sm);"],
      [".g1", "font-family: var(--font-display); font-size: 32px; margin: 0; color: var(--color-text);"],
      [".g2, .g3, .g4, .g5", "font-family: var(--font-body); font-size: 16px; margin: 0; color: var(--color-text); line-height: 1.5;"],
      [".g6", "display: inline-block; padding: var(--space-sm) var(--space-lg); background-color: var(--color-primary); color: var(--color-surface); border-radius: var(--radius-button); font-family: var(--font-display); text-decoration: none; margin-top: var(--space-sm);"],
    ]) + `@media (max-width: 768px) { [data-component="${comp}"] .g0split { grid-template-columns: 1fr; } }\n`;
    return { html, content, copyKeys, elementRoles: [{ role: "headline", id: "g1" }, { role: "body-text", id: "g2" }, { role: "primary-cta", id: "g6" }], sectionRole: "location-map", css };
  },
};

// ---------------------------------------------------------------------------
// The registry — the bounded vocabulary. A role NOT here has no path to generation.
// ---------------------------------------------------------------------------

/** The section-template library, keyed by generation role. This IS the bounded vocabulary. */
export const TEMPLATE_LIBRARY = {
  "cta-band": ctaBand,
  "feature-grid": featuresGrid,
  "hero": hero,
  "coach-grid": coachGrid,
  "program-cards": programCards,
  "testimonials": testimonials,
  "stats-band": statsBand,
  "schedule": schedule,
  "faq": faq,
  "pricing": pricing,
  "logo-strip": logoStrip,
  "media-block": mediaBlock,
  "content-block": contentBlock,
  "contact-form": contactForm,
  "lead-form": leadForm,
  "location-map": locationMap,
} as const;

/** The roles the library can generate (the bounded vocabulary). */
export type GenerateRole = keyof typeof TEMPLATE_LIBRARY;

/** Type guard: is `role` a role the library can generate? */
export function isGenerateRole(role: string): role is GenerateRole {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_LIBRARY, role);
}

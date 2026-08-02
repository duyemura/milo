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
// The registry — the bounded vocabulary. A role NOT here has no path to generation.
// ---------------------------------------------------------------------------

/** The section-template library, keyed by generation role. This IS the bounded vocabulary. */
export const TEMPLATE_LIBRARY = {
  "cta-band": ctaBand,
  "feature-grid": featuresGrid,
} as const;

/** The roles the library can generate (the bounded vocabulary). */
export type GenerateRole = keyof typeof TEMPLATE_LIBRARY;

/** Type guard: is `role` a role the library can generate? */
export function isGenerateRole(role: string): role is GenerateRole {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_LIBRARY, role);
}

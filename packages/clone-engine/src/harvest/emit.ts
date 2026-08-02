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

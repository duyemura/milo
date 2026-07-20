import modern from "@templates/modern/registry.ts";

/**
 * Template registry. Adding a template = adding its registry import here.
 * Template selection is data (TEMPLATE env), never code branches in pages.
 */
const TEMPLATES: Record<string, typeof modern> = {
  modern,
};

export function getTemplate(name: string) {
  const tpl = TEMPLATES[name];
  if (!tpl) {
    throw new Error(`Unknown template "${name}". Known: ${Object.keys(TEMPLATES).join(", ")}`);
  }
  return tpl;
}

/** Closed vocabulary: an unknown section type is a build error, never a fallback. */
export function resolveSection(tpl: typeof modern, type: string) {
  const component = tpl.components[type];
  if (!component) {
    throw new Error(`Template "${tpl.name}" has no component for section type "${type}"`);
  }
  return component;
}

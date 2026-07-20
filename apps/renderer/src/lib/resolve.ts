/**
 * Template registry. Templates are discovered by glob and loaded LAZILY —
 * importing a template module pulls its CSS into the bundle (Vite emits CSS
 * on import, not on render), so only the active template may ever be
 * imported. Template selection is data (TEMPLATE env), never code branches.
 */
type Registry = {
  name: string;
  Base: unknown;
  Nav: unknown;
  Footer: unknown;
  components: Record<string, unknown>;
};

const loaders = import.meta.glob<{ default: Registry }>("../../../../templates/*/registry.ts");

export async function getTemplate(name: string): Promise<Registry> {
  const key = `../../../../templates/${name}/registry.ts`;
  const loader = loaders[key];
  if (!loader) {
    const known = Object.keys(loaders)
      .map((k) => k.split("/").at(-2))
      .join(", ");
    throw new Error(`Unknown template "${name}". Known: ${known}`);
  }
  return (await loader()).default;
}

/** Closed vocabulary: an unknown section type is a build error, never a fallback. */
export function resolveSection(tpl: Registry, type: string) {
  const component = tpl.components[type];
  if (!component) {
    throw new Error(`Template "${tpl.name}" has no component for section type "${type}"`);
  }
  return component;
}

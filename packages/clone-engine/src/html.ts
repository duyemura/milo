/**
 * Shared HTML-emit glue used by both capture.ts and project.ts.
 *
 * These three helpers are byte-identical across both engines — extracted here so
 * the producer (capture) and consumer (project) can't drift. Deliberately NOT
 * shared: the `VOID` element sets (capture's includes meta/link, project's does
 * not — intentionally different) and the render/renderP functions (different
 * class prefixes and logic — a parity risk). Those stay local to each file.
 */

/** Escape text-node content for HTML output. */
export const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Escape a value for use inside a double-quoted HTML attribute. */
export const escA = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Keep only the entries in `over` whose value differs from `base` (responsive delta). */
export const diff = (
  base: Record<string, string>,
  over: Record<string, string>,
): Record<string, string> => {
  const d: Record<string, string> = {};
  for (const k in over) if (over[k] !== base[k]) d[k] = over[k];
  return d;
};

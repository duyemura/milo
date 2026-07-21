import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const BrandTokens = z.object({
  colors: z.object({
    primary: hex, accent: hex, surface: hex, text: hex, muted: hex,
  }),
  fonts: z.object({ display: z.string().min(1), body: z.string().min(1) }),
  space: z.object({ sm: z.string(), md: z.string(), lg: z.string() }),
  radius: z.object({ button: z.string(), card: z.string() }),
});
export type BrandTokens = z.infer<typeof BrandTokens>;

/** Flatten tokens into `:root` CSS custom properties. */
export function tokensToCss(t: BrandTokens): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(t.colors)) lines.push(`--color-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.fonts)) lines.push(`--font-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.space)) lines.push(`--space-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.radius)) lines.push(`--radius-${k}: ${v};`);
  // Fixed scale extensions (not gym-configurable — derived from the core scale).
  lines.push("--space-xs: 4px;");
  lines.push("--space-xl: 64px;");
  lines.push("--radius-sm: 6px;");
  // Semantic aliases — derived from the five core colors.
  lines.push("--color-on-surface: var(--color-text);");
  lines.push("--color-on-accent: var(--color-surface);");
  lines.push("--color-on-primary: var(--color-surface);");
  lines.push("--color-border: var(--color-muted);");
  return `:root {\n  ${lines.join("\n  ")}\n}`;
}

/** WCAG relative-luminance contrast ratio >= 4.5 (AA body text). */
export function contrastOk(fg: string, bg: string): boolean {
  const lum = (hexColor: string) => {
    const n = hexColor.replace("#", "");
    const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
    const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05) >= 4.5;
}

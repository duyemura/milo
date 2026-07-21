import { SECTION_TYPES } from "@milo/schema";

export const manifest = {
  id: "blackout",
  name: "Blackout",
  designLanguage: "Dark gym aesthetic. Oswald display, electric-blue accents, sharp edges, no shadows.",
  implements: Object.fromEntries(
    SECTION_TYPES.map((t) => [t, `${t.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("")}.astro`])
  ) as Record<string, string>,
};

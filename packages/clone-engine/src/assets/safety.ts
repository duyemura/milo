export type SafeImageCategory =
  | "equipment"       // gym equipment close-ups: barbells, kettlebells, pull-up bars, weights
  | "food"            // nutrition/recipe shots: meal prep, protein shakes, healthy food
  | "texture"         // abstract textures: wood, concrete, metal, fabric
  | "architecture"    // non-identifying architectural details: geometric shapes, lighting, space
  | "nature"          // outdoor/nature: sky, trees, paths, light
  | "product";        // generic product/object close-ups

export const HARD_NEGATIVES =
  "no people, no faces, no bodies, no hands, no workout poses, no gym interior, " +
  "no logos, no text, studio lighting, product photography, professional quality";

export const CATEGORY_TEMPLATES: Record<SafeImageCategory, string> = {
  equipment: "Professional studio product photography of {subject}, isolated on neutral background, studio lighting, sharp focus, commercial quality",
  food: "Professional food photography of {subject}, overhead shot, natural lighting, clean presentation, restaurant quality",
  texture: "Abstract texture photograph of {subject}, macro photography, high detail, artistic composition",
  architecture: "Architectural detail photograph of {subject}, clean lines, professional real estate photography style",
  nature: "Nature photography of {subject}, golden hour lighting, landscape photography, professional quality",
  product: "Studio product photography of {subject}, clean background, professional lighting, commercial quality",
};

export class UnsafeBriefError extends Error {
  readonly suggestion: string;
  constructor(message: string, suggestion: string) {
    super(message);
    this.name = "UnsafeBriefError";
    this.suggestion = suggestion;
  }
}

const UNSAFE_PATTERNS: RegExp[] = [
  /\bpeople\b/i, /\bperson\b/i, /\bathletes?\b/i, /\bmembers?\b/i,
  /\bcoach(es)?\b/i, /\btrainers?\b/i, /\bteam\b/i, /\bfaces?\b/i,
  /\bbod(y|ies)\b/i, /\bhands?\b/i, /\bsomeone\b/i,
  /\bworkout pose/i, /\bmid-?workout\b/i,
  // Block gym interior/inside when paired — allow possessives like "gym's barbell".
  // "gym interior", "gym floor", "interior of our CrossFit gym", "inside the gym".
  /\bgym\s+(interior|inside|floor|room|space)\b/i,
  /\b(interior|inside)\b.{0,40}\bgym\b/i,
];

const CATEGORY_SIGNALS: Array<[SafeImageCategory, RegExp[]]> = [
  ["equipment", [/\bbarbell\b/i, /\bkettlebell\b/i, /\bdumbbell\b/i, /\bpull-?up bar\b/i, /\bweight(s| plate)/i, /\brack\b/i, /\bequipment\b/i, /\bgym gear\b/i]],
  ["food", [/\bmeal\b/i, /\bmeal prep\b/i, /\bfood\b/i, /\bprotein\b/i, /\bshake\b/i, /\bsmoothie\b/i, /\brecipe\b/i, /\bnutrition\b/i, /\bhealthy\b/i]],
  ["texture", [/\btexture\b/i, /\bconcrete\b/i, /\bwood(en)?\b/i, /\bmetal\b/i, /\bfabric\b/i, /\bpattern\b/i, /\bsurface (pattern|texture|detail)\b/i, /\bbrushed\b/i]],
  ["architecture", [/\barchitectur/i, /\bgeometric\b/i, /\blighting\b/i, /\bspace\b/i, /\bbuilding\b/i, /\bstructure\b/i]],
  ["nature", [/\bnature\b/i, /\bsky\b/i, /\btrees?\b/i, /\bforest\b/i, /\bpath\b/i, /\btrail\b/i, /\boutdoor\b/i, /\bsunrise\b/i, /\bsunset\b/i, /\blandscape\b/i]],
];

export function classifyBrief(brief: string): SafeImageCategory {
  for (const re of UNSAFE_PATTERNS) {
    if (re.test(brief)) {
      throw new UnsafeBriefError(
        `Brief "${brief}" would require generating people, bodies, or an identifiable interior, which is not allowed.`,
        "Describe a safe subject instead — e.g. equipment (a barbell, kettlebells), a texture (concrete, wood), or an architectural detail (clean lines, lighting).",
      );
    }
  }
  for (const [category, signals] of CATEGORY_SIGNALS) {
    if (signals.some((re) => re.test(brief))) return category;
  }
  return "product";
}

export function buildPrompt(category: SafeImageCategory, subject: string): string {
  return `${CATEGORY_TEMPLATES[category].replace("{subject}", subject)}, ${HARD_NEGATIVES}`;
}

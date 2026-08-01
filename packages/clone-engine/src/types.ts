/** A serialized DOM node: either a text node {t} or an element. */
export type TreeText = { t: string };
export type TreeEl = {
  id: number;
  tag: string;
  attrs: Record<string, string>;
  children: TreeNode[];
};
export type TreeNode = TreeText | TreeEl;

export type StyleMap = Record<string, Record<string, string>>; // id -> prop -> value
export type StylesByWidth = Record<string, StyleMap>;           // "1440"|"768"|"390" -> StyleMap

export interface HeadMeta { key: string; content: string; }
export interface HeadIcon { rel: string; href: string; sizes: string; type: string; }
export interface Head {
  title: string; lang: string;
  metas: HeadMeta[]; icons: HeadIcon[];
  sheetHrefs: string[]; fontFaces: string;
}

export interface ToggleInteraction { toggleId: string; openDelta: StyleMap; prevent: boolean; }
export interface HoverInteraction { parentId: string; delta: StyleMap; }
export interface Interactions { toggles: ToggleInteraction[]; hovers: HoverInteraction[]; }

export interface CaptureJson {
  tree: TreeEl;
  styles: StylesByWidth;
  head: Head;
  fontCss: string;
  interactions: Interactions | null;
  sourceOrigins: string[];
}

export const WIDTHS = [1440, 768, 390] as const;

// ---- Semantic labeling (Plan 2 / A+B) ----

export const SECTION_ROLES = [
  "hero", "faq", "program-cards", "coach-grid", "testimonials", "pricing",
  "cta-band", "feature-grid", "location-map", "schedule", "stats-band",
  "logo-strip", "media-block", "content-block", "contact-form", "lead-form", "unknown",
] as const;

export const BRAND_COLOR_SLOTS = ["primary", "accent", "surface", "text", "muted"] as const;
export const BRAND_FONT_SLOTS = ["display", "body"] as const;

export interface SectionLabel { id: number; name: string; role: string; }
export interface ElementLabel { id: number; role: string; }
export interface AssetLabel { file: string; alias: string; }
export interface BrandSlotColor { slot: string; canon: string; }  // canon = "r,g,b,a"
export interface BrandSlotFont { slot: string; family: string; }

/**
 * The global brand document (`brand.json`) — mirrors `@milo/schema`'s `BrandTokens`
 * shape so the brand is editable from one place. Colors are `#rrggbb` hex (the
 * editable form); the byte-exact CSS cascade lives in the emitted `:root` block.
 */
export interface BrandDoc {
  colors: { primary: string; accent: string; surface: string; text: string; muted: string };
  fonts: { display: string; body: string };
  space: { sm: string; md: string; lg: string };
  radius: { button: string; card: string };
}
export interface Labels {
  site: { name: string; purpose: string };
  brand: { colors: BrandSlotColor[]; fonts: BrandSlotFont[] };
  sections: SectionLabel[];
  elements: ElementLabel[];
  assets: AssetLabel[];
}

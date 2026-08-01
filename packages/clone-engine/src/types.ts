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

// ---- site.json manifest (Plan 2, Task 4) ----

/** One section entry: the region name, its semantic role, and the component filename (e.g. "HeroSection.astro"). */
export interface ManifestSection { name: string; role: string; file: string; }

/** One addressable element: the semantic role, the CSS class handle (e.g. "p42"), and the data-role selector. */
export interface ManifestElement { role: string; id: string; selector: string; }

/** One rehosted asset: the semantic alias (e.g. "logo") and its disk path relative to OUT (e.g. "assets/a1.png"). */
export interface ManifestAsset { alias: string; file: string; }

/** All manifest data for a single projected page. */
export interface ManifestPage {
  route: string;
  component: string;
  sections: ManifestSection[];
  elements: ManifestElement[];
  assets: ManifestAsset[];
  /** Copy map: every text slot that is wired to an editable content[] index. */
  copy: ManifestCopyEntry[];
}

/** The machine-readable site map written to `site.json`. An LLM agent uses this to address any part of the site. */
export interface SiteManifest { brand: string; pages: ManifestPage[]; }

// ---- copy map (Plan 2, Task 5) ----

/**
 * One entry in the copy map: a stable key → the component and content[] index it resolves to.
 *
 * Key format: "<ComponentName>.<contentIndex>" (e.g. "HeroSection.0").
 * The same key is stamped as a data-copy attribute on the element that directly contains the
 * text run. Elements with multiple direct text children carry a space-separated list of keys.
 *
 * An agent workflow:
 *   1. Find the element via its data-copy key (or data-role + data-section context).
 *   2. Look up the key in copy[] to get { component, index }.
 *   3. Open src/components/<component>.astro; edit content[index].
 */
export interface ManifestCopyEntry {
  /** Stable key stamped as data-copy (e.g. "HeroSection.0"). */
  key: string;
  /** The .astro component file that owns this slot (e.g. "HeroSection"). */
  component: string;
  /** Zero-based index into that component's content[] array. */
  index: number;
}

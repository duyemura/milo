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

/**
 * The closed vocabulary of element roles an LLM (subsystem C) may assign. This is the ONE
 * spot the labeler lets a model emit a free role string, so we constrain it to a known set
 * (repairLabels drops anything out-of-enum). Includes every role the deterministic heuristic
 * emits (logo, headline, primary-cta) plus the common editable roles C will want.
 */
export const ELEMENT_ROLES = [
  "logo", "headline", "subheadline", "primary-cta", "secondary-cta",
  "nav-link", "social-link", "body-text", "image", "eyebrow", "list-item", "form-field",
] as const;
export type ElementRole = (typeof ELEMENT_ROLES)[number];

export interface SectionLabel { id: number; name: string; role: string; }
export interface ElementLabel { id: number; role: ElementRole; }
export interface AssetLabel { file: string; alias: string; }
export interface BrandSlotColor { slot: string; canon: string; }  // canon = "r,g,b,a"
export interface BrandSlotFont { slot: string; family: string; }

/**
 * One editable brand color slot. `value` is the EXACT captured CSS literal the `:root`
 * `--color-<slot>` uses (alpha-preserving — e.g. `rgba(175, 175, 175, 0.1)`), so editing it
 * recolors byte/pixel-exactly. `hex` is a convenience `#rrggbb` (alpha dropped) for editors
 * that want an opaque swatch; it is NOT what `:root` emits. `variants` maps each derived
 * opacity/tint token NAME (e.g. `--color-primary-40`) to its exact captured literal.
 */
export interface BrandColorSlot {
  /** Exact captured CSS literal used verbatim by `:root --color-<slot>` (alpha preserved). */
  value: string;
  /** Convenience opaque `#rrggbb` for editors — derived from value, not used by `:root`. */
  hex: string;
  /** Derived variant token name → exact captured literal (e.g. `"--color-primary-40": "rgba(...,0.4)"`). */
  variants: Record<string, string>;
}

/**
 * The global brand document (`brand.json`) — the GENUINE editable source of the canonical
 * `:root` brand cascade. `project()` flattens THIS document into the `--color-<slot>` /
 * `--color-<slot>-<NN>` / `--font-<slot>` custom properties, so editing a slot's `value`
 * here recolors every `var(--color-<slot>)` reference in the site.
 *
 * BYTE-PRESERVING: each `colors[slot].value` (and each `variants[name]`) is the EXACT captured
 * literal, so the first emit is pixel-identical to the capture and any alpha is preserved.
 */
export interface BrandDoc {
  colors: {
    primary: BrandColorSlot; accent: BrandColorSlot; surface: BrandColorSlot;
    text: BrandColorSlot; muted: BrandColorSlot;
  };
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

// ---- Page model (Plan 3, Subsystem D) ----

/**
 * The five page types in the gym-site taxonomy.
 *   home       = the root "/" page
 *   pillar     = core informational pages (about, programs, coaches, services, nutrition, team)
 *   content    = editorial / UGC (blog posts, news, spotlights, recipes, local guides)
 *   conversion = act pages (pricing, membership, join, trial, contact, schedule, book)
 *   utility    = legal / nav / infrastructure (privacy, terms, sitemap, search)
 */
export type PageType = "home" | "pillar" | "content" | "conversion" | "utility";

/**
 * The goal of a page — drives editing conventions (C) and measurement (F).
 *   orient  = home: introduce, orient, navigate
 *   inform  = pillar: educate about the gym / offering
 *   engage  = content: keep readers reading; build trust
 *   convert = conversion: drive a signup / booking / contact
 *   none    = utility: no measurable engagement goal
 *
 * Stored as a separate field (not derived from type at read time) so it can
 * be overridden independently if needed by a future LLM refinement pass.
 */
export type PageGoal = "orient" | "inform" | "engage" | "convert" | "none";

// ---- site.json manifest (Plan 2, Task 4) ----

/**
 * One section entry. `file` is the EXPLICIT, editable path relative to OUT
 * (e.g. `astro/src/components/HeroSection.astro`) so C never guesses which file to open.
 * `copyKeys`/`elementRoles` pre-join the copy + element handles that live in this section,
 * so C doesn't re-derive them from the copy[]/elements[] arrays (Task 4).
 */
export interface ManifestSection {
  name: string;
  role: string;
  file: string;
  /** copy[] keys owned by this section (component-scoped join, ready to look up in copy[]). */
  copyKeys: string[];
  /** Labeled element roles + their p<n> handles that live inside this section. */
  elementRoles: Array<{ role: string; id: string }>;
}

/**
 * One addressable element: the semantic role, the CSS class handle (e.g. "p42"), and a
 * SECTION-SCOPED selector `[data-component=<Comp>] [data-role=<role>]` so a role that appears
 * in two sections isn't ambiguous (Task 5). `component` names the owning section component.
 */
export interface ManifestElement { role: string; id: string; component: string; selector: string; }

/** One rehosted asset: the semantic alias (e.g. "logo") and its disk path relative to OUT (e.g. "assets/a1.png"). */
export interface ManifestAsset { alias: string; file: string; assetId?: string; }

/** All manifest data for a single projected page. */
export interface ManifestPage {
  route: string;
  component: string;
  /** Page type from the gym-site taxonomy (subsystem D). */
  type: PageType;
  /** Goal of the page — drives editing conventions (C) and measurement (F). */
  goal: PageGoal;
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
  /** Truncated preview (~60 chars) of the slot's text, so C can locate copy from site.json alone. */
  text: string;
  /** The element role this text sits inside, when the containing element is labeled (else omitted). */
  role?: string;
}

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

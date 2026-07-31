import { stat } from "node:fs/promises";

export interface ImageCandidate {
  src: string;
  localPath: string;
  alt?: string;
  /** Shortest edge in pixels, when known. */
  widthPx?: number;
  heightPx?: number;
  /** File size in bytes, when known. */
  sizeBytes?: number;
  /** Optional provenance hint used for topic matching. */
  topicHint?: string;
}

export interface QualityGate {
  minSizeBytes: number;
  minShortEdgePx: number;
}

/** Featured-section image quality floor. */
export const DEFAULT_GATE: QualityGate = {
  minSizeBytes: 100 * 1024,
  minShortEdgePx: 600,
};

export interface StatFn {
  (localPath: string): Promise<{ size: number } | null>;
}

export const defaultStat: StatFn = async (localPath: string) => {
  try {
    const s = await stat(localPath);
    return { size: s.size };
  } catch {
    return null;
  }
};

function shortEdgePx(candidate: Pick<ImageCandidate, "widthPx" | "heightPx">): number | undefined {
  if (candidate.widthPx && candidate.heightPx) {
    return Math.min(candidate.widthPx, candidate.heightPx);
  }
  return undefined;
}

/** True when the candidate meets every available gate dimension. */
export function passesGate(candidate: ImageCandidate, gate: QualityGate = DEFAULT_GATE): boolean {
  const hasSize = candidate.sizeBytes !== undefined;
  const hasEdge = shortEdgePx(candidate) !== undefined;
  if (!hasSize && !hasEdge) return false;
  const sizeOk = hasSize ? (candidate.sizeBytes ?? 0) >= gate.minSizeBytes : true;
  const edgeOk = hasEdge ? (shortEdgePx(candidate) ?? 0) >= gate.minShortEdgePx : true;
  return sizeOk && edgeOk;
}

/** Score for ranking candidates. Prefers large files and high resolution. */
export function imageScore(candidate: ImageCandidate): number {
  let score = candidate.sizeBytes ?? 0;
  const edge = shortEdgePx(candidate);
  if (edge !== undefined) score += edge * 1000;
  return score;
}

/** Build a normalized candidate pool from crawled page assets and GMB photos. */
export async function buildCandidatePool(
  pageAssets: { src: string; alt: string; localPath: string | null }[],
  gmbAssets: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[],
  statFile: StatFn = defaultStat,
): Promise<ImageCandidate[]> {
  const unique = new Map<string, ImageCandidate>();

  for (const asset of pageAssets) {
    if (!asset.localPath) continue;
    const size = await statFile(asset.localPath);
    const candidate: ImageCandidate = {
      src: asset.src,
      localPath: asset.localPath,
      alt: asset.alt,
      sizeBytes: size?.size,
      topicHint: [asset.src, asset.alt].filter(Boolean).join(" "),
    };
    // Page assets may appear on multiple pages; keep the first unique local path.
    if (!unique.has(asset.localPath)) unique.set(asset.localPath, candidate);
  }

  for (const photo of gmbAssets) {
    const size = await statFile(photo.localPath);
    const candidate: ImageCandidate = {
      src: photo.localPath,
      localPath: photo.localPath,
      sizeBytes: size?.size,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      topicHint: "google business profile",
    };
    if (!unique.has(photo.localPath)) unique.set(photo.localPath, candidate);
  }

  return [...unique.values()];
}

/**
 * Topic-matching score based on keyword overlap between the program and the candidate
 * src/alt/topicHint. Returns a positive number for matches, 0 otherwise.
 */
function topicMatchScore(programText: string, candidate: ImageCandidate): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
  const programWords = new Set(normalize(programText));
  if (programWords.size === 0) return 0;
  const candidateText = [candidate.src, candidate.alt, candidate.topicHint].filter(Boolean).join(" ");
  const candidateWords = normalize(candidateText);
  let hits = 0;
  for (const word of candidateWords) {
    if (programWords.has(word)) hits++;
  }
  return hits;
}

/** Pick the best substitute for a program card image that fails the quality gate. */
export function pickProgramImage(
  programName: string,
  programDescription: string,
  candidates: ImageCandidate[],
  gate: QualityGate = DEFAULT_GATE,
): ImageCandidate | null {
  if (candidates.length === 0) return null;
  const programText = `${programName} ${programDescription}`;

  // Prefer candidates that both pass the gate and match the topic.
  const gatedMatches = candidates
    .filter((c) => passesGate(c, gate) && topicMatchScore(programText, c) > 0)
    .sort((a, b) => imageScore(b) - imageScore(a));
  if (gatedMatches.length > 0) return gatedMatches[0];

  // Fall back to any gated candidate.
  const gated = candidates
    .filter((c) => passesGate(c, gate))
    .sort((a, b) => imageScore(b) - imageScore(a));
  if (gated.length > 0) return gated[0];

  // Last resort: any matching candidate by topic, even if below the gate.
  const topicMatches = candidates
    .filter((c) => topicMatchScore(programText, c) > 0)
    .sort((a, b) => imageScore(b) - imageScore(a));
  if (topicMatches.length > 0) return topicMatches[0];

  return null;
}

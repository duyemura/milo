/**
 * Browser-context section segmentation. Injected via page.evaluate, so it must
 * be fully self-contained (helpers nested inside, no external references).
 * Fixes the flat `body > *, section` heuristic that collapsed on real sites:
 * it descends shell wrappers (one meaningful child) so a giant wrapper does not
 * masquerade as one section, and it emits *direct children of the spine* so
 * nested/overlapping duplicates never appear.
 */
export const segmentPage = () => {
  const MIN_H = 80;
  const MIN_H_SHORT = 20; // keep header/footer siblings even when visually compact
  const isHeaderFooter = (el) => el.tagName === "HEADER" || el.tagName === "FOOTER";
  const minHeightFor = (el) => (isHeaderFooter(el) ? MIN_H_SHORT : MIN_H);
  const tall = (el, min = MIN_H) =>
    [...el.children].filter((c) => c.getBoundingClientRect().height >= min);
  const isShell = (el) => tall(el, MIN_H).length === 1;
  const descend = (el) => {
    let node = el;
    let guard = 0;
    while (isShell(node) && guard++ < 20) {
      const next = tall(node, MIN_H)[0];
      if (!next || next === node) break;
      node = next;
    }
    return node;
  };
  const spine = descend(document.querySelector("main") || document.body);
  const out = [];
  for (const el of spine.children) {
    const r = el.getBoundingClientRect();
    const h = Math.round(r.height);
    if (h < minHeightFor(el)) continue;
    const cs = getComputedStyle(el);
    // Fixed elements are viewport-relative; everything else is document-relative.
    const y = cs.position === "fixed" ? Math.round(r.y) : Math.round(r.y + window.scrollY);
    out.push({
      tag: el.tagName,
      cls: (el.className?.toString() || "").slice(0, 140),
      y,
      height: h,
      position: cs.position,
      bg: cs.backgroundColor,
      padding: cs.padding,
      heading: el.querySelector("h1,h2,h3")?.textContent?.trim().slice(0, 100) ?? null,
      childCount: el.children.length,
    });
  }
  return out;
};

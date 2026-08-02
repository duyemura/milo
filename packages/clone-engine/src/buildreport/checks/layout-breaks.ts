import type { Browser } from "playwright";
import type { CheckResult, PageContext } from "../types.ts";
import { overlaps, OVERLAP_TOLERANCE_PX } from "../../edit/verify.ts";
import { renderSnapshot } from "../../edit/snapshot.ts";

export async function checkLayoutBreaks(page: PageContext, browser: Browser, width: number): Promise<CheckResult> {
  const snap = await renderSnapshot(browser, { dir: page.siteDir }, { width });
  const issues = [];

  // Check every pair of sections for overlap — same geometry as verify.ts structural check.
  const sectionList = [...snap.sections.values()];
  for (let i = 0; i < sectionList.length; i++) {
    for (let j = i + 1; j < sectionList.length; j++) {
      if (overlaps(sectionList[i].box, sectionList[j].box, OVERLAP_TOLERANCE_PX)) {
        issues.push({
          severity: "blocker" as const,
          page: page.route,
          section: sectionList[i].name,
          kind: "layout-break",
          detail: `Section "${sectionList[i].name}" overlaps "${sectionList[j].name}" at ${width}px viewport`,
        });
      }
    }
  }
  return { issues };
}

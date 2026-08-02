import type { SiteReport, Issue } from "./types.ts";

function badge(s: Issue["severity"]): string {
  return s === "blocker" ? "🔴" : s === "note" ? "🟡" : "ℹ️";
}

export function renderSiteReport(report: SiteReport): string {
  const verdictColor = report.verdict === "SHIP" ? "#22c55e" : "#ef4444";
  const verdictMsg = report.verdict === "SHIP"
    ? "✅ SHIP — zero blockers"
    : `⚠️ NEEDS_FIXES — ${report.blockerCount} blocker${report.blockerCount !== 1 ? "s" : ""}`;

  const issueRows = report.issues.map((i) =>
    `<tr><td>${badge(i.severity)} ${i.severity}</td><td>${i.page}</td><td>${i.section ?? "—"}</td><td>${i.kind}</td><td>${i.detail}</td></tr>`
  ).join("");

  const pageRows = report.pages.map((p) =>
    `<tr><td>${p.route}</td><td>${p.pageWeightKb} KB</td><td>${p.issues.filter((i) => i.severity === "blocker").length}</td><td>${p.fidelityPct != null ? p.fidelityPct.toFixed(1) + "%" : "—"}</td></tr>`
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site Build Report — ${report.generatedAt.slice(0, 10)}</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:2rem;background:#f9fafb;color:#111}
  .verdict{font-size:2rem;font-weight:700;color:${verdictColor};padding:1rem;background:#fff;border-radius:8px;margin-bottom:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  .summary{display:flex;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap;align-items:center}
  .chip{padding:.3rem .7rem;border-radius:6px;font-size:.85rem;font-weight:600}
  .blocker{background:#fee2e2;color:#991b1b}
  .note{background:#fef9c3;color:#854d0e}
  .info{background:#dbeafe;color:#1e40af}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);margin-bottom:1.5rem}
  th{background:#f3f4f6;text-align:left;padding:.6rem .8rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
  td{padding:.55rem .8rem;border-top:1px solid #f3f4f6;font-size:.84rem}
  h2{font-size:1.1rem;margin:1.5rem 0 .4rem;color:#374151}
  .ts{margin-left:auto;font-size:.75rem;color:#6b7280}
</style>
</head>
<body>
<div class="verdict">${verdictMsg}</div>
<div class="summary">
  <span class="chip blocker">${report.blockerCount} blocker${report.blockerCount !== 1 ? "s" : ""}</span>
  <span class="chip note">${report.noteCount} note${report.noteCount !== 1 ? "s" : ""}</span>
  <span class="chip info">${report.infoCount} info</span>
  <span class="ts">Generated ${report.generatedAt}</span>
</div>
<h2>Issues</h2>
<table>
  <thead><tr><th>Severity</th><th>Page</th><th>Section</th><th>Check</th><th>Detail</th></tr></thead>
  <tbody>${issueRows || "<tr><td colspan='5' style='color:#6b7280;font-style:italic'>No issues found.</td></tr>"}</tbody>
</table>
<h2>Pages</h2>
<table>
  <thead><tr><th>Route</th><th>Weight</th><th>Blockers</th><th>Fidelity</th></tr></thead>
  <tbody>${pageRows}</tbody>
</table>
</body>
</html>`;
}

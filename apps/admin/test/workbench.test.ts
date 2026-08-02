import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sseFrame } from "../src/server/routes/workbench.ts";
import { sitePaths } from "../src/jobs/paths.ts";
import { testApp, seedRegistry } from "./helpers.ts";

describe("sseFrame", () => {
  it("formats a RunState as a single SSE data frame", () => {
    const frame = sseFrame({ status: "building", totalPages: 3, pagesCompleted: 1, current: { route: "/", phase: "build" }, discovered: ["/"], failures: [] });
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.slice("data: ".length))).toMatchObject({ status: "building", pagesCompleted: 1 });
  });
});

describe("workbench report + preview", () => {
  const created: string[] = [];
  afterAll(() => created.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("serves build-report.json and a preview file", async () => {
    const { app, db, config } = await testApp();
    await seedRegistry(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: { companyId: "co1", seedType: "clone", sourceUrl: "https://x.com" },
    });
    const { site } = res.json() as { site: { id: string } };
    const p = sitePaths(config, site.id);
    created.push(p.dir);
    mkdirSync(p.seedDir, { recursive: true });
    mkdirSync(p.distDir, { recursive: true });
    writeFileSync(p.reportJson, JSON.stringify({ pages: [{ route: "/", ok: true }], generatedAt: "now" }));
    writeFileSync(path.join(p.distDir, "index.html"), "<html><body>hi</body></html>");

    const report = await app.inject({ method: "GET", url: `/api/v1/sites/${site.id}/report` });
    expect(report.statusCode).toBe(200);
    expect((report.json() as { report: { pages: unknown[] } }).report.pages).toHaveLength(1);

    const preview = await app.inject({ method: "GET", url: `/sites/${site.id}/site/index.html` });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain("hi");

    const rootPreview = await app.inject({ method: "GET", url: `/sites/${site.id}/site/` });
    expect(rootPreview.statusCode).toBe(200);
    expect(rootPreview.body).toContain("hi");

    // A fresh site without a report file → 404.
    const { app: app2, db: db2 } = await testApp();
    await seedRegistry(db2);
    const r2 = await app2.inject({ method: "POST", url: "/api/v1/sites", payload: { companyId: "co1", seedType: "none" } });
    const { site: site2 } = r2.json() as { site: { id: string } };
    const none = await app2.inject({ method: "GET", url: `/api/v1/sites/${site2.id}/report` });
    expect(none.statusCode).toBe(404);
    await app.close();
    await app2.close();
  });
});

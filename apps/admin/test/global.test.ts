import { describe, expect, it } from "vitest";
import { testApp, fakeQueue, seedRegistry } from "./helpers.ts";

describe("stage management", () => {
  it("sites start in onboarding; PATCH stage moves them; invalid stage 400s", async () => {
    const { app, db } = await testApp(fakeQueue());
    await seedRegistry(db);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: {
        companyId: "co1",
        seedType: "template",
        sourceUrl: "https://gym.example.com",
        name: "Iron Anchor",
        city: "Denver",
        state: "CO",
      },
    });
    expect(created.statusCode).toBe(201);
    const { site } = created.json() as { site: { id: string; stage: string } };
    expect(site.stage).toBe("onboarding");

    const moved = await app.inject({
      method: "PATCH",
      url: `/api/v1/sites/${site.id}/stage`,
      payload: { stage: "in-review" },
    });
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as { site: { stage: string } }).site.stage).toBe("in-review");

    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/sites/${site.id}/stage`,
      payload: { stage: "live-ish" },
    });
    expect(bad.statusCode).toBe(400);

    await app.close();
  });
});

describe("global routes: search + job feed", () => {
  it("search finds workspaces and companies by name and sites by slug/url", async () => {
    const { app, db } = await testApp(fakeQueue());
    await seedRegistry(db);
    await db
      .insertInto("sites")
      .values({
        id: "s-search",
        workspaceId: "ws1",
        companyId: "co1",
        seedType: "clone",
        sourceUrl: "https://speakeasyofstrength.com",
        slug: "page-clone-speakeasy",
        status: "deployed",
        stage: "live",
        active: 1,
        createdAt: new Date().toISOString(),
      })
      .execute();

    const byCompany = await app.inject({ method: "GET", url: "/api/v1/search?q=iron" });
    const c = byCompany.json() as { companies: { name: string }[] };
    expect(c.companies.map((x) => x.name)).toContain("Iron Anchor");

    const byWorkspace = await app.inject({ method: "GET", url: "/api/v1/search?q=acme" });
    expect((byWorkspace.json() as { workspaces: { name: string }[] }).workspaces.map((x) => x.name)).toContain(
      "Acme Fitness Group",
    );

    const bySlug = await app.inject({ method: "GET", url: "/api/v1/search?q=speakeasy" });
    const s = bySlug.json() as { sites: { companyName: string }[] };
    expect(s.sites.map((x) => x.companyName)).toContain("Iron Anchor");

    const tooShort = await app.inject({ method: "GET", url: "/api/v1/search?q=a" });
    expect((tooShort.json() as { workspaces: unknown[] }).workspaces).toHaveLength(0);

    await app.close();
  });

  it("job feed returns jobs across sites with company names and status filtering", async () => {
    const { app, db } = await testApp(fakeQueue());
    await seedRegistry(db);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: {
        companyId: "co1",
        seedType: "template",
        sourceUrl: "https://gym.example.com",
        name: "Iron Anchor",
        city: "Denver",
        state: "CO",
      },
    });
    const { site } = created.json() as { site: { id: string } };

    const feed = await app.inject({ method: "GET", url: "/api/v1/jobs" });
    const { jobs } = feed.json() as { jobs: { siteId: string; companyName: string; status: string }[] };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ siteId: site.id, companyName: "Iron Anchor" });

    const filtered = await app.inject({ method: "GET", url: "/api/v1/jobs?status=failed" });
    expect((filtered.json() as { jobs: unknown[] }).jobs).toHaveLength(0);

    await app.close();
  });
});

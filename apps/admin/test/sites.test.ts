import { describe, expect, it } from "vitest";
import { testApp, fakeQueue, seedRegistry } from "./helpers.ts";

describe("sites + jobs routes", () => {
  it("creates a site, deactivates prior sites, and auto-enqueues a seed job", async () => {
    const queue = fakeQueue();
    const { app, db } = await testApp(queue);
    await seedRegistry(db);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: { companyId: "co1", seedType: "template", sourceUrl: "https://gym.example.com" },
    });
    expect(missing.statusCode).toBe(400);

    const res = await app.inject({
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
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      site: { id: string; status: string };
      seedJob: { id: string; status: string; queuePosition: number };
    };
    expect(body.site.status).toBe("seeding");
    expect(body.seedJob.status).toBe("queued");
    expect(body.seedJob.queuePosition).toBe(0);
    expect(queue.added).toEqual([body.seedJob.id]);

    // Second site for same company: first becomes inactive, new seed queues.
    const res2 = await app.inject({
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
    const body2 = res2.json() as { site: { id: string } };
    const first = await db.selectFrom("sites").selectAll().where("id", "=", body.site.id).executeTakeFirstOrThrow();
    const second = await db.selectFrom("sites").selectAll().where("id", "=", body2.site.id).executeTakeFirstOrThrow();
    expect(first.active).toBe(0);
    expect(second.active).toBe(1);

    await app.close();
  });

  it("POST /:id/jobs returns 202 with queue position behind an active job", async () => {
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

    const jobRes = await app.inject({
      method: "POST",
      url: `/api/v1/sites/${site.id}/jobs`,
      payload: { type: "deploy-staging" },
    });
    expect(jobRes.statusCode).toBe(202);
    const { job } = jobRes.json() as { job: { status: string; queuePosition: number } };
    expect(job.status).toBe("waiting");
    expect(job.queuePosition).toBe(1);

    const unknown = await app.inject({ method: "GET", url: "/api/v1/sites/nope" });
    expect(unknown.statusCode).toBe(404);

    await app.close();
  });

  it("clone seed works via the TS clone engine — requires only sourceUrl", async () => {
    const queue = fakeQueue();
    const { app, db } = await testApp(queue);
    await seedRegistry(db);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: { companyId: "co1", seedType: "clone" },
    });
    expect(missing.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: { companyId: "co1", seedType: "clone", sourceUrl: "https://speakeasyofstrength.com" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { site: { seedType: string }; seedJob: { status: string } };
    expect(body.site.seedType).toBe("clone");
    expect(body.seedJob.status).toBe("queued");
    expect(queue.added).toHaveLength(1);
    await app.close();
  });

  it("seedType 'none' creates an unseeded shell with no job", async () => {
    const queue = fakeQueue();
    const { app, db } = await testApp(queue);
    await seedRegistry(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: { companyId: "co1", seedType: "none" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { site: { seedType: string; status: string }; seedJob: null };
    expect(body.site.seedType).toBe("none");
    expect(body.site.status).toBe("registered");
    expect(body.seedJob).toBeNull();
    expect(queue.added).toHaveLength(0);
    await app.close();
  });

  it("POST /:id/seed switches a shell to clone and enqueues", async () => {
    const queue = fakeQueue();
    const { app, db } = await testApp(queue);
    await seedRegistry(db);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: { companyId: "co1", seedType: "none" },
    });
    const { site } = created.json() as { site: { id: string } };

    const bad = await app.inject({ method: "POST", url: `/api/v1/sites/${site.id}/seed`, payload: { seedType: "clone" } });
    expect(bad.statusCode).toBe(400); // clone needs sourceUrl

    const seeded = await app.inject({
      method: "POST",
      url: `/api/v1/sites/${site.id}/seed`,
      payload: { seedType: "clone", sourceUrl: "https://speakeasyofstrength.com" },
    });
    expect(seeded.statusCode).toBe(202);
    const body = seeded.json() as { seedJob: { status: string } };
    expect(body.seedJob.status).toBe("queued");
    expect(queue.added).toHaveLength(1);
    const row = await db.selectFrom("sites").selectAll().where("id", "=", site.id).executeTakeFirstOrThrow();
    expect(row.seedType).toBe("clone");
    expect(row.sourceUrl).toBe("https://speakeasyofstrength.com");
    await app.close();
  });

  it("GET /:id includes a RunState (discovering before any events)", async () => {
    const { app, db } = await testApp(fakeQueue());
    await seedRegistry(db);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: { companyId: "co1", seedType: "clone", sourceUrl: "https://speakeasyofstrength.com" },
    });
    const { site } = created.json() as { site: { id: string } };
    const res = await app.inject({ method: "GET", url: `/api/v1/sites/${site.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { runState: { status: string; totalPages: number } };
    // A site with no logged events projects to initialRunState() — "discovering", 0 pages.
    expect(body.runState.status).toBe("discovering");
    expect(body.runState.totalPages).toBe(0);
    await app.close();
  });

  it("POST /:id/seed rejects seedType 'none'", async () => {
    const queue = fakeQueue();
    const { app, db } = await testApp(queue);
    await seedRegistry(db);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: { companyId: "co1", seedType: "none" },
    });
    const { site } = created.json() as { site: { id: string } };
    const res = await app.inject({ method: "POST", url: `/api/v1/sites/${site.id}/seed`, payload: { seedType: "none" } });
    expect(res.statusCode).toBe(400);
    expect(queue.added).toHaveLength(0);
    await app.close();
  });
});

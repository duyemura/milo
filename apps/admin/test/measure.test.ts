import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { testDb, testConfig } from "./helpers.ts";
import { runJob } from "../src/jobs/runner.ts";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
const FAKE_SA = {
  client_email: "sa@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
};

async function seededSite(db: Awaited<ReturnType<typeof testDb>>) {
  await db
    .insertInto("workspaces")
    .values({ id: "ws1", name: "WG", contact: null, status: "active", createdAt: new Date().toISOString() })
    .execute();
  await db
    .insertInto("companies")
    .values({ id: "co1", workspaceId: "ws1", companyId: "pp-x", name: "Iron Anchor", status: "active", createdAt: new Date().toISOString() })
    .execute();
  await db
    .insertInto("sites")
    .values({
      id: "m-site",
      workspaceId: "ws1",
      companyId: "co1",
      seedType: "template",
      sourceUrl: "https://x.example.com",
      slug: "iron-anchor-abc123",
      status: "deployed",
      stage: "in-review",
      active: 1,
      createdAt: new Date().toISOString(),
    })
    .execute();
  await db
    .insertInto("jobs")
    .values({
      id: "seed-m",
      workspaceId: "ws1",
      companyId: "co1",
      siteId: "m-site",
      type: "seed",
      status: "succeeded",
      payload: JSON.stringify({ name: "Iron Anchor", city: "Denver", state: "CO", sourceUrl: "https://x", templateId: "modern" }),
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    })
    .execute();
}

describe("measure job", () => {
  it("collects places + provisions ga4 + records gsc with scripted fetches", async () => {
    const db = await testDb();
    await seededSite(db);
    const dataDir = await mkdtemp(path.join(tmpdir(), "measure-"));
    const site = await db.selectFrom("sites").selectAll().where("id", "=", "m-site").executeTakeFirstOrThrow();
    const job = {
      id: "mj1",
      workspaceId: "ws1",
      companyId: "co1",
      siteId: "m-site",
      type: "measure" as const,
      status: "running" as const,
      payload: "{}",
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    await db.insertInto("jobs").values(job).execute();

    const fetchFn = async (url: string, init?: { method?: string }) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      if (url.includes("places.googleapis.com/v1/places:searchText")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [{ id: "pid", rating: 4.9, userRatingCount: 88, reviews: [{ rating: 5, text: { text: "Best coached hour in Denver." } }] }],
          }),
        };
      }
      if (url.includes("analyticsadmin.googleapis.com/v1alpha/accounts") && init?.method !== "POST") {
        return { ok: true, status: 200, json: async () => ({ accounts: [{ name: "accounts/1", displayName: "PushPress sites" }] }) };
      }
      if (url.includes("/properties?filter=") && init?.method !== "POST") {
        return { ok: true, status: 200, json: async () => ({ properties: [{ name: "properties/2", displayName: "iron-anchor-abc123" }] }) };
      }
      if (url.includes("/dataStreams") && init?.method !== "POST") {
        return { ok: true, status: 200, json: async () => ({ dataStreams: [{ name: "s3", webStreamData: { measurementId: "G-XX1", defaultUri: "https://iron-anchor-abc123-staging.mygymseo.com/" } }] }) };
      }
      if (url.includes("webmasters/v3/sites") && url.includes("searchAnalytics")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ rows: [{ keys: ["crossfit denver"], clicks: 4, impressions: 40, position: 9.2 }] }),
        };
      }
      if (url.includes("analyticsdata.googleapis.com/v1beta") && url.includes(":runReport")) {
        const body = init?.body ? JSON.parse(init.body) : {};
        const dims = (body.dimensions ?? []).map((d: { name: string }) => d.name);
        if (!body.dateRanges) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              dimensionHeaders: [{ name: "streamName" }],
              metricHeaders: [{ name: "activeUsers" }],
              rows: [{ dimensionValues: [{ value: "properties/548090288/dataStreams/1" }], metricValues: [{ value: "0" }] }],
            }),
          };
        }
        if (dims.includes("eventName")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              dimensionHeaders: [{ name: "streamName" }, { name: "eventName" }],
              metricHeaders: [{ name: "eventCount" }],
              rows: [],
            }),
          };
        }
        if (dims.includes("pagePath")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              dimensionHeaders: [{ name: "streamName" }, { name: "pagePath" }],
              metricHeaders: [{ name: "screenPageViews" }],
              rows: [],
            }),
          };
        }
        if (dims.includes("sessionSource")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              dimensionHeaders: [{ name: "streamName" }, { name: "sessionSource" }],
              metricHeaders: [{ name: "totalUsers" }],
              rows: [],
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            dimensionHeaders: [{ name: "streamName" }],
            metricHeaders: [{ name: "totalUsers" }, { name: "screenPageViews" }, { name: "engagementRate" }, { name: "eventCount" }],
            rows: [{ dimensionValues: [{ value: "properties/548090288/dataStreams/1" }], metricValues: [{ value: "0" }, { value: "0" }, { value: "0" }, { value: "0" }] }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const digest = await runJob({
      db,
      config: testConfig({ dataDir, googlePlacesApiKey: "k", googleServiceAccountJson: "/tmp/x", analyticsOnStaging: true }),
      job,
      site,
      spawn: async () => ({ code: 1, lines: [] }),
      measure: { fetchFn: fetchFn as never, loadSa: () => FAKE_SA },
    });

    expect(digest).toContain("4.9");
    expect(digest).toContain("G-XX1");

    const conns = await db.selectFrom("google_connections").selectAll().where("siteId", "=", "m-site").execute();
    expect(conns.map((c) => c.kind).sort()).toEqual(["ga4", "gsc", "places"]);
    const metrics = await db.selectFrom("site_metrics").selectAll().where("siteId", "=", "m-site").execute();
    expect(metrics.some((m) => m.metric === "rating")).toBe(true);
    expect(metrics.some((m) => m.metric === "review_count")).toBe(true);

    await rm(dataDir, { recursive: true, force: true });
  });

  it("scaffold mode: works without service account, records places only", async () => {
    const db = await testDb();
    await seededSite(db);
    const dataDir = await mkdtemp(path.join(tmpdir(), "measure-"));
    const site = await db.selectFrom("sites").selectAll().where("id", "=", "m-site").executeTakeFirstOrThrow();
    const job = {
      id: "mj2",
      workspaceId: "ws1",
      companyId: "co1",
      siteId: "m-site",
      type: "measure" as const,
      status: "running" as const,
      payload: "{}",
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    await db.insertInto("jobs").values(job).execute();
    const fetchFn = async (url: string) => {
      if (url.includes("places.googleapis.com/v1/places:searchText")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ places: [{ id: "pid", rating: 4.1, userRatingCount: 12, reviews: [] }] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const digest = await runJob({
      db,
      config: testConfig({ dataDir, googlePlacesApiKey: "k", googleServiceAccountJson: undefined }),
      job,
      site,
      spawn: async () => ({ code: 1, lines: [] }),
      measure: { fetchFn: fetchFn as never, loadSa: () => FAKE_SA },
    });
    expect(digest).toContain("4.1");
    const conns = await db.selectFrom("google_connections").selectAll().where("siteId", "=", "m-site").execute();
    expect(conns.map((c) => c.kind)).toEqual(["places"]);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("production gate: google registration waits for a production deploy (staging flag off)", async () => {
    const db = await testDb();
    await seededSite(db);
    const dataDir = await mkdtemp(path.join(tmpdir(), "measure-"));
    const site = await db.selectFrom("sites").selectAll().where("id", "=", "m-site").executeTakeFirstOrThrow();
    const job = {
      id: "mj3",
      workspaceId: "ws1",
      companyId: "co1",
      siteId: "m-site",
      type: "measure" as const,
      status: "running" as const,
      payload: "{}",
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    await db.insertInto("jobs").values(job).execute();
    const fetchFn = async (url: string) => {
      if (url.includes("places.googleapis.com/v1/places:searchText")) {
        return { ok: true, status: 200, json: async () => ({ places: [{ id: "pid", rating: 4.2, userRatingCount: 9, reviews: [] }] }) };
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      throw new Error("google call that must never happen pre-production: " + url);
    };
    const digest = await runJob({
      db,
      config: testConfig({ dataDir, googlePlacesApiKey: "k", googleServiceAccountJson: "/tmp/x" }),
      job,
      site,
      spawn: async () => ({ code: 1, lines: [] }),
      measure: { fetchFn: fetchFn as never, loadSa: () => FAKE_SA },
    });
    expect(digest).toContain("4.2");
    const conns = await db.selectFrom("google_connections").selectAll().where("siteId", "=", "m-site").execute();
    expect(conns.map((c) => c.kind)).toEqual(["places"]);
    const logs = await db.selectFrom("job_logs").selectAll().where("jobId", "=", "mj3").execute();
    expect(logs.some((l) => l.line.includes("skipped: staging-only"))).toBe(true);
    await rm(dataDir, { recursive: true, force: true });
  });
});

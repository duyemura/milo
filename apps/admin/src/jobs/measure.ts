import { randomUUID } from "node:crypto";
import {
  gbpStatus,
  gscFetchQueries,
  gscEnsureProperty,
  ga4EnsureAccount,
  ga4EnsureSharedProperty,
  ga4EnsureStream,
  fetchPlaceMetrics,
  loadServiceAccount,
  injectGtag,
  injectMeta,
  type FetchLike,
  type ServiceAccount,
} from "@milo/measurement";
import path from "node:path";
import * as fs from "node:fs";
import type { AdminDb } from "../db/index.ts";
import type { AdminConfig } from "../config.ts";
import type { JobRow, SiteRow } from "../db/types.ts";
import { appendLog } from "./dispatch.ts";

/** Ensure GSC before a deploy so the meta tag rides the FIRST served bytes (either seed path). */
export async function gscEnsureBeforeDeploy(opts: {
  db: AdminDb;
  config: AdminConfig;
  site: SiteRow;
  schemeUrl: string;
  fetchFn?: FetchLike;
}): Promise<{ issued: boolean; reason: string | null }> {
  const { db, config, site, schemeUrl, fetchFn } = opts;
  if (!config.googleServiceAccountJson) return { issued: false, reason: "no service account" };
  try {
    const sa = loadServiceAccount(config.googleServiceAccountJson);
    const prop = await gscEnsureProperty({ sa, schemeUrl, fetchFn });
    await upsertConnection(db, site, "gsc", prop.propertyUrl, {
      metaTagToken: prop.metaTagToken,
      verified: prop.verified,
    });
    return { issued: prop.metaTagToken !== null || prop.verified, reason: null };
  } catch (err) {
    return { issued: false, reason: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

export interface MeasureDeps {
  fetchFn?: FetchLike;
  loadSa?: (path: string) => ServiceAccount;
}

function stagingUrl(site: SiteRow): string | null {
  return site.slug ? `https://${site.slug}-staging.mygymseo.com/` : null;
}

export async function upsertConnection(
  db: AdminDb,
  site: SiteRow,
  kind: "gsc" | "ga4" | "gbp" | "places",
  externalId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db
    .selectFrom("google_connections")
    .selectAll()
    .where("siteId", "=", site.id)
    .where("kind", "=", kind)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("google_connections")
      .set({ externalId, status: "active", meta: JSON.stringify(meta), updatedAt: now })
      .where("id", "=", existing.id)
      .execute();
    return;
  }
  await db
    .insertInto("google_connections")
    .values({
      id: randomUUID(),
      workspaceId: site.workspaceId,
      companyId: site.companyId,
      siteId: site.id,
      kind,
      externalId,
      status: "active",
      meta: JSON.stringify(meta),
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

async function recordMetric(
  db: AdminDb,
  site: SiteRow,
  source: string,
  metric: string,
  value: string | number,
  dimensions: Record<string, unknown> = {},
): Promise<void> {
  await db
    .insertInto("site_metrics")
    .values({
      id: randomUUID(),
      workspaceId: site.workspaceId,
      companyId: site.companyId,
      siteId: site.id,
      source,
      metric,
      dimensions: JSON.stringify(dimensions),
      value: String(value),
      collectedAt: new Date().toISOString(),
    })
    .execute();
}


/** Post-build injection: gtag + GSC meta into every built HTML page, idempotently. */
export async function injectIntoDist(opts: {
  db: AdminDb;
  site: SiteRow;
  distDir: string;
  config?: AdminConfig;
  env?: "staging" | "production";
}): Promise<{ injected: number; files: number }> {
  const { db, site, distDir } = opts;
  // Central policy gate: no tracking on staging by default (production gate lives at deploy).
  const env = opts.env ?? "staging";
  if (opts.config && env !== "production" && !opts.config.analyticsOnStaging) {
    return { injected: 0, files: 0 };
  }
  const conns = await db.selectFrom("google_connections").selectAll().where("siteId", "=", site.id).execute();
  const ga4 = conns.find((c) => c.kind === "ga4" && c.status === "active");
  const gsc = conns.find((c) => c.kind === "gsc" && c.status === "active");
  const measurementId = ga4?.externalId ?? null;
  const metaToken = gsc?.meta ? ((JSON.parse(gsc.meta) as { metaTagToken?: string | null }).metaTagToken ?? null) : null;
  if (!measurementId && !metaToken) return { injected: 0, files: 0 };
  if (!fs.existsSync(distDir)) return { injected: 0, files: 0 };

  let injected = 0;
  let files = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".html")) {
        files += 1;
        let html = fs.readFileSync(p, "utf-8");
        let changed = false;
        if (measurementId) {
          const r = injectGtag(html, measurementId, {
            siteId: site.slug ?? site.id,
            workspaceId: site.workspaceId,
            companyId: site.companyId,
            env: "staging",
          });
          if (r.changed) changed = true;
          html = r.html;
        }
        if (metaToken) {
          const r = injectMeta(html, "google-site-verification", metaToken);
          if (r.changed) changed = true;
          html = r.html;
        }
        if (changed) {
          fs.writeFileSync(p, html);
          injected += 1;
        }
      }
    }
  };
  walk(distDir);
  return { injected, files };
}

/** gym facts: the measure job payload wins, then the last seed payload (clone seeds lack them). */
async function gymFacts(db: AdminDb, site: SiteRow, jobPayload: Record<string, string> = {}) {
  const lastSeed = await db
    .selectFrom("jobs")
    .selectAll()
    .where("siteId", "=", site.id)
    .where("type", "=", "seed")
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
  const p = lastSeed ? (JSON.parse(lastSeed.payload) as Record<string, string>) : {};
  return {
    name: jobPayload["name"] ?? p["name"],
    city: jobPayload["city"] ?? p["city"],
    state: jobPayload["state"] ?? p["state"],
  };
}

export async function runMeasureJob(opts: {
  db: AdminDb;
  config: AdminConfig;
  job: JobRow;
  site: SiteRow;
  deps?: MeasureDeps;
}): Promise<string> {
  const { db, config, job, site, deps } = opts;
  const log = (line: string) => appendLog(db, job.id, line);
  const payload = JSON.parse(job.payload) as Record<string, string>;
  const facts = await gymFacts(db, site, payload);
  const company = await db.selectFrom("companies").selectAll().where("id", "=", site.companyId).executeTakeFirstOrThrow();
  void company;
  const digest: string[] = [];

  // 1. Places ratings (open API — works today for everyone with a key).
  if (config.googlePlacesApiKey && facts.name && facts.city && facts.state) {
    try {
      const m = await fetchPlaceMetrics({
        apiKey: config.googlePlacesApiKey,
        gymName: facts.name,
        city: facts.city,
        state: facts.state,
        fetchFn: deps?.fetchFn as never,
      });
      if (m) {
        await upsertConnection(db, site, "places", m.placeId, {});
        await recordMetric(db, site, "places", "rating", m.rating ?? "?", {});
        await recordMetric(db, site, "places", "review_count", m.reviewCount, {});
        if (m.recentReviewSnippet) {
          await recordMetric(db, site, "places", "recent_review", m.recentReviewSnippet, {});
        }
        await log(`places: ${m.rating ?? "?"}★ across ${m.reviewCount} reviews`);
        digest.push(`${m.rating ?? "?"}★ average across ${m.reviewCount} Google reviews` + (m.recentReviewSnippet ? ` — latest highlight: "${m.recentReviewSnippet.slice(0, 120)}…"` : ""));
      } else {
        await log("places: gym not found on Google Places (check the name/city facts)");
      }
    } catch (err) {
      await log(`places failed: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}`);
    }
  } else {
    await log("places skipped: no GOOGLE_PLACES_API_KEY or gym facts in seed payload");
  }

  // 2. Google APIs (GSC + GA4) — require service account AND production policy:
  //    registration only when the site publishes to production (future: + paying).
  const hasProductionDeploy = await db
    .selectFrom("deploys")
    .select(["id"])
    .where("siteId", "=", site.id)
    .where("env", "=", "production")
    .limit(1)
    .executeTakeFirst();
  const policyAllowsGoogle = Boolean(hasProductionDeploy) || config.analyticsOnStaging;
  void policyAllowsGoogle;

  let sa: ServiceAccount | null = null;
  if (config.googleServiceAccountJson) {
    try {
      sa = (deps?.loadSa ?? loadServiceAccount)(config.googleServiceAccountJson);
    } catch (err) {
      await log(`service account load failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  if (!sa) {
    await log("google APIs scaffold-mode: no GOOGLE_SERVICE_ACCOUNT_JSON — GSC/GA4 skipped this run");
  } else if (!policyAllowsGoogle) {
    await log("google APIs skipped: staging-only site carries no GSC/GA4 registration (gate: production publish + paying");
  } else {
    const siteUrl = stagingUrl(site);
    // GA4 ensure (works for any site URL).
    try {
      const accountName = await ga4EnsureAccount({
        sa,
        displayName: config.gaAccountDisplay,
        accountNameProvided: config.gaAccountName,
        fetchFn: deps?.fetchFn,
      });
      const propertyName = await ga4EnsureSharedProperty({
        sa,
        accountName,
        propertyDisplay: config.gaPropertyDisplay,
        fetchFn: deps?.fetchFn,
      });
      const stream = await ga4EnsureStream({
        sa,
        propertyName,
        slug: site.slug ?? site.companyId,
        siteUrl: siteUrl ?? site.sourceUrl ?? "https://unknown/",
        fetchFn: deps?.fetchFn,
      });
      await upsertConnection(db, site, "ga4", stream.measurementId, {
        account: accountName,
        property: propertyName,
        stream: stream.streamName,
      });
      await log(`ga4: stream ${stream.streamName} → measurement id ${stream.measurementId} (shared property ${propertyName})`);
      digest.push(`GA4 wired in the shared sites property (${stream.measurementId})`);
    } catch (err) {
      await log(`ga4 failed: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}`);
    }
    // GSC only when the site is actually staged (needs a served URL we control).
    if (siteUrl) {
      try {
        const prop = await gscEnsureProperty({ sa, schemeUrl: siteUrl, fetchFn: deps?.fetchFn });
        let verified = prop.verified;
        if (!verified && prop.metaTagToken) {
          // Meta rides the last deploy (deploy-time ensure + injection) — complete verification.
          const { gscVerifyNow } = await import("@milo/measurement");
          verified = await gscVerifyNow({ sa, schemeUrl: siteUrl, fetchFn: deps?.fetchFn });
          await log(`gsc verify: ${verified ? "VERIFIED ✓" : "not yet — redeploy to put the meta tag live"}`);
        }
        await upsertConnection(db, site, "gsc", prop.propertyUrl, { metaTagToken: prop.metaTagToken, verified });
        await log(`gsc: property ${prop.propertyUrl} (verified=${verified}${prop.metaTagToken ? ", meta token issued" : ""})`);
        if (verified) {
          const rows = await gscFetchQueries({ sa, schemeUrl: siteUrl, days: 28, fetchFn: deps?.fetchFn });
          const totalClicks = rows.reduce((n, r) => n + r.clicks, 0);
          const totalImpr = rows.reduce((n, r) => n + r.impressions, 0);
          await recordMetric(db, site, "gsc", "clicks_28d", totalClicks, {});
          await recordMetric(db, site, "gsc", "impressions_28d", totalImpr, {});
          for (const r of rows.slice(0, 15)) {
            await recordMetric(db, site, "gsc", "query", `${r.clicks}/${r.impressions}/${r.position}`, { query: r.query });
          }
          await log(`gsc: ${rows.length} queries, ${totalClicks} clicks, ${totalImpr} impressions (28d)`);
          if (rows.length > 0) {
            const top = [...rows].sort((a, b) => b.impressions - a.impressions)[0];
            digest.push(`search console: ${totalImpr} impressions/${totalClicks} clicks last 28d — biggest query "${top?.query}" (position ${top?.position})`);
          }
        }
      } catch (err) {
        await log(`gsc failed: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}`);
      }
    } else {
      await log("gsc skipped: site has no staging URL yet (deploy builds first)");
    }
  }

  const gbp = gbpStatus();
  await log(`gbp: ${gbp.reason}`);

  // New connections may have landed mid-run — re-inject into the built dist so the
  // next deploy carries analytics without a rebuild.
  const distDir = path.join(config.dataDir, "sites", site.id, "dist");
  const inj = await injectIntoDist({ db, site, distDir, config, env: "staging" });
  if (inj.injected > 0) await log(`analytics injected into ${inj.injected}/${inj.files} html file(s)`);

  if (digest.length === 0) {
    return "No measurement signals yet — connect the service account and deploy a staging URL; Places ratings need gym facts from the seed payload.";
  }
  return digest.join(". ") + ".";
}

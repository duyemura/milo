import { describe, expect, it } from "vitest";
import { decodeUnverifiedJwt, loadServiceAccount, accessToken } from "../src/googleAuth.ts";
import { ensureProperty as gscEnsureProperty } from "../src/gsc.ts";
import { ensureAccount as ga4EnsureAccount, ensureSharedProperty as ga4EnsureSharedProperty, ensureStream as ga4EnsureStream, injectGtag, injectMeta } from "../src/ga4.ts";
import { fetchPlaceMetrics } from "../src/places.ts";
import { injectTracker, trackerScript } from "../src/tracker.ts";
import { fetchGa4Rollup } from "../src/ga4data.ts";
import type { FetchLike } from "../src/http.ts";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  client_email: "sa@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
};

/** Scripted fetches must also cover the service-account token exchange. */
const withToken = (rest: FetchLike): FetchLike => async (url, init) => {
  if (url.includes("oauth2.googleapis.com/token")) {
    return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
  }
  return rest(url, init);
};

describe("googleAuth", () => {
  it("rejects a malformed SA file", () => {
    expect(() => loadServiceAccount("/tmp/nope-does-not-exist.json")).toThrow();
  });

  it("mints structurally-valid JWTs and caches tokens per scope", async () => {
    const fetches: string[] = [];
    const fetchFn = async (url: string) => {
      fetches.push(url);
      return { ok: true, status: 200, json: async () => ({ access_token: "tok-x", expires_in: 3600 }) };
    };
    const t1 = await accessToken(SA, "scope-a", fetchFn, 1_000_000);
    expect(t1).toBe("tok-x");
    // Second call within expiry → cached, no fetch
    const t2 = await accessToken(SA, "scope-a", fetchFn, 1_001_000);
    expect(t2).toBe("tok-x");
    expect(fetches).toHaveLength(1);
  });

  it("decodeUnverifiedJwt roundtrips claims", async () => {
    const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const jwt = [enc({ alg: "RS256" }), enc({ iss: SA.client_email, scope: "s" }), "sig"].join(".");
    const d = decodeUnverifiedJwt(jwt);
    expect(d.claims["iss"]).toBe(SA.client_email);
  });
});

describe("gsc.ensureProperty (with scripted fetch)", () => {
  it("registers the site and returns the meta token when unverified", async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchFn: FetchLike = withToken(async (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.toLowerCase().includes("siteverification/v1/token")) {
        return { ok: true, status: 200, json: async () => ({ token: "META-TAG-X" }) };
      }
      if (url.includes("webmasters/v3/sites") && init?.method === "PUT") {
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (url.includes("webmasters/v3/sites")) {
        return { ok: true, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const p = await gscEnsureProperty({ sa: SA, schemeUrl: "https://gym-staging.mygymseo.com/", fetchFn });
    expect(p.metaTagToken).toBe("META-TAG-X");
    expect(p.propertyUrl).toBe("https://gym-staging.mygymseo.com/");
    expect(p.verified).toBe(false);
    expect(calls.some((c) => c.url.toLowerCase().includes("siteverification/v1/token"))).toBe(true);
  });
});

describe("ga4 ensure + inject", () => {
  it("creates the account when absent, reuses it when present", async () => {
    const fetchFn: FetchLike = withToken(async (url, init) => {
      if (url.includes("/accounts?") && init?.method !== "POST") {
        return { ok: true, status: 200, json: async () => ({ accounts: [] }) };
      }
      if (url.endsWith("/accounts") && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ name: "accounts/123" }) };
      }
      throw new Error("unexpected " + url);
    });
    expect(await ga4EnsureAccount({ sa: SA, displayName: "PushPress sites", fetchFn })).toBe("accounts/123");
  });

  it("reuses the shared property and creates/reuses the site's stream", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = withToken(async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/properties?filter=") && init?.method !== "POST") {
        return { ok: true, status: 200, json: async () => ({ properties: [{ name: "properties/shared", displayName: "PushPress sites · staging" }] }) };
      }
      if (url.includes("/dataStreams") && init?.method !== "POST") {
        return { ok: true, status: 200, json: async () => ({ dataStreams: [] }) };
      }
      if (url.includes("/dataStreams") && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ name: "properties/shared/dataStreams/9", webStreamData: { measurementId: "G-SHARED1" } }) };
      }
      throw new Error("unexpected " + url);
    });
    const prop = await ga4EnsureSharedProperty({ sa: SA, accountName: "accounts/123", propertyDisplay: "PushPress sites · staging", fetchFn });
    expect(prop).toBe("properties/shared");
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/properties"))).toBe(false);
    const stream = await ga4EnsureStream({ sa: SA, propertyName: prop, slug: "gym-x", siteUrl: "https://x/", fetchFn });
    expect(stream.measurementId).toBe("G-SHARED1");
    expect(stream.streamName).toBe("properties/shared/dataStreams/9");
  });

  it("injectGtag is idempotent and head-anchored", () => {
    const html = "<html><head><title>x</title></head><body>y</body></html>";
    const once = injectGtag(html, "G-ABC123");
    expect(once.changed).toBe(true);
    expect(once.html).toContain("googletagmanager.com/gtag/js?id=G-ABC123");
    expect(once.html.indexOf("gtag/js?id=G-ABC123")).toBeGreaterThan(html.indexOf("<head"));
    const twice = injectGtag(once.html, "G-ABC123");
    expect(twice.changed).toBe(false);
  });

  it("injectMeta is idempotent", () => {
    const html = "<html><head></head><body>x</body></html>";
    const once = injectMeta(html, "google-site-verification", "tok");
    expect(once.changed).toBe(true);
    expect(injectMeta(once.html, "google-site-verification", "tok").changed).toBe(false);
  });
});

describe("places metrics", () => {
  it("returns rating/count and a strong review snippet", async () => {
    const fetchFn = async (url: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "pid1",
              rating: 4.8,
              userRatingCount: 123,
              reviews: [{ rating: 5, text: { text: "Best coaching I've ever had, period." } }],
            },
          ],
        }),
      };
    };
    const m = await fetchPlaceMetrics({ apiKey: "k", gymName: "Iron Anchor", city: "Denver", state: "CO", fetchFn });
    expect(m?.rating).toBe(4.8);
    expect(m?.reviewCount).toBe(123);
    expect(m?.recentReviewSnippet).toContain("coaching");
  });

  it("returns null when the gym isn't found", async () => {
    const m = await fetchPlaceMetrics({
      apiKey: "k",
      gymName: "Nowhere Gym",
      city: "X",
      state: "Y",
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ places: [] }) }),
    });
    expect(m).toBeNull();
  });
});

describe("tracker injection", () => {
  it("injectTracker is idempotent and anchors before </head>", () => {
    const html = "<html><head><title>x</title></head><body>y</body></html>";
    const once = injectTracker(html);
    expect(once.changed).toBe(true);
    expect(once.html).toContain(trackerScript().slice(0, 40));
    expect(once.html.indexOf("milo-track")).toBeGreaterThan(html.indexOf("<head"));
    expect(once.html.indexOf("</head>")).toBeGreaterThan(once.html.indexOf("milo-track"));
    const twice = injectTracker(once.html);
    expect(twice.changed).toBe(false);
  });

  it("leaves html unchanged when no </head> is present", () => {
    const html = "<html><body>no head</body></html>";
    const r = injectTracker(html);
    expect(r.changed).toBe(false);
    expect(r.html).toBe(html);
  });
});

describe("ga4 data rollup", () => {
  it("parses runReport responses into funnel + top pages/sources + active now", async () => {
    const baseFn: FetchLike = async (url, init) => {
      if (!init || init.method !== "POST") throw new Error("expected POST " + url);
      if (url.includes(":runReport")) {
        const body = init.body ? JSON.parse(init.body) : {};
        const dimensions = (body.dimensions ?? []).map((d: { name: string }) => d.name);
        if (!body.dateRanges) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              dimensionHeaders: [{ name: "streamName" }],
              metricHeaders: [{ name: "activeUsers" }],
              rows: [{ dimensionValues: [{ value: "properties/1/dataStreams/2" }], metricValues: [{ value: "2" }] }],
            }),
          };
        }
        if (dimensions.includes("eventName")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              dimensionHeaders: [{ name: "streamName" }, { name: "eventName" }],
              metricHeaders: [{ name: "eventCount" }],
              rows: [
                { dimensionValues: [{ value: "properties/1/dataStreams/2" }, { value: "engaged_15s" }], metricValues: [{ value: "5" }] },
                { dimensionValues: [{ value: "properties/1/dataStreams/2" }, { value: "intent_click" }], metricValues: [{ value: "3" }] },
                { dimensionValues: [{ value: "properties/1/dataStreams/2" }, { value: "form_submit" }], metricValues: [{ value: "1" }] },
              ],
            }),
          };
        }
        if (dimensions.includes("pagePath")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              dimensionHeaders: [{ name: "streamName" }, { name: "pagePath" }],
              metricHeaders: [{ name: "screenPageViews" }],
              rows: [{ dimensionValues: [{ value: "properties/1/dataStreams/2" }, { value: "/about" }], metricValues: [{ value: "12" }] }],
            }),
          };
        }
        if (dimensions.includes("sessionSource")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              dimensionHeaders: [{ name: "streamName" }, { name: "sessionSource" }],
              metricHeaders: [{ name: "totalUsers" }],
              rows: [{ dimensionValues: [{ value: "properties/1/dataStreams/2" }, { value: "Direct" }], metricValues: [{ value: "8" }] }],
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            dimensionHeaders: [{ name: "streamName" }],
            metricHeaders: [{ name: "totalUsers" }, { name: "screenPageViews" }, { name: "engagementRate" }, { name: "eventCount" }],
            rows: [
              {
                dimensionValues: [{ value: "properties/1/dataStreams/2" }],
                metricValues: [{ value: "10" }, { value: "25" }, { value: "0.636" }, { value: "40" }],
              },
            ],
          }),
        };
      }
      throw new Error("unexpected " + url + " " + JSON.stringify(init));
    };

    const rollup = await fetchGa4Rollup({ sa: SA, propertyName: "properties/1", streamName: "properties/1/dataStreams/2", fetchFn: withToken(baseFn) });
    expect(rollup).not.toBeNull();
    expect(rollup!.visitors).toBe(10);
    expect(rollup!.pageviews).toBe(25);
    expect(rollup!.engagementRate).toBe(0.636);
    expect(rollup!.activeNow).toBe(2);
    expect(rollup!.funnel).toEqual({ visited: 25, engaged: 5, intent: 3, converted: 1 });
    expect(rollup!.topPages).toEqual([{ path: "/about", views: 12 }]);
    expect(rollup!.topSources).toEqual([{ source: "Direct", users: 8 }]);
  });
});

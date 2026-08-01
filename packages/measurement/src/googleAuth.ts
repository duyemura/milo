import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function loadServiceAccount(path: string): ServiceAccount {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  if (!raw["client_email"] || !raw["private_key"]) {
    throw new Error(`Service account at ${path} is missing client_email/private_key`);
  }
  return { client_email: raw["client_email"], private_key: raw["private_key"], token_uri: raw["token_uri"] };
}

export type TokenFetchFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch: TokenFetchFn = (url, init) => fetch(url, init);

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// NOTE: `"x".toString("base64")` is a silent no-op on strings (it ignores the arg,
// returns the string) — encode via Buffer, and via the native base64url codec.
const b64url = (s: string | Buffer) => Buffer.from(typeof s === "string" ? s : s).toString("base64url");

function mintJwt(sa: ServiceAccount, scope: string, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${claims}`);
  const sig = sign.sign(sa.private_key);
  return `${header}.${claims}.${b64url(sig)}`;
}

/**
 * Service-account OAuth grant. Cached per scope until ~5 min before expiry.
 * Injected TokenFetchFn in tests.
 */
export async function accessToken(
  sa: ServiceAccount,
  scope: string,
  fetchFn: TokenFetchFn = defaultFetch,
  nowMs: number = Date.now(),
): Promise<string> {
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt > nowMs + 60_000) return cached.token;

  const jwt = mintJwt(sa, scope, Math.floor(nowMs / 1000));
  const res = await fetchFn(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Token exchange failed (${res.status}): ${data.error ?? "unknown"} — ${data.error_description ?? "check the service account + enabled APIs"}`,
    );
  }
  const expiresAt = nowMs + (data.expires_in ?? 3600) * 1000 - 300_000;
  tokenCache.set(scope, { token: data.access_token, expiresAt });
  return data.access_token;
}

/** Integrity helper for tests: verify a minted JWT decodes to the expected claims. */
export function decodeUnverifiedJwt(jwt: string): { header: unknown; claims: Record<string, unknown> } {
  const [h, c] = jwt.split(".");
  const dec = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  return { header: dec(h), claims: dec(c) };
}

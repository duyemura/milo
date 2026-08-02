import { WorkOS } from "@workos-inc/node";
import type { FastifyReply } from "fastify";
import type { AdminConfig } from "../config.ts";
import { SESSION_COOKIE, cookieFlags } from "./plugin.ts";

/**
 * Result of validating a session cookie. `clearCookie` tells the caller whether the cookie
 * is genuinely dead (bad/absent → clear it) or merely lost a refresh race (leave it: the
 * browser likely already holds a freshly-rotated cookie from the winning request).
 */
export type AuthOutcome =
  | { ok: true; email: string }
  | { ok: false; clearCookie: boolean };

export interface WorkosAuth {
  loginUrl(): string;
  exchangeCode(code: string): Promise<{ ok: true; sealedSession: string } | { ok: false; error: string }>;
  authenticateCookie(sealed: string, reply: FastifyReply): Promise<AuthOutcome>;
  logoutUrl(sealed: string): Promise<string | null>;
}

/**
 * Single integration point with the WorkOS Node SDK (AuthKit hosted login +
 * sealed cookie sessions). If SDK API names drift, adjust ONLY here.
 */
export function createWorkosAuth(config: AdminConfig): WorkosAuth {
  const clientId = config.workosClientId as string;
  const cookiePassword = config.workosCookiePassword as string;
  const workos = new WorkOS(config.workosApiKey, { clientId });

  const domainOk = (email: string) =>
    email.toLowerCase().endsWith(`@${config.allowedEmailDomain.toLowerCase()}`);

  // Single-flight refresh, keyed by the sealed cookie value. WorkOS rotates the refresh
  // token on every use, so when the SPA fans out N requests at access-token expiry, N
  // parallel refresh() calls would leave N-1 failing on an already-consumed token — and
  // those failures would race the winner's Set-Cookie. Sharing one refresh() per cookie
  // means every concurrent request resolves to the SAME rotated session.
  type RefreshResult = { ok: true; email: string; sealed: string } | { ok: false; reason: string };
  const refreshInFlight = new Map<string, Promise<RefreshResult>>();
  const refreshOnce = (sealed: string): Promise<RefreshResult> => {
    let p = refreshInFlight.get(sealed);
    if (!p) {
      p = (async (): Promise<RefreshResult> => {
        const session = workos.userManagement.loadSealedSession({ sessionData: sealed, cookiePassword });
        const r = await session.refresh({ cookiePassword });
        if (!r.authenticated) return { ok: false, reason: r.reason };
        return { ok: true, email: r.user?.email ?? "", sealed: r.sealedSession ?? sealed };
      })().finally(() => refreshInFlight.delete(sealed));
      refreshInFlight.set(sealed, p);
    }
    return p;
  };

  return {
    loginUrl() {
      // Google is the ONLY accepted provider (Dan, 2026-08-01): the authorize URL
      // skips the AuthKit page and goes straight to Google. Email/password users
      // simply cannot get a code, and @pushpress.com is enforced again at callback.
      return workos.userManagement.getAuthorizationUrl({
        provider: "GoogleOAuth",
        clientId,
        redirectUri: config.workosRedirectUri,
      });
    },

    async exchangeCode(code) {
      const result = await workos.userManagement.authenticateWithCode({
        clientId,
        code,
        session: { sealSession: true, cookiePassword },
      });
      const email = result.user?.email ?? "";
      if (!domainOk(email)) {
        return { ok: false, error: `Sign in with your @${config.allowedEmailDomain} account.` };
      }
      if (!("sealedSession" in result) || typeof result.sealedSession !== "string") {
        return { ok: false, error: "Sign-in failed (no session issued). Try again." };
      }
      return { ok: true, sealedSession: result.sealedSession };
    },

    async authenticateCookie(sealed, reply): Promise<AuthOutcome> {
      try {
        const session = workos.userManagement.loadSealedSession({ sessionData: sealed, cookiePassword });
        const auth = await session.authenticate();
        if (auth.authenticated) {
          return domainOk(auth.user.email) ? { ok: true, email: auth.user.email } : { ok: false, clearCookie: true };
        }
        // A live session whose ACCESS token has simply expired (the ~5-minute default)
        // reports `invalid_jwt`. The refresh token sealed in the cookie is still valid, so
        // mint a fresh access token and roll the cookie forward. Without this refresh step
        // every access-token expiry bounced the user back to login every few minutes. A
        // structurally bad or absent cookie is unrecoverable → clear it and re-login.
        if (auth.reason !== "invalid_jwt") {
          console.warn(`[admin] workos session rejected: reason=${auth.reason}`);
          return { ok: false, clearCookie: true };
        }
        const refreshed = await refreshOnce(sealed);
        if (!refreshed.ok) {
          // Refresh failed: session genuinely over, a transient blip, OR this request lost
          // the rotation race (another request already refreshed with this token). Don't
          // clear the cookie — the browser may already hold the winner's fresh cookie, and
          // clearing would wipe it and bounce the user. A truly-dead session just redirects
          // to login, which writes a clean cookie anyway.
          console.warn(`[admin] workos refresh failed: reason=${refreshed.reason}`);
          return { ok: false, clearCookie: false };
        }
        reply.setCookie(SESSION_COOKIE, refreshed.sealed, cookieFlags(config));
        return domainOk(refreshed.email) ? { ok: true, email: refreshed.email } : { ok: false, clearCookie: true };
      } catch {
        return { ok: false, clearCookie: false };
      }
    },

    async logoutUrl(sealed) {
      try {
        const session = workos.userManagement.loadSealedSession({ sessionData: sealed, cookiePassword });
        return await session.getLogoutUrl();
      } catch {
        return null;
      }
    },
  };
}

import { WorkOS } from "@workos-inc/node";
import type { FastifyReply } from "fastify";
import type { AdminConfig } from "../config.ts";
import { SESSION_COOKIE, cookieFlags } from "./plugin.ts";

export interface WorkosAuth {
  loginUrl(): string;
  exchangeCode(code: string): Promise<{ ok: true; sealedSession: string } | { ok: false; error: string }>;
  authenticateCookie(sealed: string, reply: FastifyReply): Promise<string | null>;
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

    async authenticateCookie(sealed, reply) {
      try {
        const session = workos.userManagement.loadSealedSession({ sessionData: sealed, cookiePassword });
        const auth = await session.authenticate();
        if (auth.authenticated) {
          return domainOk(auth.user.email) ? auth.user.email : null;
        }
        // A live session whose ACCESS token has simply expired (the ~5-minute default)
        // reports `invalid_jwt`. The refresh token sealed in the cookie is still valid, so
        // mint a fresh access token and roll the cookie forward. Without this refresh step
        // every access-token expiry bounced the user back to login every few minutes.
        // no_session_cookie_provided / invalid_session_cookie are unrecoverable → re-login.
        if (auth.reason !== "invalid_jwt") {
          console.warn(`[admin] workos session rejected: reason=${auth.reason}`);
          return null;
        }
        const refreshed = await session.refresh({ cookiePassword });
        if (!refreshed.authenticated) {
          // Terminal (session over) or retryable (transient 5xx/429/timeout) — either way we
          // can't authorize this request; the plugin sends the user to login. The reason is
          // logged so a genuinely-over session is distinguishable from a transient blip.
          console.warn(`[admin] workos refresh failed: reason=${refreshed.reason} retryable=${"retryable" in refreshed ? refreshed.retryable : "?"}`);
          return null;
        }
        if (refreshed.sealedSession) {
          reply.setCookie(SESSION_COOKIE, refreshed.sealedSession, cookieFlags(config));
        }
        const email = refreshed.user?.email ?? "";
        return domainOk(email) ? email : null;
      } catch {
        return null;
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

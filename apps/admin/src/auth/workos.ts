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
        const result = await workos.userManagement.authenticateWithSessionCookie({
          sessionData: sealed,
          cookiePassword,
        });
        if (!result.authenticated) return null;
        const email = result.user?.email ?? "";
        if (!domainOk(email)) return null;
        // Refresh token rotation: roll the sealed cookie forward when the SDK hands us a new one.
        if ("sealedSession" in result && typeof result.sealedSession === "string" && result.sealedSession !== sealed) {
          reply.setCookie(SESSION_COOKIE, result.sealedSession, cookieFlags(config));
        }
        return email;
      } catch {
        return null;
      }
    },

    async logoutUrl(sealed) {
      try {
        return await workos.userManagement.getLogoutUrlFromSessionCookie({
          sessionData: sealed,
          cookiePassword,
        });
      } catch {
        return null;
      }
    },
  };
}

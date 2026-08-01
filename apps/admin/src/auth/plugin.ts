import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AdminConfig } from "../config.ts";
import { createWorkosAuth, type WorkosAuth } from "./workos.ts";

export interface Actor {
  type: "team";
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
}

export const SESSION_COOKIE = "wos-session";
const PUBLIC_PATHS = ["/healthz", "/auth/login", "/auth/callback", "/auth/config", "/auth/logout"];

/** Cookie flags: secure only when the app is being served over https (prod). */
export function cookieFlags(config: AdminConfig): { httpOnly: true; sameSite: "lax"; path: "/"; secure: boolean } {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.workosRedirectUri.startsWith("https:"),
  };
}

/**
 * Two principals only (no RBAC — see spec), one boundary:
 *   dev   → all-pass team actor (local zero-setup)
 *   workos→ AuthKit hosted login; sealed session cookie; email must match
 *           config.allowedEmailDomain server-side
 */
export function registerAuth(app: FastifyInstance, config: AdminConfig): void {
  app.decorateRequest("actor", null as unknown as Actor);

  let workos: WorkosAuth | null = null;
  if (config.authMode === "workos") {
    if (!config.workosApiKey || !config.workosClientId || !config.workosCookiePassword) {
      throw new Error(
        "AUTH_MODE=workos requires WORKOS_API_KEY, WORKOS_CLIENT_ID, and WORKOS_COOKIE_PASSWORD.",
      );
    }
    workos = createWorkosAuth(config);
  }

  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    if (PUBLIC_PATHS.some((p) => req.url.startsWith(p))) return;

    if (config.authMode === "dev") {
      req.actor = { type: "team", email: "dev@pushpress.com" };
      return;
    }

    const session = req.cookies?.[SESSION_COOKIE];
    const user = session && workos ? await workos.authenticateCookie(session, reply) : null;
    if (!user) {
      if (req.url.startsWith("/api/")) {
        return reply.code(401).send({ error: "Sign in with your PushPress account." });
      }
      return reply.redirect("/auth/login");
    }
    req.actor = { type: "team", email: user };
  });

  app.get("/auth/config", async () => ({
    mode: config.authMode,
    allowedEmailDomain: config.allowedEmailDomain,
  }));

  app.get("/auth/login", async (_req, reply) => {
    if (!workos) return reply.redirect("/");
    return reply.redirect(workos.loginUrl());
  });

  app.get("/auth/callback", async (req, reply) => {
    if (!workos) return reply.redirect("/");
    const { code } = (req.query ?? {}) as { code?: string };
    if (!code) return reply.redirect("/auth/login");
    const result = await workos.exchangeCode(code);
    if (!result.ok) {
      return reply.code(403).send({ error: result.error });
    }
    reply.setCookie(SESSION_COOKIE, result.sealedSession, cookieFlags(config));
    return reply.redirect("/");
  });

  app.get("/auth/logout", async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    if (workos) {
      const session = req.cookies?.[SESSION_COOKIE];
      const logoutUrl = session ? await workos.logoutUrl(session) : null;
      if (logoutUrl) return reply.redirect(logoutUrl);
    }
    return reply.redirect("/");
  });
}

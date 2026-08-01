import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AdminConfig } from "../config.ts";

export interface Actor {
  type: "team";
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
}

/**
 * Two principals only (no RBAC — see spec). v1 ships `dev` mode (team, all-pass);
 * `google` mode verifies an OIDC id_token via google-auth-library, restricted to hd=pushpress.com.
 */
export function registerAuth(app: FastifyInstance, config: AdminConfig): void {
  app.decorateRequest("actor", null as unknown as Actor);

  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    if (req.url === "/healthz" || req.url.startsWith("/auth/")) return;

    if (config.authMode === "dev") {
      req.actor = { type: "team", email: "dev@pushpress.com" };
      return;
    }

    const token = req.cookies?.["admin_session"];
    if (!token) {
      return reply.code(401).send({ error: "Sign in with your PushPress Google account." });
    }
    try {
      const payload = await app.jwt.verify<{ email: string }>(token);
      req.actor = { type: "team", email: payload.email };
    } catch {
      return reply.code(401).send({ error: "Your session expired. Sign in again." });
    }
  });

  app.post("/auth/google", async (req, reply) => {
    if (config.authMode !== "google" || !config.googleClientId) {
      return reply.code(400).send({ error: "Google sign-in is not enabled in this environment." });
    }
    const { idToken } = (req.body ?? {}) as { idToken?: string };
    if (!idToken) {
      return reply.code(400).send({ error: "Request body must include idToken." });
    }
    const { OAuth2Client } = await import("google-auth-library");
    const client = new OAuth2Client(config.googleClientId);
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: config.googleClientId });
      payload = ticket.getPayload();
    } catch {
      return reply.code(401).send({ error: "Google sign-in failed. Try again." });
    }
    if (!payload?.email?.endsWith("@pushpress.com")) {
      return reply.code(403).send({ error: "Sign in with your @pushpress.com account." });
    }
    const session = await reply.jwtSign({ email: payload.email }, { expiresIn: "12h" });
    reply.setCookie("admin_session", session, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    return { email: payload.email };
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie("admin_session", { path: "/" });
    return { ok: true };
  });
}

import { describe, expect, it } from "vitest";
import { testApp } from "./helpers.ts";

describe("health", () => {
  it("GET /healthz returns ok", async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});

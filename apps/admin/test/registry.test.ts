import { describe, expect, it } from "vitest";
import { testApp, seedRegistry } from "./helpers.ts";

describe("registry routes", () => {
  it("creates, lists, and gets workspaces", async () => {
    const { app, db } = await testApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      payload: { name: "Globo Gym Inc", contact: "peter@globo.example" },
    });
    expect(create.statusCode).toBe(201);
    const { workspace } = create.json() as { workspace: { id: string; name: string } };
    expect(workspace.name).toBe("Globo Gym Inc");

    const list = await app.inject({ method: "GET", url: "/api/v1/workspaces" });
    expect((list.json() as { workspaces: unknown[] }).workspaces).toHaveLength(1);

    await seedRegistry(db);
    const detail = await app.inject({ method: "GET", url: "/api/v1/workspaces/ws1" });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { companies: unknown[] }).companies).toHaveLength(1);

    const missing = await app.inject({ method: "GET", url: "/api/v1/workspaces/nope" });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: string }).error).toBe("Workspace not found.");

    await app.close();
  });

  it("rejects an invalid workspace body with a 400", async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: "POST", url: "/api/v1/workspaces", payload: {} });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/^name: /);
    await app.close();
  });

  it("creates companies only under existing workspaces; detail lists sites", async () => {
    const { app, db } = await testApp();
    await seedRegistry(db);

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      payload: { workspaceId: "missing", companyId: "pp-x", name: "X" },
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      payload: { workspaceId: "ws1", companyId: "pp-co-2", name: "CrossFit Bravo" },
    });
    expect(good.statusCode).toBe(201);

    const detail = await app.inject({ method: "GET", url: "/api/v1/companies/nope" });
    expect(detail.statusCode).toBe(404);

    await app.close();
  });
});

import { describe, expect, it } from "vitest";
import { testDb, seedRegistry } from "./helpers.ts";

describe("db", () => {
  it("migrates fresh and roundtrips a workspace → company → site chain", async () => {
    const db = await testDb();
    const { workspaceId, companyRowId } = await seedRegistry(db);

    const ws = await db.selectFrom("workspaces").selectAll().where("id", "=", workspaceId).executeTakeFirstOrThrow();
    expect(ws.name).toBe("Acme Fitness Group");

    await db
      .insertInto("sites")
      .values({
        id: "s1",
        workspaceId,
        companyId: companyRowId,
        seedType: "template",
        sourceUrl: "https://gym.example.com",
        slug: null,
        status: "registered",
        active: 1,
        createdAt: new Date().toISOString(),
      })
      .execute();
    const site = await db.selectFrom("sites").selectAll().where("companyId", "=", companyRowId).executeTakeFirstOrThrow();
    expect(site.seedType).toBe("template");
    expect(site.active).toBe(1);
  });
});

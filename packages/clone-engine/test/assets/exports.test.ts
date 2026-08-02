import { describe, it, expect } from "vitest";
import * as assets from "../../src/assets/index.ts";
import * as edit from "../../src/edit/index.ts";

describe("assets public surface", () => {
  it("exports library CRUD", () => {
    for (const name of ["emptyLibrary", "loadLibrary", "saveLibrary", "addAsset", "getAsset", "updateAssetTags", "archiveAsset", "recordUsage"]) {
      expect(typeof (assets as Record<string, unknown>)[name]).toBe("function");
    }
  });
  it("exports ingest + tag", () => {
    expect(typeof assets.ingestAsset).toBe("function");
    expect(typeof assets.tagAsset).toBe("function");
  });
  it("exports findAsset", () => {
    expect(typeof assets.findAsset).toBe("function");
  });
  it("exports migrateExistingAssets", () => {
    expect(typeof assets.migrateExistingAssets).toBe("function");
  });
});

describe("edit public surface", () => {
  it("exports placeAsset + uploadAsset", () => {
    expect(typeof edit.placeAsset).toBe("function");
    expect(typeof edit.uploadAsset).toBe("function");
  });
});

import { test, expect } from "vitest";
import { loadDocuments } from "../src/lib/load.ts";

test("loadDocuments validates and returns GymDocuments from a JSON file", () => {
  const docs = loadDocuments(new URL("../../../packages/schema/fixtures/iron-anchor.json", import.meta.url).pathname);
  expect(docs.identity.name.length).toBeGreaterThan(0);
  expect(docs.hierarchy.pages.length).toBeGreaterThan(0);
});

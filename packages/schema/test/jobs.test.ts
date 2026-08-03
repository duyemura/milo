import { describe, it, expect } from "vitest";
import { CloneJob, LearnJob } from "../src/jobs.ts";

describe("job schemas", () => {
  it("CloneJob defaults deploy to false", () => {
    expect(CloneJob.parse({ type: "clone", url: "https://example.com" }).deploy).toBe(false);
  });

  it("CloneJob accepts deploy: true", () => {
    expect(CloneJob.parse({ type: "clone", url: "https://example.com", deploy: true }).deploy).toBe(true);
  });

  it("LearnJob defaults verbose to false", () => {
    expect(LearnJob.parse({ type: "learn", url: "https://example.com" }).verbose).toBe(false);
  });
});

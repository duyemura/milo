import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GymSiteContent } from "@milo/schema";

/**
 * Loads and validates the gym.json this build renders. Invalid content fails
 * the build loudly — deterministic pre-publish QA starts at the contract.
 */
export function loadContent(): GymSiteContent {
  const source = process.env.GYM_JSON;
  if (!source) {
    throw new Error("GYM_JSON env var is required (path to a GymSiteContent json file)");
  }
  const path = resolve(process.cwd(), source);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const parsed = GymSiteContent.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid GymSiteContent at ${path}:\n${parsed.error.message}`);
  }
  return parsed.data;
}

export function activeTemplate(): string {
  return process.env.TEMPLATE ?? "modern";
}

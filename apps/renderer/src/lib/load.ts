import { readFileSync } from "node:fs";
import { GymDocuments } from "@milo/schema";

export function loadDocuments(path: string): GymDocuments {
  return GymDocuments.parse(JSON.parse(readFileSync(path, "utf8")));
}

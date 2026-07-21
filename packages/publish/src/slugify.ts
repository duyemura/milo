import { randomBytes } from "node:crypto";

export function toKebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateSuffix(): string {
  return randomBytes(2).toString("hex");
}

export function buildSlug(gymName: string, suffix: string): string {
  return `${toKebab(gymName)}-${suffix}`;
}

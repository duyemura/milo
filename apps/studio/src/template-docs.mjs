#!/usr/bin/env node
/**
 * Documentation engine — generated half.
 *
 * Reads every templates/<name>/template.json (validated against the
 * TemplateManifest schema) and emits templates/<name>/docs/components.md.
 * Deterministic: same manifest → same docs. Fails loudly if a manifest is
 * invalid or missing coverage, so docs cannot drift from the vocabulary.
 *
 * Usage: node src/template-docs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TemplateManifest } from "../../../packages/schema/src/index.ts";

const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../templates");
const names = fs.readdirSync(templatesDir).filter((d) => fs.existsSync(path.join(templatesDir, d, "template.json")));

for (const name of names) {
  const raw = JSON.parse(fs.readFileSync(path.join(templatesDir, name, "template.json"), "utf8"));
  const manifest = TemplateManifest.parse(raw);

  const lines = [];
  lines.push(`# ${manifest.name} — component reference`);
  lines.push("");
  lines.push("> Generated from `template.json` by `apps/studio/src/template-docs.mjs`. Do not edit by hand — edit the manifest and regenerate.");
  lines.push("");
  lines.push(manifest.description);
  lines.push("");
  lines.push("## Design tokens");
  lines.push("");
  lines.push("| Token | Value |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(manifest.tokens)) lines.push(`| \`${k}\` | \`${v}\` |`);
  lines.push("");
  lines.push("## Components");
  lines.push("");
  for (const [type, doc] of Object.entries(manifest.components)) {
    lines.push(`### \`${type}\``);
    lines.push("");
    lines.push(doc.description);
    lines.push("");
    if (doc.variants) {
      lines.push("Variants:");
      lines.push("");
      for (const [v, desc] of Object.entries(doc.variants)) lines.push(`- \`${v}\` — ${desc}`);
      lines.push("");
    }
    lines.push(`**Usage:** ${doc.usage}`);
    lines.push("");
  }
  lines.push("## Page archetype recipes");
  lines.push("");
  lines.push("Section order a site build should use when composing each page archetype with this template (`type#variant` marks a variant hint):");
  lines.push("");
  for (const [arch, recipe] of Object.entries(manifest.archetypes)) {
    lines.push(`- **${arch}**: ${recipe.sections.map((s) => `\`${s}\``).join(" → ")}${recipe.notes ? ` — ${recipe.notes}` : ""}`);
  }
  lines.push("");

  const outDir = path.join(templatesDir, name, "docs");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "components.md"), lines.join("\n"));
  console.log(`✓ ${name}: docs/components.md (${Object.keys(manifest.components).length} components, ${Object.keys(manifest.archetypes).length} archetypes)`);
}

# Milo Unified CLI + Pipeline Design

**Date:** 2026-08-03  
**Status:** Draft — awaiting approval  
**Scope:** CLI command surface, intake refactor, docs structure, job schema contract, admin unification

---

## Problem

Two disconnected pipelines exist today with no shared contract:

- Clone pipeline: `packages/clone-engine/src/cli.ts build-auto` — admin spawns this directly as a subprocess
- Template pipeline: `apps/cli/src/milo.ts intake → generate → build` — separate CLI, separate Astro version
- Admin bypasses `milo` entirely for clone jobs
- Intake bundles content generation (`generateSite`) with intelligence gathering — making it slow and template-specific
- No shared job schema — CLI flags and admin payloads have drifted and can drift further

---

## Core Constraint: Job Schema Is the Single Source of Truth

**The CLI and web UI are both thin wrappers over the same typed job schema. The runner is the single implementation.**

```
┌─────────────────────────────────────────┐
│           Job Schema (Zod, @milo/schema) │
│   intake | clone | deploy | status      │
└──────────────────┬──────────────────────┘
                   │ same schema, same runner
          ┌────────┴─────────┐
          │                  │
     milo CLI           Admin web UI
  (args → job)       (form → job)
```

- Adding a flag to `milo clone` means adding it to the job schema first. The web UI gets it for free.
- Adding a web UI option means it goes through the schema. The CLI gets it for free.
- The CLI is the integration test for the admin — if `milo clone <url>` works, the admin's code path works.
- Neither surface can pass something the other doesn't understand.

---

## Command Set

```
milo learn <url>                    # research — produces docs/ only, no HTML
milo clone <url>                    # build a site from a URL
  [--template <id>]                 # use a template instead of DOM clone
  [--refresh-docs]                  # re-run learn before building (force fresh docs)
  [--docs <path>]                   # override docs location (default: auto-detect)
  [--out <path>]                    # output dir override
milo deploy <slug>                  # push built site to staging
  [--production]                    # promote staging → production
milo status <slug>                  # show current staging/production state
```

### milo learn `<url>`

Runs the research pipeline. Produces intelligence documents about the client. **Does not produce HTML.** Does not call `generateSite`. Runs in ~2–3 min.

Output goes to `gyms/<slug>/docs/` via the storage seam by default — local disk under `~/.milo` in dev, S3 in production, MinIO for local S3 testing.

### milo clone `<url>`

Builds a deployable site from a URL. Default strategy is DOM clone (pixel-faithful). With `--template <id>`, uses the client's content and brand as source material to fill a pre-made template.

Both strategies:
1. If `--refresh-docs`: run `learn` first, blocking, before proceeding
2. Check for docs at `~/.milo/docs/<domain-slug>/` (or `--docs` override)
3. Log clearly if docs are absent: `No docs found for this site. Run \`milo learn <url>\` for better output. Continuing without…`
4. Run the build (clone or template)
5. Write output to `--out` (default: `~/.milo/builds/<domain-slug>/`)

### milo deploy `<slug>`

Pushes a built site to staging via `@milo/publish`. `--production` promotes the current staging version. Same code path as today.

### milo status `<slug>`

Shows the current staging and production versions for a slug. Reads from S3 `current.json`.

---

## Learn (Intake Refactor)

`milo learn` replaces `milo intake`. The underlying function (`runIntake` → `runLearn`) is renamed and narrowed: it stops at producing intelligence documents.

**Before:**
```
runIntake → crawl → classify → context analysis → generateSite → gym.json
```

**After:**
```
runLearn → crawl → classify → context analysis → docs/
```

`gym.json` generation moves to `milo clone --template <id>` as a pre-build step, reading the docs/ output.

### What intake produces

| File | Format | Contents |
|---|---|---|
| `context.md` | Markdown | Business narrative — what they do, who they serve, voice/tone |
| `business.md` | Markdown | Facts summary — LLM system-prompt-ready |
| `brand.json` | JSON | Colors, fonts, logo path, social links |
| `pages.json` | JSON | Page inventory, URLs, archetypes, crawl metadata |
| `assets/` | Files | Downloaded photos (GMB + page images) |

Markdown for narrative content (LLMs read it directly in prompts, no transformation needed). JSON for structured data the build process reads programmatically.

### What intake does NOT produce

- `gym.json` — moved to clone --template pre-build
- `context.json` / `business.json` — replaced by `.md` equivalents
- Any HTML

---

## Docs Storage Structure

### Location convention

```
Local (CLI default):   ~/.milo/gyms/<slug>/docs/
S3 (production):       gyms/<slug>/docs/
MinIO (local dev):     gyms/<slug>/docs/  (same paths, different endpoint)
```

Keys are identical locally and in S3 (`gyms/<slug>/docs/...`) — one code path. Local root defaults to `~/.milo`, overridable via `MILO_STORAGE_DIR`. (Revised 2026-08-03 from `~/.milo/docs/<slug>/` — see `2026-08-03-docs-storage-plumbing-design.md`.)

Domain slug is derived from the URL: `speakeasyofstrength.com` → `speakeasyofstrength-com`. This is auto-derived from the URL so `milo learn <url>` and `milo clone <url>` resolve to the same docs without any operator configuration.

### S3 structure (per client)

```
gyms/<slug>/
  current.json              ← KVS pointer (existing)
  versions/<versionId>/     ← built site files (existing)
  docs/                     ← new
    context.md
    business.md
    brand.json
    pages.json
    assets/
      gmb-photo-1.jpg
      ...
```

### Storage adapter

The existing `StorageAdapter` seam (`packages/clone-engine/src/storage/`) handles both. Local FS in dev/CLI, S3 in production. No new infrastructure needed.

---

## Clone + Docs Connection

When docs are present, the clone pipeline uses them to improve output. When absent, the pipeline runs exactly as today (no regression).

| Doc | How clone uses it |
|---|---|
| `pages.json` | Seed page discovery — know which routes exist before crawling |
| `context.md` + `business.md` | Feed to the section labeler for more accurate roles |
| `brand.json` | Cross-check extracted colors/fonts against known-good brand |
| `assets/` | Available as alternatives to scraped assets (higher quality GMB photos) |

This connection is Phase 2 — the CLI and storage structure are Phase 1. Phase 1 ships the plumbing; Phase 2 wires docs into the build for better output.

---

## Job Schema

Defined in `@milo/schema` as Zod types. Both the CLI (arg parsing) and the admin (form submission → job payload) validate against this schema.

```typescript
// Learn job
const LearnJob = z.object({
  type: z.literal("learn"),
  url: z.string().url(),
});

// Clone job
const CloneJob = z.object({
  type: z.literal("clone"),
  url: z.string().url(),
  templateId: z.string().optional(),      // absent = DOM clone, present = template clone
  refreshDocs: z.boolean().default(false),// re-run learn before building
  docsSlug: z.string().optional(),        // override auto-derived domain slug
  includeUgc: z.boolean().default(false),
  ugcLimit: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
});

// Deploy job
const DeployJob = z.object({
  type: z.literal("deploy"),
  slug: z.string(),
  env: z.enum(["staging", "production"]),
  versionId: z.string().optional(),       // for rollback
});

export const MiloJob = z.discriminatedUnion("type", [LearnJob, CloneJob, DeployJob]);
export type MiloJob = z.infer<typeof MiloJob>;
```

---

## Admin Unification

The admin runner currently spawns `packages/clone-engine/src/cli.ts` as a subprocess for clone jobs and calls `apps/cli/src/milo.ts` as a subprocess for template jobs. Both become direct function calls.

**Before:**
```typescript
// admin calls engine CLI as subprocess
await spawnLines({ cmd: "node", args: [cloneCli, "build-auto", "--site", url, ...] })
```

**After:**
```typescript
// admin imports and calls engine functions directly
import { buildSiteAuto } from "@milo/clone-engine";
await buildSiteAuto(url, { cwd, mode, onEvent, ... });
```

The admin job payload is validated against `MiloJob` from `@milo/schema`. The runner dispatches on `job.type`. No subprocess, no CLI flag serialization.

---

## What Stays the Same

- `@milo/publish` for S3/CloudFront staging and production deploy — unchanged
- `StorageAdapter` seam for capture cache — unchanged
- Clone engine internals (`capture`, `project`, `orchestrate`) — unchanged
- Admin job queue and database — unchanged
- S3 bucket structure (`gyms/<slug>/versions/<versionId>/`) — unchanged

---

## What Is Deferred

- **Template path v2** — rebuild on clone substrate (`milo clone --template` today calls the old renderer; the v2 design is a future spec)
- **Docs → clone Phase 2** — wiring docs into labels, discovery, brand verification
- **`milo status`** — useful but not blocking
- **Multi-operator docs access** — docs in S3 are accessible to all; per-operator access controls are a future concern

---

## Migration Path

1. Add `MiloJob` schema to `@milo/schema`
2. Rename `runIntake` → `runLearn`, extract `generateSite`, emit docs/ in new format
3. Rename `milo intake` → `milo learn` in `apps/cli/src/milo.ts`; add `milo clone` command
4. Update admin runner to call engine functions directly instead of spawning subprocess
5. Update admin job payloads to use `MiloJob` schema
6. (Phase 2) Wire docs into clone pipeline for better output

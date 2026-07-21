# Milo Publish — Design Spec

**Date:** 2026-07-21  
**Status:** Approved  
**Scope:** `packages/publish` + `apps/cli` publish command

---

## Overview

`milo publish` deploys a built Milo site to S3 and routes it via CloudFront KVS. Each gym gets a human-readable slug with a 4-char hex suffix to prevent collisions. Deploys are immutable versioned snapshots; staging and production are independent CDN-routed pointers into that version history.

---

## Gym slug

Format: `{kebab-gym-name}-{4-char-hex}` — e.g. `iron-anchor-4s1a`

- Generated once at first publish from the gym's `Identity.name`
- Stored in a `publish.json` sidecar alongside `gym.json`
- Never regenerated after creation

`publish.json` (operator-owned, not committed to gym content):
```json
{
  "slug": "iron-anchor-4s1a",
  "bucket": "pushpress-marketing-dev",
  "kvsArn": "arn:aws:cloudfront::...",
  "siteDomain": "sites.pushpress.com"
}
```

---

## S3 layout

```
gyms/iron-anchor-4s1a/
  current.json                         ← staging/production pointers + history
  versions/
    2026-07-21T11-00-00Z/              ← immutable version (ISO timestamp, colon-safe)
      _complete                        ← written last; marks upload as fully committed
      index.html
      _astro/
        ...
    2026-07-20T09-00-00Z/
      ...
```

### `current.json` schema

```json
{
  "staging":    "2026-07-21T11-00-00Z",
  "production": "2026-07-20T09-00-00Z",
  "history": [
    "2026-07-21T11-00-00Z",
    "2026-07-20T09-00-00Z",
    "2026-07-19T14-00-00Z"
  ]
}
```

- `history` is ordered newest-first
- `staging` and `production` may point to the same version (normal after a promote)
- Versions referenced by `staging` or `production` are never pruned, even if they fall outside the retention window

---

## CloudFront KVS routing

Two KVS entries per gym:

| Host | KVS value |
|------|-----------|
| `iron-anchor-4s1a.sites.pushpress.com` | `gyms/iron-anchor-4s1a/versions/2026-07-20T09-00-00Z` |
| `iron-anchor-4s1a-staging.sites.pushpress.com` | `gyms/iron-anchor-4s1a/versions/2026-07-21T11-00-00Z` |

KVS is updated on every `publish staging`, `publish production`, and `publish rollback`.

---

## Commands

All commands accept `--gym <path>` (default: `./gym.json`) and `--dist <path>` (default: `./apps/renderer/dist`).

### `milo publish staging`

1. Resolve config from `publish.json` adjacent to `gym.json` (auto-create on first run — requires `CLOUDFRONT_KVS_ARN` env var or `--kvs-arn` flag if `publish.json` doesn't exist yet)
2. Validate `dist/` exists and is non-empty — fail fast if not
3. Generate version ID: ISO timestamp with colons replaced by dashes → `2026-07-21T11-00-00Z`
4. Upload all files in `dist/` to `gyms/{slug}/versions/{versionId}/`
5. Write `gyms/{slug}/versions/{versionId}/_complete` marker
6. Read `current.json` (or create empty if first publish)
7. Set `staging` → `versionId`, prepend to `history`
8. Write updated `current.json`
9. Update KVS entry for `{slug}-staging.{domain}`
10. Prune: delete version prefixes in S3 beyond the newest 10, skipping any version referenced by `staging` or `production`
11. Print: `✓ Staging live: https://iron-anchor-4s1a-staging.sites.pushpress.com`

### `milo publish production`

1. Read `current.json`
2. If `production === staging` → exit: `"Production is already up to date with staging"`
3. Set `production` → current `staging` value
4. Write updated `current.json`
5. Update KVS entry for `{slug}.{domain}`
6. Print: `✓ Production live: https://iron-anchor-4s1a.sites.pushpress.com`

### `milo publish rollback [--env staging|production]`

Default env: `staging`

1. Read `current.json`
2. Find the version before the current one for that env in `history`
3. If no prior version → exit: `"No previous version to roll back to"`
4. Set the env pointer to the prior version
5. Write updated `current.json`
6. Update KVS entry for that env's host
7. Print: `✓ Rolled back staging to 2026-07-20T09-00-00Z`

---

## Version retention

- Keep newest 10 versions in `history`
- Prune runs after every `publish staging`
- A version is prunable only if it is not referenced by `staging` or `production` in `current.json`
- Prune = delete all S3 objects under `gyms/{slug}/versions/{versionId}/` + remove from `history`

---

## Architecture

### `packages/publish`

```
src/
  config.ts       — typed config interface, resolved from publish.json + env var overrides
  slugify.ts      — gym name → "iron-anchor-4s1a" (kebab + 4-char hex suffix)
  versions.ts     — version ID generation, current.json read/write, prune logic
  s3.ts           — upload directory, get/put JSON, list/delete version prefixes; S3 client injected
  cloudfront.ts   — KVS client: read ETag, put key; CloudFront client injected (port from legacy)
  publish.ts      — staging / production / rollback orchestration
```

S3 and KVS clients are injected as interfaces — not constructed internally. This makes unit testing straightforward without live AWS calls.

### `apps/cli`

`apps/cli/src/milo.ts` `publish` case calls `packages/publish` with config resolved from flags + `publish.json`.

### Config resolution

Priority: CLI flags > `publish.json` > env vars > defaults

| Key | Default |
|-----|---------|
| `bucket` | `pushpress-marketing-dev` |
| `region` | `us-east-1` |
| `awsProfile` | `unicorn` |
| `kvsArn` | — (required; read from `publish.json`) |
| `siteDomain` | `sites.pushpress.com` |

---

## Error handling

| Scenario | Behavior |
|----------|----------|
| `dist/` missing or empty | Fail immediately: `"Run the renderer build first (pnpm --filter renderer build)"` |
| AWS profile `unicorn` not found | Fail: `"AWS profile 'unicorn' not found. Run: aws configure --profile unicorn"` |
| Upload succeeds, KVS write fails | Print warning with version ID and the KVS value that needs to be set; operator can re-run `publish staging` (a new version is uploaded and the KVS write is retried) |
| Version prefix exists but no `_complete` | Treat as incomplete; overwrite on next publish |
| Rollback with no prior version | Exit: `"No previous version to roll back to"` |
| Promoting when already in sync | Exit: `"Production is already up to date with staging"` |
| Concurrent publishes | Last-write-wins on `current.json` (acceptable for operator CLI) |

---

## Testing

Unit tests (no live AWS):

- `slugify.ts` — deterministic output, collision-resistance property, kebab normalization edge cases
- `versions.ts` — version ID format, `current.json` round-trip, prune logic (never prune active pointers, prune oldest beyond 10)
- `publish.ts` — staging flow, production promote, rollback, each error case — all with injected fake S3 + KVS clients

No integration tests against real AWS in CI. A manual smoke test against `pushpress-marketing-dev` bucket using the `unicorn` profile serves as the integration check.

---

## Out of scope

- CloudFront invalidation (KVS routing is instant; cache TTL on static assets handles freshness)
- Multi-gym batch publish
- Publish hooks / webhooks
- Custom domain mapping (beyond `{slug}.{siteDomain}`)

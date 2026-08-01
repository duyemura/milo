# page-clone

Faithfully clone any website into a **self-contained, editable, multi-page Astro site**, and publish it to `mygymseo.com` staging.

The thesis: fidelity is a *copy* problem, not a *generation* problem. We render the real page in a browser, copy every element's **computed styles verbatim**, and re-emit — no LLM ever draws layout. Every step is gated by a **0-pixel screenshot diff** against the source (or, for the editable projection, against the faithful clone as an oracle).

## Pipeline

```
page-clone.mjs   render (Playwright) → settle+neutralize animations → tag <body>
                 → capture computed styles @1440/768/390 → capture interaction
                 open-states (menu/dropdowns/hovers) → rehost assets (magic-byte
                 typed; iframes/embeds kept live) → emit self-contained HTML
                 + capture.json.  Self-containment is asserted (exits on missing assets).

project-page.mjs capture.json → editable Astro components (per-section, semantic
                 color/font tokens, copy pulled into a `content` array), CSS trimmed
                 to non-default props (lossless), responsive media queries, internal
                 links rewritten source→local, interaction toggle CSS+JS emitted.
                 --base <route> for subpath serving, --links <map> for link rewrite.

build-site.mjs   orchestrator: for each crawled page → page-clone → project-page
                 (--base --links) → astro build → assemble into full-site/<route>/.

deploy.mjs       publish a built dir to S3 + CloudFront (<slug>-staging.mygymseo.com).
```

## Usage

```bash
node page-clone.mjs --url <url> --out <dir> [--no-verify]      # clone one page
node project-page.mjs --dir <capture-dir> --out <dir> \        # project → editable Astro
     [--base /route] [--links links.json] [--no-diff]
node build-site.mjs                                            # whole-site (edit PAGES[])
node --env-file=../.env deploy.mjs --dist <dir> --slug <slug>  # publish to staging
```

## Proven

Two gyms cloned end-to-end and live on `*-staging.mygymseo.com`: **Torrance Training Lab**
(Webflow) and **Speakeasy of Strength** (WordPress/Elementor) — the latter as a navigable
multi-page site with editable components, semantic tokens, working mobile menu + desktop
dropdowns, and canonical-path routing.

## Reference

`docs/MASTER-faithful-clone-to-astro.md` in `github.com/duyemura/pp-sites` — the reverse-engineered
method this implements.

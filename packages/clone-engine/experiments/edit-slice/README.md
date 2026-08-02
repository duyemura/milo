# edit-slice — the EDIT BET, vertical slice (experiment, NOT production C)

A proof-of-concept that answers one question: **can an LLM agent make a natural-language edit
to a cloned site through the `site.json` semantic contract, and can we VERIFY the edit landed
safely?** This validates "subsystem C" (the edit bet). It is intentionally isolated under
`experiments/` and imports the production engine from `../../src` — it does not modify it.

Local only. **Never deploys.**

## Run

```bash
cd packages/clone-engine
LLM_PROVIDER=openrouter DEFAULT_LLM_MODEL=anthropic/claude-haiku-4.5 \
  node experiments/edit-slice/demo.mjs
```

`OPENROUTER_API_KEY` must be in the env. Without an LLM, the demo still runs via a deterministic
keyword fallback (flagged in the output). Before/after full-page screenshots + `result.json`
land in `./out/`. Needs an astro `node_modules` to build (reuses the same shared-install lookup
as `test/astro-build.test.ts`; set `ASTRO_MODULES` to override).

## Pieces

| File | What |
|---|---|
| `edit-ops.mjs` | `editCopy(outDir, key, text)` + `setBrand(outDir, slot, hex)` — deterministic, pure edits over the projected OUT dir. `setBrand` reuses the engine's `flattenRoot` to regenerate `:root` from `brand.json`, preserving the non-brand leftover tokens verbatim. |
| `nl-edit.mjs` | `nlEdit(outDir, request)` — reads `site.json`+`brand.json`, prompts the LLM (`@milo/llm` `llmJson` + a Zod schema forcing `{op, copyKey?\|slot?, value}`) to pick ONE op, validates the target against the contract, applies it. LLM only *chooses*; it never writes HTML/CSS. Falls back to keyword mapping if unreachable. |
| `verify-scoped.mjs` | `verifyScoped(...)` — the safety mechanism. Builds the real astro artifact before + after, screenshots both, and scoped-diffs (see below). Designed to FAIL if an edit corrupts unrelated layout. |
| `demo.mjs` | Projects speakeasy → runs the two NL edits end to end → prints each step + verdict. |

## The scoped-diff (the whole point)

An edit "looks right" is not proof. We build the shipped astro artifact both before and after the
edit and pixel-diff the two full-page screenshots under a scope that names exactly which pixels
were *allowed* to change.

- **editCopy** — the only pixels allowed to change are inside the edited element's **owning
  section** (site.json's edit unit). Everything outside the section must be **0-px**. We report
  both the strict `<h1>` element-box scope AND the section-box scope, because a large display
  font's ink overflows the `<h1>`'s own layout box downward — so the element box under-scopes the
  real edited region. The **section** is the correct, semantically-modeled unit.
- **setBrand** — the intended change is "pixels that were the old brand color become the new
  one." We classify each changed pixel as *recolor* if its before/after color is a solid
  old→new match **or** its channel-delta tracks the recolor vector (`sign(new-old)` per channel,
  with meaningful magnitude). This catches translucent brand fills and anti-aliased edges over
  photos that a naive solid-color match misses. Any changed pixel that does NOT track the recolor
  is *collateral* and must be ~0.

The recolor mask is not a rubber stamp: applied to a copy edit (a non-recolor change) it flags
~99% of changed pixels as collateral — so it can, and does, fail on the wrong kind of change.

## Result on speakeasy (this slice)

| Edit | NL request | LLM chose | scoped-diff |
|---|---|---|---|
| copy | "Change the hero headline to 'Serious Strength, Ridiculous Fun'" | `editCopy AwesomeForEveryoneSection.4` (role=headline) | 80,033 px changed, **0 outside the section** |
| brand | "Make the primary brand color a deep blue (#1e40af)" | `setBrand primary #1e40af` | 259,506 px changed, **0 collateral** (all track magenta→blue) |

Both PASS. The edit bet holds on this slice: the agent picked the correct target from the
contract, the deterministic op applied it, and the scoped-diff proves nothing else moved.

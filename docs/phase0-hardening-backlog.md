# Phase 0 hardening backlog (deferred)

Non-blocking items surfaced during Phase 0 reviews (2026-07-20). Phase 0 gates all pass; these are robustness/observability improvements to pick up before or during Phase 1.

1. **`capture.mjs`: wrap in `try/finally { await browser.close() }`.** Today if anything between `chromium.launch()` and the final close throws (e.g. `fs.mkdirSync` in `downloadAssets`, a network timeout escaping the per-asset catch), the browser leaks and the process can exit with no stderr. This is the likely cause of the observed Speakeasy silent-exit-then-rerun-succeeds flake.

2. **Add a top-level `process.on('unhandledRejection', ...)`** that logs and exits non-zero, so future silent exits become visible instead of vanishing.

3. **`assets.mjs` `downloadAssets`: surface download failures.** Per-asset errors are swallowed ("eval will flag missing"). For standalone capture runs there's no eval; a systemic failure (all downloads fail) returns an empty map with no signal. Add a summary log (`n/m assets downloaded, k failed`) and consider distinguishing network vs HTTP vs absent.

4. **Font self-hosting under CORS.** `resolveFonts` reads `@font-face` via `CSSFontFaceRule`, but cross-origin stylesheets (e.g. Google Fonts) throw on `cssRules` and are skipped — so `fontFileUrls` is empty and those font files are not downloaded (family is still *detected* via `document.fonts`). Phase 1 eval needs the actual font file for typographic fidelity; resolve loaded-font file URLs another way (e.g. capture from the network layer / `document.fonts` + response interception).

5. **Per-viewport (mobile) segmentation.** `segmentPage` currently runs on the desktop page only. Mobile (375) is screenshot-only. Phase 1's `align`/eval needs per-viewport section data — run `segmentPage` on the mobile pass too.

6. **Segmentation edge cases** (from review, low risk, corpus-gated): sub-`MIN_H` sibling `<header>`/`<footer>` skipped at the spine; `y` coordinate offset for `position: fixed`/`sticky` elements.

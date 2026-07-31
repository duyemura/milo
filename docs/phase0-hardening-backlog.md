# Phase 0 hardening backlog (DONE)

Non-blocking items surfaced during Phase 0 reviews (2026-07-20). Phase 0 gates all pass; these are robustness/observability improvements to pick up before or during Phase 1.

All six items were completed in commit `harden(studio): Phase 0 capture robustness` (2026-07-29).

1. **`capture.mjs`: wrap in `try/finally { await browser.close() }`.** ✅ Done — the full capture run is wrapped in `try/finally` so any throw between `chromium.launch()` and the final close releases the browser.

2. **Add a top-level `process.on('unhandledRejection', ...)`** that logs and exits non-zero. ✅ Done — unhandled rejections now log and exit 1 instead of silently vanishing.

3. **`assets.mjs` `downloadAssets`: surface download failures.** ✅ Done — `downloadAssets` returns `{ map, failures, stats }` and logs `downloaded X/Y (Z failed)` with per-failure reason buckets (`http`, `network`, `dns`, `other`).

4. **Font self-hosting under CORS.** ✅ Done — `resolveFontFileUrlsDeep` fetches stylesheet text for both `file://` and `http(s)` URLs and parses `@font-face` blocks manually, so cross-origin stylesheets that throw on `cssRules` are still resolved.

5. **Per-viewport (mobile) segmentation.** ✅ Done — `capture.mjs` runs `segmentPage` on the 375px viewport and writes `m-sections.json`.

6. **Segmentation edge cases.** ✅ Done — short `<header>`/`<footer>` siblings are kept with a lower min-height (20px), and `position` + viewport-relative `y` are recorded for fixed/sticky elements.

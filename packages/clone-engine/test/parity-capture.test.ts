import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "../src/capture.ts";
import type { CaptureJson, TreeEl, TreeNode, Head } from "../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SITES = ["torrance", "speakeasy", "sweatshed"] as const;
const WIDTHS = ["1440", "768", "390"] as const;

// ---------------------------------------------------------------------------
// The ONLY nondeterministic thing in a capture is rehosted asset filenames
// (a0.png, a1.png … numbered by Promise.all completion order). So the parity
// comparison is STRUCTURAL and normalizes/excludes those `aN`/`fN` names. Every
// fidelity-bearing signal (tree tags, style property KEYS, non-url() style
// VALUES, head title/lang/metas) is compared EXACTLY.
// ---------------------------------------------------------------------------

/** Replace an `assets/aN.ext` (or `fN.ext`) filename with `assets/<A>` so
 *  nondeterministic asset numbering doesn't defeat comparison. Applied only to
 *  strings that reference the local assets/ dir. */
function normAssetName(s: string): string {
  return s.replace(/assets\/[af]\d+\.\w+/g, "assets/<A>");
}

// Track throwaway capture() OUT dirs; remove after the suite.
const tmpOutDirs: string[] = [];
afterAll(() => {
  for (const d of tmpOutDirs) fs.rmSync(d, { recursive: true, force: true });
});

const CT: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".avif": "image/avif", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".ico": "image/x-icon",
};

/** Serve `root` over http on an ephemeral port. Returns url base + close(). */
async function serveDir(root: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const fp = path.join(root, url === "/" ? "/index.html" : url);
    if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": CT[path.extname(fp).toLowerCase()] || "application/octet-stream", "content-length": buf.length });
      res.end(buf);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Run TS capture() against the served golden clone into a throwaway OUT dir. */
async function captureTmp(goldenDir: string): Promise<CaptureJson & { __outDir: string }> {
  const { port, close } = await serveDir(goldenDir);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "parity-cap-"));
  tmpOutDirs.push(out);
  try {
    const { capture: cap } = await capture({ url: `http://127.0.0.1:${port}/index.html`, out, verify: false });
    return Object.assign(cap, { __outDir: out });
  } finally {
    await close();
  }
}

/** Depth-first list of element tags (text nodes ignored). */
function tagSeq(node: TreeNode, acc: string[] = []): string[] {
  if ((node as { t?: string }).t !== undefined) return acc;
  const el = node as TreeEl;
  acc.push(el.tag);
  for (const c of el.children) tagSeq(c, acc);
  return acc;
}

/** head normalized for comparison: any content/href referencing assets/ has its
 *  nondeterministic aN filename placeholdered. title/lang/metas keys are exact. */
function normHead(h: Head) {
  return {
    title: h.title,
    lang: h.lang,
    metas: h.metas.map((m) => ({ key: m.key, content: m.content.includes("assets/") ? normAssetName(m.content) : m.content })),
  };
}

describe("capture parity vs frozen .mjs capture-of-clone", () => {
  for (const site of SITES) {
    const goldenDir = path.join(dir, "golden", site);

    it(`${site}: TS capture() structurally === frozen .mjs capture`, async () => {
      const a = await captureTmp(goldenDir); // TS
      const b: CaptureJson = JSON.parse(fs.readFileSync(path.join(goldenDir, "capture-of-clone-mjs.json"), "utf8")); // .mjs ref

      // 1. Element count equal (@1440).
      expect(Object.keys(a.styles["1440"]).length).toEqual(Object.keys(b.styles["1440"]).length);

      // 2. Tree tag-sequence identical (depth-first, text nodes ignored).
      expect(tagSeq(a.tree)).toEqual(tagSeq(b.tree));

      for (const w of WIDTHS) {
        const sa = a.styles[w], sb = b.styles[w];
        const idsA = Object.keys(sa).sort(), idsB = Object.keys(sb).sort();
        expect(idsA, `id set @${w}`).toEqual(idsB);

        for (const id of idsA) {
          // 3. Per-id style property KEYS identical.
          expect(Object.keys(sa[id]).sort(), `${site} pc-${id} prop keys @${w}`).toEqual(Object.keys(sb[id]).sort());
          // 4. Per-id style VALUES identical, EXCLUDING any value containing url()
          //    (those embed nondeterministic aN asset names — the only nondeterminism).
          for (const k of Object.keys(sa[id])) {
            if (sa[id][k].includes("url(") || sb[id][k].includes("url(")) continue;
            expect(sa[id][k], `${site} pc-${id}.${k} @${w}`).toEqual(sb[id][k]);
          }
        }
      }

      // 5. head equal on title, lang, metas (asset filenames normalized).
      expect(normHead(a.head)).toEqual(normHead(b.head));

      // 6. interactions structurally equal. Static clones have no live nav JS,
      //    so both are null here (asserted; documented if that ever changes).
      expect(a.interactions).toEqual(b.interactions);

      // 7. asset integrity: same COUNT of rehosted assets, and every assets/aN.*
      //    ref in the TS output resolves to a file on disk.
      const aAssets = fs.readdirSync(path.join(a.__outDir, "assets"));
      const bDir = path.join(goldenDir, "assets"); // note: b's out dir is gone; but the ref JSON tells us its assets via tree/styles.
      // TS asset count vs .mjs ref asset count: recover .mjs count from its capture
      // by counting distinct assets/aN|fN refs it embedded.
      const bRefs = new Set<string>();
      const collectRefs = (node: TreeNode) => {
        if ((node as { t?: string }).t !== undefined) return;
        const el = node as TreeEl;
        for (const key of ["src", "srcset", "poster"]) {
          const val = el.attrs[key];
          if (val) for (const part of String(val).split(",")) { const m = part.trim().split(/\s+/)[0].match(/assets\/[af]\d+\.\w+/); if (m) bRefs.add(m[0]); }
        }
        el.children.forEach(collectRefs);
      };
      collectRefs(b.tree);
      for (const wq of WIDTHS) for (const idq in b.styles[wq]) for (const v of Object.values(b.styles[wq][idq])) { const mm = v.match(/assets\/[af]\d+\.\w+/g); if (mm) mm.forEach((x) => bRefs.add(x)); }
      { const mm = b.fontCss.match(/assets\/[af]\d+\.\w+/g); if (mm) mm.forEach((x) => bRefs.add(x)); }

      const aRefs = new Set<string>();
      const collectA = (node: TreeNode) => {
        if ((node as { t?: string }).t !== undefined) return;
        const el = node as TreeEl;
        for (const key of ["src", "srcset", "poster"]) {
          const val = el.attrs[key];
          if (val) for (const part of String(val).split(",")) { const m = part.trim().split(/\s+/)[0].match(/assets\/[af]\d+\.\w+/); if (m) aRefs.add(m[0]); }
        }
        el.children.forEach(collectA);
      };
      collectA(a.tree);
      for (const wq of WIDTHS) for (const idq in a.styles[wq]) for (const v of Object.values(a.styles[wq][idq])) { const mm = v.match(/assets\/[af]\d+\.\w+/g); if (mm) mm.forEach((x) => aRefs.add(x)); }
      { const mm = a.fontCss.match(/assets\/[af]\d+\.\w+/g); if (mm) mm.forEach((x) => aRefs.add(x)); }

      // Same number of distinct rehosted asset refs (filenames differ; count is deterministic).
      expect(aRefs.size, `${site} distinct rehosted asset refs`).toEqual(bRefs.size);
      // Every asset file the TS capture wrote exists on disk, and every ref resolves.
      for (const ref of aRefs) expect(fs.existsSync(path.join(a.__outDir, ref)), `${site} ${ref} missing on disk`).toBe(true);
      // Files on disk >= referenced (some rehosted-but-unreferenced is impossible; equal is the norm).
      expect(aAssets.length, `${site} assets on disk`).toBeGreaterThanOrEqual(aRefs.size);
    }, 300_000);
  }
});

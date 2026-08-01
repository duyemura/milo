/**
 * Shared strip-diff pixel oracle.
 *
 * Extracted so the production oracle (project.ts) and the test oracle
 * (test/helpers/pixel.ts) can never drift. Behavior is byte-identical to both
 * originals: per-channel threshold 8, STRIP=1000 (bounds memory on tall pages),
 * `pct` rounded to 4 decimals. The in-page loader rejects (rather than hangs) on
 * a malformed PNG so a decode failure surfaces as an error.
 */
import type { Browser } from "playwright";

export interface PixelDiffResult {
  /** Count of differing pixels (any RGB channel delta > 8). */
  d: number;
  /** Total compared pixels (min-width * min-height). */
  total: number;
  /** Percentage of differing pixels, rounded to 4 decimals. */
  pct: number;
  /** Whether both images have identical dimensions. */
  dimMatch: boolean;
  /** Height of image A (a.k.a. the first buffer). */
  ah: number;
  /** Height of image B (a.k.a. the second buffer). */
  bh: number;
}

/** Pixel-diff two PNG buffers in horizontal strips (bounds memory on tall pages). */
export async function pixelDiff(browser: Browser, aPng: Buffer, bPng: Buffer): Promise<PixelDiffResult> {
  const dp = await browser.newPage();
  try {
    return await dp.evaluate(async ([x, y]) => {
      // reject (not hang) on a malformed PNG so a decode failure surfaces as an error
      const load = (s: string) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error("image decode failed"));
          i.src = s;
        });
      const [ia, ib] = await Promise.all([load("data:image/png;base64," + x), load("data:image/png;base64," + y)]);
      const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
      // diff in horizontal strips so a tall page never decodes its whole ImageData at once (bounds memory)
      const STRIP = 1000, c = document.createElement("canvas");
      c.width = w; c.height = Math.min(STRIP, h);
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      let d = 0;
      for (let y0 = 0; y0 < h; y0 += STRIP) {
        const sh = Math.min(STRIP, h - y0);
        ctx.clearRect(0, 0, w, sh); ctx.drawImage(ia, 0, y0, w, sh, 0, 0, w, sh); const da = ctx.getImageData(0, 0, w, sh).data;
        ctx.clearRect(0, 0, w, sh); ctx.drawImage(ib, 0, y0, w, sh, 0, 0, w, sh); const db = ctx.getImageData(0, 0, w, sh).data;
        for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 8 || Math.abs(da[i + 1] - db[i + 1]) > 8 || Math.abs(da[i + 2] - db[i + 2]) > 8) d++;
      }
      return { d, total: w * h, pct: +(d / (w * h) * 100).toFixed(4), dimMatch: ia.width === ib.width && ia.height === ib.height, ah: ia.height, bh: ib.height };
    }, [aPng.toString("base64"), bPng.toString("base64")]);
  } finally {
    await dp.close();
  }
}

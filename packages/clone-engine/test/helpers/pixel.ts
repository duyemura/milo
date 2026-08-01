import type { Browser } from "playwright";

/** Pixel-diff two PNG buffers in horizontal strips (bounds memory on tall pages). */
export async function pixelDiff(browser: Browser, aPng: Buffer, bPng: Buffer) {
  const dp = await browser.newPage();
  const r = await dp.evaluate(async ([x, y]) => {
    const load = (s: string) => new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = s; });
    const [ia, ib] = await Promise.all([load("data:image/png;base64," + x), load("data:image/png;base64," + y)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const STRIP = 1000, c = document.createElement("canvas"); c.width = w; c.height = Math.min(STRIP, h);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    let d = 0;
    for (let y0 = 0; y0 < h; y0 += STRIP) {
      const sh = Math.min(STRIP, h - y0);
      ctx.clearRect(0, 0, w, sh); ctx.drawImage(ia, 0, y0, w, sh, 0, 0, w, sh); const da = ctx.getImageData(0, 0, w, sh).data;
      ctx.clearRect(0, 0, w, sh); ctx.drawImage(ib, 0, y0, w, sh, 0, 0, w, sh); const db = ctx.getImageData(0, 0, w, sh).data;
      for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 8 || Math.abs(da[i+1] - db[i+1]) > 8 || Math.abs(da[i+2] - db[i+2]) > 8) d++;
    }
    return { d, total: w * h, pct: +(d / (w * h) * 100).toFixed(4), dimMatch: ia.width === ib.width && ia.height === ib.height };
  }, [aPng.toString("base64"), bPng.toString("base64")]);
  await dp.close();
  return r;
}

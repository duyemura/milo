/** Extract the value of an attribute from the first matching tag. Returns undefined if absent. */
export function getAttribute(html: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["']`, "i");
  return html.match(re)?.[1];
}

/** Extract all values of one attribute from every matching tag. */
export function getAllAttributes(html: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["']`, "gi");
  return [...html.matchAll(re)].map((m) => m[1]);
}

/** Extract the text content of the first matching tag. */
export function getTextContent(html: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = html.match(re);
  return m ? m[1].trim() : undefined;
}

/** Count how many times a tag appears (opening tags only). */
export function countTag(html: string, tag: string): number {
  return [...html.matchAll(new RegExp(`<${tag}[\\s>]`, "gi"))].length;
}

/** Extract all `<meta name="..." content="...">` and `<meta property="...">` as a map. */
export function parseMetas(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/name=["']([^"']*)["']/i)?.[1]?.toLowerCase();
    const prop = tag.match(/property=["']([^"']*)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "";
    if (name) out.set(name, content);
    if (prop) out.set(prop, content);
  }
  return out;
}

/** Check if JSON-LD structured data is present. */
export function hasJsonLd(html: string): boolean {
  return /<script[^>]*type=["']application\/ld\+json["'][^>]*>/i.test(html);
}

/** Extract all href values from <a> tags. */
export function getLinks(html: string): string[] {
  return getAllAttributes(html, "a", "href");
}

/** Extract all src values from <img> tags. */
export function getImgSrcs(html: string): string[] {
  return getAllAttributes(html, "img", "src");
}

/** Extract background-image url() values from inline style attributes and <style> blocks. */
export function getCssBackgroundUrls(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/gi)) {
    out.push(m[1].trim());
  }
  return out;
}

/** Extract all <iframe src> values. */
export function getIframeSrcs(html: string): string[] {
  return getAllAttributes(html, "iframe", "src");
}

/** Count images missing alt attributes. */
export function countImgsWithoutAlt(html: string): number {
  const imgs = [...html.matchAll(/<img\s[^>]*>/gi)].map((m) => m[0]);
  return imgs.filter((tag) => !/\balt\s*=/i.test(tag)).length;
}

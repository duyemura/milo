import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GymDocuments } from "@milo/schema";
import { runGenerate } from "../src/generate.ts";
import type { ChatFn } from "@milo/llm";

function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}

const IDENTITY = { found: true, name: "Iron Anchor", formattedAddress: "1 Dock St" };
const BRAND = { colors: { "#0b1f3a": 12, "#e63946": 5, "#ffffff": 20 }, fonts: { display: "Oswald", body: "Inter" }, logo: "https://ironanchor.com/logo.svg", socialLinks: [], software: null, analytics: {}, fontFiles: [] };
const INVENTORY = { baseUrl: "https://ironanchor.com", discoveredAt: "2026-07-29", totalDiscovered: 1, filtered: 0, capped: 0, pages: [{ url: "https://ironanchor.com/", slug: "index", priority: 1, source: "nav", llmBudget: "full" }] };
const PAGE = { url: "https://ironanchor.com/", slug: "index", title: "Iron Anchor", metaDescription: "", headings: [], bodyText: "Strength for real life", images: [], links: [], fetchMethod: "static", detectedType: "homepage", pageArchetype: "home", pageGoal: "convert", primaryKeyword: "", secondaryKeywords: [], topicsAnswered: [], conversionSignals: [] };
const CONTEXT = { positioning: { headline: "Strength for real life" } };
const BUSINESS = { techStack: { bookingMethod: "phone only" } };

const GYM = {
  identity: { name: "Iron Anchor", tagline: "Strength for real life" },
  brand: {
    colors: { primary: "#0b1f3a", accent: "#e63946", surface: "#ffffff", text: "#1a1a1a", muted: "#8a8a8a" },
    fonts: { display: "Oswald", body: "Inter" },
    space: { sm: "8px", md: "16px", lg: "32px" },
    radius: { button: "6px", card: "12px" },
  },
  hierarchy: {
    pages: [{
      slug: "index",
      title: "Home",
      meta: { description: "Strength for real life" },
      sections: [{ section: "hero", content: { heading: "Welcome", image: { src: "https://ironanchor.com/hero.jpg", alt: "gym" } } }],
    }],
  },
};

let docsDir: string;
let outDir: string;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "cli-generate-"));
  docsDir = path.join(base, "docs");
  outDir = path.join(base, "out");
  await mkdir(path.join(docsDir, "crawl/pages"), { recursive: true });
  await writeFile(path.join(docsDir, "crawl/identity.json"), JSON.stringify(IDENTITY), "utf8");
  await writeFile(path.join(docsDir, "crawl/brand.json"), JSON.stringify(BRAND), "utf8");
  await writeFile(path.join(docsDir, "crawl/pages.json"), JSON.stringify(INVENTORY), "utf8");
  await writeFile(path.join(docsDir, "crawl/pages/index.json"), JSON.stringify(PAGE), "utf8");
});

afterEach(async () => { await rm(path.dirname(docsDir), { recursive: true, force: true }); });

describe("runGenerate", () => {
  it("writes a valid gym.json from a crawl bundle", async () => {
    await runGenerate({ docsDir, outDir, chat: fakeChat([JSON.stringify(GYM)]), model: "capable" });
    const written = JSON.parse(await readFile(path.join(outDir, "gym.json"), "utf8"));
    expect(() => GymDocuments.parse(written)).not.toThrow();
    expect(written.identity.name).toBe("Iron Anchor");
  });

  it("loads and passes context.json and business.json when present", async () => {
    await writeFile(path.join(docsDir, "context.json"), JSON.stringify(CONTEXT), "utf8");
    await writeFile(path.join(docsDir, "business.json"), JSON.stringify(BUSINESS), "utf8");

    let captured: { messages: { role: string; content: string }[] } | undefined;
    const chat: ChatFn = async (opts) => {
      captured = opts;
      return { content: JSON.stringify(GYM) };
    };

    await runGenerate({ docsDir, outDir, chat, model: "capable" });
    const prompt = captured?.messages.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("Strength for real life");
    expect(prompt).toContain("phone only");
  });

  it("warns and continues when an inventory page has no matching crawl file", async () => {
    const inventoryWithMissing = {
      ...INVENTORY,
      pages: [
        ...INVENTORY.pages,
        { url: "https://ironanchor.com/about", slug: "about", priority: 2, source: "nav", llmBudget: "truncated" },
      ],
    };
    await writeFile(path.join(docsDir, "crawl/pages.json"), JSON.stringify(inventoryWithMissing), "utf8");

    const consoleWarns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { consoleWarns.push(args.map(String).join(" ")); };
    try {
      await runGenerate({ docsDir, outDir, chat: fakeChat([JSON.stringify(GYM)]), model: "capable" });
    } finally {
      console.warn = originalWarn;
    }

    expect(consoleWarns.some((w) => w.includes("missing crawl/pages/about.json"))).toBe(true);
    const written = JSON.parse(await readFile(path.join(outDir, "gym.json"), "utf8"));
    expect(written.identity.name).toBe("Iron Anchor");
  });
});

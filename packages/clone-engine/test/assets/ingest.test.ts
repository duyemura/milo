import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestAsset, tagAsset } from "../../src/assets/ingest.ts";
import { loadLibrary } from "../../src/assets/library.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

// Real 2x1 PNG so dimension sniffing works
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADElEQVR42mNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function tagsResponse(over: Record<string, unknown> = {}): ChatFn {
  const body = JSON.stringify({ hasPeople: false, subjects: ["barbell"], activity: "lifting", mood: ["focused"], setting: "product", description: "A loaded barbell.", quality: "high", ...over });
  return async (): Promise<ChatResponse> => ({ content: body, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
}

function writeSrc(dir: string, name = "src.png", buf: Buffer = PNG_2x1): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

describe("ingestAsset", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("copies file into library/, records a pending asset, returns its id", async () => {
    const src = writeSrc(dir);
    const { assetId, tagging } = await ingestAsset(dir, { file: src, source: "upload", businessId: "biz_1", chat: tagsResponse(), model: "vision-test", now: () => new Date("2026-08-02T12:00:00.000Z") });
    expect(assetId).toMatch(/^ast_/);
    const lib0 = loadLibrary(dir, "biz_1");
    const rec = lib0.assets[assetId];
    expect(rec.file).toBe(`library/${assetId}.png`);
    expect(fs.existsSync(path.join(dir, rec.file))).toBe(true);
    expect(rec.mime).toBe("image/png");
    expect(rec.dimensions).toEqual({ w: 2, h: 1 });
    expect(rec.bytes).toBe(PNG_2x1.length);
    expect(rec.source).toBe("upload");
    expect(rec.status).toBe("active");
    expect(rec.createdAt).toBe("2026-08-02T12:00:00.000Z");
    await tagging;
    const lib1 = loadLibrary(dir, "biz_1");
    const tagged = lib1.assets[assetId];
    expect(tagged.tags.pending).toBe(false);
    expect(tagged.tags.subjects).toContain("barbell");
    expect(tagged.tags.quality).toBe("high");
    expect(tagged.tags.embedding).toBeUndefined();
  });

  it("derives aspectRatio 'other' for a 2x1 image", async () => {
    const { assetId, tagging } = await ingestAsset(dir, { file: writeSrc(dir), source: "upload", businessId: "biz_1", chat: tagsResponse(), model: "m" });
    await tagging;
    expect(loadLibrary(dir, "biz_1").assets[assetId].aspectRatio).toBe("other");
  });

  it("leaves tags pending when no chat/model provided", async () => {
    const { assetId, tagging } = await ingestAsset(dir, { file: writeSrc(dir), source: "upload", businessId: "biz_1" });
    await tagging;
    expect(loadLibrary(dir, "biz_1").assets[assetId].tags.pending).toBe(true);
  });

  it("throws on an unrecognized file header", async () => {
    const bad = writeSrc(dir, "bad.bin", Buffer.from("not-an-image"));
    await expect(ingestAsset(dir, { file: bad, source: "upload", businessId: "biz_1" })).rejects.toThrow(/sniff|header|image/i);
  });

  it("appends to an existing library rather than replacing it", async () => {
    const a = await ingestAsset(dir, { file: writeSrc(dir, "a.png"), source: "upload", businessId: "biz_1", chat: tagsResponse(), model: "m" });
    await a.tagging;
    const b = await ingestAsset(dir, { file: writeSrc(dir, "b.png"), source: "generated", businessId: "biz_1", chat: tagsResponse(), model: "m" });
    await b.tagging;
    expect(Object.keys(loadLibrary(dir, "biz_1").assets)).toHaveLength(2);
  });
});

describe("tagAsset", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "tag-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("sends image as vision message and writes returned tags", async () => {
    const src = writeSrc(dir);
    const { assetId } = await ingestAsset(dir, { file: src, source: "upload", businessId: "biz_1" });
    expect(loadLibrary(dir, "biz_1").assets[assetId].tags.pending).toBe(true);
    let seenImage = false;
    const chat: ChatFn = async (opts) => {
      const last = opts.messages[opts.messages.length - 1];
      if (Array.isArray(last.content)) seenImage = last.content.some((p) => (p as { type: string; image_url?: { url: string } }).type === "image_url" && (p as { type: string; image_url?: { url: string } }).image_url?.url.startsWith("data:image/png;base64,"));
      return { content: JSON.stringify({ hasPeople: false, subjects: ["kettlebell"], mood: [], setting: "product", description: "A kettlebell.", quality: "medium" }), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    };
    await tagAsset(dir, assetId, { chat, model: "vision-test" });
    expect(seenImage).toBe(true);
    const rec = loadLibrary(dir, "biz_1").assets[assetId];
    expect(rec.tags.pending).toBe(false);
    expect(rec.tags.subjects).toEqual(["kettlebell"]);
  });

  it("forces hasPeople:false onto a GENERATED asset even if model claims otherwise", async () => {
    const src = writeSrc(dir);
    const { assetId } = await ingestAsset(dir, { file: src, source: "generated", businessId: "biz_1" });
    const chat: ChatFn = async () => ({ content: JSON.stringify({ hasPeople: true, subjects: ["person"], mood: [], setting: "interior", description: "A coach.", quality: "high" }), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    await tagAsset(dir, assetId, { chat, model: "m" });
    expect(loadLibrary(dir, "biz_1").assets[assetId].tags.hasPeople).toBe(false);
  });
});

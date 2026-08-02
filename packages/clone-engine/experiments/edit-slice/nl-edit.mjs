/**
 * nl-edit.mjs — the LLM driver for the edit bet.
 *
 * nlEdit(outDir, request): read the site's semantic contract (site.json + brand.json), build a
 * compact prompt describing the addressable copy slots + brand slots, ask the LLM to pick ONE
 * edit op ({op, copyKey?|slot?, value}), then apply it with the deterministic edit-ops.
 *
 * The LLM only CHOOSES a target from the contract — it never writes HTML/CSS. The mutation is
 * done by editCopy/setBrand, so a hallucinated target either fails validation (unknown key) or
 * is caught by the scoped-diff downstream. If the LLM is unreachable, a deterministic keyword
 * fallback keeps the demo runnable (and the result is flagged as fallback).
 */
import { z } from "zod";
import { llmJson, chatCompletion } from "../../../llm/src/index.ts";
import { editCopy, setBrand, readSite, readBrand, findCopy } from "./edit-ops.mjs";

const EditSchema = z.object({
  op: z.enum(["editCopy", "setBrand"]),
  copyKey: z.string().optional(),
  slot: z.enum(["primary", "accent", "surface", "text", "muted"]).optional(),
  value: z.string(),
  reason: z.string().optional(),
});

/** LlmConfig + model from env (OpenRouter), or null if not configured. */
function llmFromEnv() {
  const provider = process.env.LLM_PROVIDER ?? "openrouter";
  const model = process.env.DEFAULT_LLM_MODEL;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!model || (provider === "openrouter" && !apiKey)) return null;
  const config = {
    provider,
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    openrouterApiKey: apiKey,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaApiKey: process.env.OLLAMA_API_KEY,
  };
  return { config, model };
}

/** Build a compact, LLM-friendly digest of the editable surface from site.json + brand.json. */
function buildDigest(site, brand) {
  const page = site.pages[0];
  const copy = page.copy.map((c) => ({
    key: c.key,
    section: c.component,
    role: c.role ?? null,
    text: c.text,
  }));
  const brandSlots = Object.fromEntries(
    Object.entries(brand.colors).map(([slot, v]) => [slot, { value: v.value, hex: v.hex }]),
  );
  return { copy, brandSlots };
}

const SYSTEM = `You are the edit planner for a website editor. You are given a site's editable
COPY slots (each with a stable key, the section it lives in, an optional semantic role like
"headline", and its current text) and its BRAND color slots (primary/accent/surface/text/muted).
Given a natural-language edit request, choose EXACTLY ONE operation:
- {"op":"editCopy","copyKey":"<key>","value":"<new text>"} to change a copy string. Pick the
  copyKey whose current text/role/section best matches what the user wants to change. Prefer a
  slot with role "headline" for "headline"/"title"/"hero" requests.
- {"op":"setBrand","slot":"primary|accent|surface|text|muted","value":"#rrggbb"} to recolor a
  brand slot. value MUST be a 6-digit hex color.
Return ONLY the JSON object. Use an existing copyKey verbatim — never invent one.`;

/** Deterministic fallback when the LLM is unreachable (keyword mapping). */
function fallbackPlan(request, site) {
  const req = request.toLowerCase();
  const hexMatch = request.match(/#([0-9a-fA-F]{6})/);
  const page = site.pages[0];
  if (/(color|colour|brand|recolor|blue|red|green|primary|accent)/.test(req) && hexMatch) {
    let slot = "primary";
    for (const s of ["accent", "surface", "text", "muted"]) if (req.includes(s)) slot = s;
    return { op: "setBrand", slot, value: "#" + hexMatch[1], reason: "keyword fallback" };
  }
  // copy: prefer a headline slot, else the first slot whose text keyword-overlaps the request.
  const quoted = request.match(/["“']([^"”']{3,})["”']/);
  const newText = quoted ? quoted[1] : request;
  const headline = page.copy.find((c) => c.role === "headline");
  const target = headline ?? page.copy[0];
  return { op: "editCopy", copyKey: target.key, value: newText, reason: "keyword fallback" };
}

/**
 * nlEdit — plan (LLM or fallback) then apply.
 * Returns { plan, applied, usedFallback } where applied is the edit-op result.
 */
export async function nlEdit(outDir, request) {
  const site = readSite(outDir);
  const brand = readBrand(outDir);
  const digest = buildDigest(site, brand);

  let plan;
  let usedFallback = false;
  const env = llmFromEnv();
  if (env) {
    try {
      const chat = (o) => chatCompletion(o, env.config);
      plan = await llmJson(EditSchema, {
        chat,
        model: env.model,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content:
              `EDITABLE SURFACE:\n${JSON.stringify(digest)}\n\nEDIT REQUEST:\n${request}\n\nReturn the single edit-op JSON.`,
          },
        ],
        temperature: 0,
        maxTokens: 300,
      });
    } catch (err) {
      console.warn(`[nlEdit] LLM failed (${err?.message ?? err}); using deterministic fallback`);
      plan = fallbackPlan(request, site);
      usedFallback = true;
    }
  } else {
    console.warn("[nlEdit] no LLM configured; using deterministic fallback");
    plan = fallbackPlan(request, site);
    usedFallback = true;
  }

  // Validate the chosen target against the contract before mutating.
  let applied;
  if (plan.op === "editCopy") {
    if (!plan.copyKey || !findCopy(site, plan.copyKey)) {
      throw new Error(`nlEdit: LLM chose an unknown copyKey: ${plan.copyKey}`);
    }
    applied = editCopy(outDir, plan.copyKey, plan.value);
  } else {
    if (!plan.slot) throw new Error("nlEdit: setBrand plan missing slot");
    const oldHex = brand.colors[plan.slot].hex;
    applied = { ...setBrand(outDir, plan.slot, plan.value), oldHex };
  }
  return { plan, applied, usedFallback };
}

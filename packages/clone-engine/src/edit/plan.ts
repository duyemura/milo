/**
 * plan.ts — clarifying-dialogue planner for subsystem C (T7).
 *
 * Turns a natural-language edit conversation into a validated PlanResult:
 *   - needsInfo: true + questions[]  — when request is vague or targets can't be validated
 *   - needsInfo: false + ops[] + summary — when request is clear + all targets exist
 *
 * The LLM output is post-validated against the REAL site (via target.ts resolvers) so
 * hallucinated copy keys / section names / asset aliases are always dropped before
 * returning. If all ops are dropped, the result degrades to needsInfo: true with a
 * clarifying question explaining the mismatch.
 */
import type { SiteRef, EditOp, PlanResult, ConversationTurn } from "./types.ts";
import { PlanSchema, EditOpSchema } from "./types.ts";
import { digest } from "./digest.ts";
import {
  resolveCopy,
  resolveSection,
  resolveAsset,
  resolveElement,
  TargetError,
  loadSite,
} from "./target.ts";
import { llmJson } from "@milo/llm";
import type { ChatFn, ChatMessage } from "@milo/llm";

const SYSTEM_PROMPT = `You edit ONE gym website. Given the site digest and the conversation, determine the user's intent.

If the request is CLEAR and SPECIFIC:
- Output a list of edit ops from the schema (1–5 ops), each targeting a REAL identifier from the digest.
- Add a plain-language summary (1–3 sentences) of what you will change.
- Set needsInfo to false.

If the request is VAGUE or UNDERSPECIFIED (missing which section, which copy, what value, etc.):
- Ask 1–3 clarifying questions to understand WHAT they want changed and WHY.
- Set needsInfo to true.

NEVER invent targets. Only reference:
- copyKeys that appear in the digest (e.g. "HeroSection.0")
- section names or roles from the digest (e.g. "hero", "HeroSection")
- asset aliases from the digest (e.g. "logo")
- brand slots: primary, accent, surface, text, muted
- element roles from the digest

Output valid JSON matching the schema. No markdown, no prose outside the JSON.`;

/**
 * Run the planner. Returns a PlanResult validated against the real site.
 *
 * @param site - SiteRef pointing to the projected out dir (must have site.json + brand.json).
 * @param conversation - The dialogue so far. The LAST entry should be the pending user request.
 * @param chat - Injectable ChatFn (real or mocked).
 * @param model - Model string passed to the LLM.
 */
export async function plan(
  site: SiteRef,
  conversation: ConversationTurn[],
  chat: ChatFn,
  model: string,
): Promise<PlanResult> {
  const siteDigest = digest(site);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Site digest:\n${JSON.stringify(siteDigest, null, 2)}`,
    },
    ...conversation.map((t) => ({ role: t.role, content: t.content })),
  ];

  const raw = await llmJson(PlanSchema, { chat, model, messages, temperature: 0.2 });

  if (raw.needsInfo) {
    return { needsInfo: true, questions: raw.questions };
  }

  // Post-validate each op against the real site.
  const validated: EditOp[] = [];
  const dropped: Array<{ op: unknown; reason: string }> = [];

  for (const op of raw.ops) {
    try {
      validateOpTarget(site, op);
      validated.push(op as EditOp);
    } catch (err) {
      const reason = err instanceof TargetError ? err.message : String(err);
      dropped.push({ op, reason });
      console.warn(`[plan] dropped hallucinated op (${(op as { op: string }).op}): ${reason}`);
    }
  }

  if (dropped.length > 0) {
    console.warn(`[plan] ${dropped.length} op(s) dropped due to hallucinated targets`);
  }

  // If ALL ops were dropped, downgrade to needsInfo.
  if (validated.length === 0) {
    return {
      needsInfo: true,
      questions: [
        "I couldn't find the elements you described on this site. " +
        "Could you clarify which section, text, or element you'd like to change? " +
        "I can list available sections and copy keys if that helps.",
      ],
    };
  }

  // SOME (not all) ops were dropped → the LLM's summary still describes ALL requested changes,
  // which would let the caller report full success for a partial edit. Surface the drops in the
  // result AND append a caller-visible note to the summary so the UI can't over-report.
  if (dropped.length > 0) {
    const note =
      ` (Note: I couldn't apply ${dropped.length} of the requested change(s) because ` +
      `${dropped.map((d) => (d.op as { op?: string }).op ?? "an op").join(", ")} referenced ` +
      `elements not on this site — only the remaining ${validated.length} will change.)`;
    return { needsInfo: false, ops: validated, summary: raw.summary + note, dropped };
  }

  return { needsInfo: false, ops: validated, summary: raw.summary };
}

/**
 * Validate that an op's targets exist in the real site.json.
 * Throws `TargetError` if any target is missing (hallucinated).
 */
function validateOpTarget(site: SiteRef, op: unknown): void {
  // Cast through EditOpSchema to get a typed op.
  const parsed = EditOpSchema.parse(op);

  switch (parsed.op) {
    case "editCopy":
      resolveCopy(site, parsed.copyKey);
      break;

    case "setBrand": {
      // Slot validity is guaranteed by the Zod enum (one of 5 known values).
      // No additional runtime file check needed — brand slots are fixed.
      void loadSite(site); // ensure site.json is readable
      break;
    }

    case "swapAsset":
      resolveAsset(site, parsed.alias);
      break;

    case "styleTweak":
      // target can be an element role or a section role/name — try both.
      try {
        resolveElement(site, parsed.target);
      } catch {
        // If resolveElement throws TargetError, try resolveSection.
        resolveSection(site, parsed.target);
      }
      break;

    case "removeSection":
    case "reorderSection":
      resolveSection(site, parsed.section);
      break;

    case "addSection":
      resolveSection(site, parsed.cloneOf);
      if (parsed.afterSection !== undefined) {
        // afterSection is advisory — don't throw if missing, just log.
        try {
          resolveSection(site, parsed.afterSection);
        } catch {
          console.warn(`[plan] addSection.afterSection "${parsed.afterSection}" not found — will append at end`);
        }
      }
      break;

    case "addPage": {
      // route must be non-empty (Zod already checks z.string(), we add a runtime guard).
      if (!parsed.route || parsed.route.trim() === "") {
        throw new TargetError("addPage: route must be non-empty");
      }
      // cloneOfPage, if provided, must match a page in the manifest.
      if (parsed.cloneOfPage !== undefined) {
        const manifest = loadSite(site);
        const found = manifest.pages.find(
          (p) => p.route === parsed.cloneOfPage || p.component === parsed.cloneOfPage,
        );
        if (!found) {
          throw new TargetError(`addPage: cloneOfPage not found in site.json: ${parsed.cloneOfPage}`);
        }
      }
      break;
    }
  }
}

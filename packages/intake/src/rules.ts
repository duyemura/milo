import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PriorityRule = z.object({
  pattern: z.string().min(1),
  priority: z.number().int().min(1).max(9),
});

export const CrawlRules = z.object({
  version: z.number().int().positive(),
  ugcSegments: z.array(z.string().min(1)),
  datePathRegex: z.string().min(1),
  listingQueryParams: z.array(z.string().min(1)),
  nonHtmlExtensions: z.array(z.string().regex(/^\./)),
  priorityRules: z.array(PriorityRule),
  homePriority: z.number().int().min(1).max(9),
  defaultPriority: z.number().int().min(1).max(9),
  fullBudgetCount: z.number().int().nonnegative(),
});
export type CrawlRules = z.infer<typeof CrawlRules>;

function toRegExp(source: string): RegExp {
  const match = source.match(/^\/(.*)\/([a-z]*)$/);
  if (!match) return new RegExp(source, "i");
  const [, body, flags] = match;
  return new RegExp(body, flags.includes("i") ? flags : flags + "i");
}

/** Compiled view of a ruleset for fast runtime use. */
export interface CompiledCrawlRules {
  raw: CrawlRules;
  ugcSegments: string[];
  datePathRegex: RegExp;
  listingQueryParams: Set<string>;
  nonHtmlExtensions: string[];
  priorityRules: Array<{ regex: RegExp; priority: number }>;
  homePriority: number;
  defaultPriority: number;
  fullBudgetCount: number;
}

export function compileCrawlRules(rules: CrawlRules): CompiledCrawlRules {
  return {
    raw: rules,
    ugcSegments: rules.ugcSegments.map((s) => s.toLowerCase()),
    datePathRegex: toRegExp(rules.datePathRegex),
    listingQueryParams: new Set(rules.listingQueryParams.map((p) => p.toLowerCase())),
    nonHtmlExtensions: rules.nonHtmlExtensions.map((e) => e.toLowerCase()),
    priorityRules: rules.priorityRules.map((r) => ({ regex: toRegExp(r.pattern), priority: r.priority })),
    homePriority: rules.homePriority,
    defaultPriority: rules.defaultPriority,
    fullBudgetCount: rules.fullBudgetCount,
  };
}

/** Load and validate a crawl-rules file. Defaults to the bundled rules. */
export function loadCrawlRules(filePath = path.join(__dirname, "../rules/crawl-priority.yaml")): CompiledCrawlRules {
  const content = readFileSync(filePath, "utf8");
  const parsed = parse(content);
  const rules = CrawlRules.parse(parsed);
  return compileCrawlRules(rules);
}

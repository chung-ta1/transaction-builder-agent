import { z } from "zod";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, fail, ok, type ToolResult } from "../Tool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Path resolves both in src/ and dist/ — file is copied into dist/memory/ at build.
const RULES_PATH_CANDIDATES = [
  join(__dirname, "../../../memory/error-rules.json"),
  join(__dirname, "../../memory/error-rules.json"),
];

interface ErrorRule {
  match: string;
  class: "A" | "B" | "C" | "D";
  field?: string;
  fix: string;
  auto_retry?: { action: string; ms?: number };
}

interface ErrorRulesFile {
  rules: ErrorRule[];
}

let cached: ErrorRule[] | null = null;
async function loadRules(): Promise<ErrorRule[]> {
  if (cached) return cached;
  for (const p of RULES_PATH_CANDIDATES) {
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as ErrorRulesFile;
      cached = parsed.rules;
      return cached;
    } catch { /* try next */ }
  }
  throw new Error(`error-rules.json not found in any of: ${RULES_PATH_CANDIDATES.join(", ")}`);
}

/**
 * Lookup a backend error message against the curated rules. Returns the
 * matching rule (with class A/B/C/D, fix, auto_retry?) or null on no-match.
 * Replaces the 170-line memory/error-messages.md the LLM used to read every
 * turn — now a single tool call when an error actually fires.
 */
export const lookupError = defineTool({
  name: "lookup_error",
  description:
    "Match an arrakis/yenta error string against the curated rules. Returns { matched: rule | null }. Use after any tool call returns ok:false to classify the failure (A=auto-recoverable missing field, B=structural, C=warning, D=transient) and get the plain-English fix + optional auto_retry recipe.",
  input: z.object({
    message: z.string().min(1).describe("The raw error string from the failed tool's error.message or error.body."),
  }),
  async handler({ message }): Promise<ToolResult<{ matched: ErrorRule | null }>> {
    try {
      const rules = await loadRules();
      // Each match string may use "|" to mean OR (alternations).
      for (const rule of rules) {
        for (const alt of rule.match.split("|")) {
          if (message.includes(alt)) return ok({ matched: rule });
        }
      }
      return ok({ matched: null });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

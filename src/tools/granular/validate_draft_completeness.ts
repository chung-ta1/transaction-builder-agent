import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import {
  validateDraft,
  type AddressHistoryEntry,
  type AgentProfile,
  type DraftAnswers,
  type ValidationResult,
} from "../../util/draftRequirements.js";

/**
 * Server-side validator. Given the user's prompt + accumulated answers,
 * returns the structured gap/defaults/blockers list the runbook should act on.
 *
 *   - `gaps`         hard fields needing AskUserQuestion (each pre-written)
 *   - `softGaps`     fields fine to skip on create; surface post-create
 *   - `defaults`     filled silently — surface in parse summary with `~`
 *   - `blockers`     hard stops; do NOT call any write tool
 *
 * Pass `addressHistory` from `memory/user-patterns.md:address_history` so
 * repeat-property drafts auto-fill yearBuilt / MLS without asking.
 */
export const validateDraftCompleteness = defineTool({
  name: "validate_draft_completeness",
  description:
    "Validate the in-progress answers blob. Returns { ready, gaps, softGaps, defaults, blockers }. Call before any AskUserQuestion: gaps = pre-written questions to ask, defaults = silent fills (surface with `~`), softGaps = post-create only, blockers = STOP. Pass addressHistory + agentProfile to enable silent defaults.",
  input: z.object({
    env: envSchema,
    userPrompt: z.string().min(1),
    answers: z
      .any()
      .describe(
        "Partial DraftAnswers snapshot. Shape (all fields optional): { address: { street, city, state, zip, country, yearBuilt, mlsNumber }, deal: { dealType, salePrice, propertyType, representationType, saleCommission, listingCommission, acceptanceDate, closingDate }, sellers: [...], buyers: [...], owner: { yentaId, officeId, teamId }, partners: [...], referral, otherSideAgent, payer, hasActiveListing }",
      )
      .default({}),
    addressHistory: z
      .array(z.object({
        key: z.string(),
        yearBuilt: z.number().int().optional(),
        lastMlsNumber: z.string().optional(),
        teamId: z.string().optional(),
        lastUsed: z.string().optional(),
        useCount: z.number().int().optional(),
      }))
      .optional()
      .describe("Per-address cache from memory/user-patterns.md:address_history. When the prompt's address matches, the validator silently fills yearBuilt + MLS."),
    agentProfile: z
      .object({
        yentaId: z.string().optional(),
        country: z.string().optional(),
        agentStatus: z.string().optional(),
        officeId: z.string().optional(),
        teamId: z.string().optional(),
        teams: z.array(z.object({
          teamId: z.string(),
          name: z.string(),
          teamType: z.string().optional(),
          flex: z.boolean().optional(),
        })).optional(),
      })
      .optional()
      .describe("Pass `pre_flight.auth.user` straight through. The validator seeds owner.yentaId/officeId/teamId silently; single-team users skip the team question; CANDIDATE/INACTIVE status produces a blocker."),
  }),
  async handler(args): Promise<ToolResult<ValidationResult>> {
    // MCP clients sometimes JSON-stringify loosely-typed params (`answers` is
    // z.any()). If we don't parse it back, `validateDraft` does `structuredClone`
    // + `a.deal ??= {}` on a string and throws "Cannot create property 'deal'
    // on string". Coerce any stringified object/array input first.
    const answers = (coerceJson(args.answers) ?? {}) as DraftAnswers;
    const addressHistory = coerceJson(args.addressHistory) as AddressHistoryEntry[] | undefined;
    const agentProfile = coerceJson(args.agentProfile) as AgentProfile | undefined;
    const result = validateDraft({
      env: args.env,
      userPrompt: args.userPrompt,
      answers,
      addressHistory,
      agentProfile,
    });
    return ok(result);
  },
});

/**
 * Coerce a possibly-JSON-stringified value back to an object/array. MCP
 * clients may stringify untyped (`z.any()`) params; returns the parsed value,
 * the value unchanged if already an object, or undefined for null/garbage.
 */
function coerceJson(v: unknown): unknown {
  if (v == null) return undefined;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return v;
}

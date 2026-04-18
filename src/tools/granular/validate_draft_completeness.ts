import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import {
  validateDraft,
  type DraftAnswers,
  type ValidationResult,
} from "../../util/draftRequirements.js";

/**
 * Server-side validator. Given the user's prompt + whatever answers Claude has
 * collected so far, returns the structured gap/defaults/blockers list Claude
 * should act on:
 *
 *   - `gaps`: Fields Claude must ask via `AskUserQuestion`. Each carries a
 *     pre-written question + options.
 *   - `defaults`: Fields the validator filled in silently (e.g. seller =
 *     "Unknown Seller" for buyer-side). Claude should surface these in the
 *     parse summary so the user can correct before the draft is written.
 *   - `blockers`: Hard stops. If non-empty, the flow halts — do NOT call
 *     `create_draft_with_essentials` or any other arrakis write tool.
 *
 * The `ready: true` signal means Claude can proceed to commission-math
 * (step 7 of the runbook) without asking anything else.
 *
 * The validator is PURE — no arrakis or yenta calls. It uses
 * `memory/bolt-field-matrix.md` as the source-of-truth rule matrix, compiled
 * into `src/util/draftRequirements.ts`. When Bolt adds a new required field,
 * update both files together.
 */
export const validateDraftCompleteness = defineTool({
  name: "validate_draft_completeness",
  description:
    "Check whether the accumulated draft answers are complete enough to submit. Returns { ready, gaps, defaults, blockers }. Call this AFTER parsing the user prompt but BEFORE asking any clarifying question — gaps tells you exactly which AskUserQuestion calls to make; defaults tells you what's been auto-populated (surface in parse summary); blockers means STOP (e.g., seller-side deals without an active listing). When ready=true and blockers=[], proceed to commission math + draft creation.",
  input: z.object({
    env: envSchema,
    userPrompt: z.string().min(1),
    answers: z
      .any()
      .describe(
        "Partial DraftAnswers snapshot. Shape (all fields optional): { address: { street, city, state, zip, country, yearBuilt, mlsNumber }, deal: { dealType, salePrice, propertyType, representationType, saleCommission, listingCommission, acceptanceDate, closingDate }, sellers: [...], buyers: [...], owner: { yentaId, officeId, teamId }, partners: [...], referral, otherSideAgent, payer, hasActiveListing }",
      )
      .default({}),
  }),
  async handler(args): Promise<ToolResult<ValidationResult>> {
    const answers = (args.answers ?? {}) as DraftAnswers;
    const result = validateDraft({
      env: args.env,
      userPrompt: args.userPrompt,
      answers,
    });
    return ok(result);
  },
});

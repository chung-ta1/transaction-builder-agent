import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import {
  additionalFeesSchema,
  envSchema,
  fmlsInfoSchema,
  personalDealInfoSchema,
  titleInfoSchema,
} from "../../types/schemas.js";
import { fromError } from "./init.js";

/**
 * Set the four finalize-flag subsections in one call. Each is optional;
 * only the supplied subsections are PUT to arrakis. Replaces four separate
 * tools (update_personal_deal_info, update_additional_fees_info,
 * update_title_info, update_fmls_info).
 *
 * Common no-op call before submit:
 *   { personalDeal: { personalDeal: false, representedByAgent: true },
 *     additionalFees: { hasAdditionalFees: false, additionalFeesParticipantInfos: [] },
 *     title: { useRealTitle: false } }
 * (FMLS only matters in Georgia.)
 */
export const setFinalizeFlags = defineTool({
  name: "set_finalize_flags",
  description:
    "Set finalize-flag subsections on the draft (any subset). personalDeal+representedByAgent for the personal-deal flag; additionalFees for fee line items; title for use-Real-Title; fmls for the Georgia-only FMLS flag. Only the supplied subsections are PUT.",
  input: z.object({
    env: envSchema,
    builderId: z.string(),
    personalDeal: personalDealInfoSchema.optional(),
    additionalFees: additionalFeesSchema.optional(),
    title: titleInfoSchema.optional(),
    fmls: fmlsInfoSchema.optional(),
  }),
  async handler({ env, builderId, personalDeal, additionalFees, title, fmls }, { arrakis }): Promise<ToolResult<unknown>> {
    const calls: Array<Promise<unknown>> = [];
    if (personalDeal) calls.push(arrakis.updatePersonalDealInfo(env, builderId, personalDeal));
    if (additionalFees) calls.push(arrakis.updateAdditionalFees(env, builderId, additionalFees));
    if (title) calls.push(arrakis.updateTitleInfo(env, builderId, title));
    if (fmls) calls.push(arrakis.updateFmlsInfo(env, builderId, fmls));
    try {
      const results = await Promise.all(calls);
      return ok({ applied: results.length, results });
    } catch (err) {
      return fromError(err);
    }
  },
});

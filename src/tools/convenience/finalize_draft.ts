import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import {
  addParticipantRequestSchema,
  commissionPayerInfoSchema,
  envSchema,
} from "../../types/schemas.js";
import { buildDraftUrl } from "../../config.js";
import { fromError } from "../granular/init.js";

/**
 * Runs the mandatory "no-op" plumbing arrakis needs before a builder is
 * submittable:
 *   - set opcity(false)                       (finalizes participants)
 *   - personal-deal-info {false, true}        (both NotNull)
 *   - additional-fees-info {false, []}
 *   - (optional) add commission-payer participant + set commission-payer
 *   - title-info {useRealTitle: false}
 *   - (Georgia only) fmls-info
 *
 * Commission payer is OPTIONAL. arrakis's `TransactionBuilder.validate()` has
 * its payer-presence check commented out (line ~644 —
 * "ignore this for now until we remove skyslope"), meaning drafts save fine
 * without one. Meanwhile `CommissionPayerInfoRequestValidator` REQUIRES all
 * six fields (role + firstName + lastName + companyName + email + phone) when
 * creating a new payer participant — so passing a partial "TBD" payload
 * FAILS bean validation. Safe behavior: when the user hasn't provided full
 * payer info, omit `commissionPayerParticipant`; Bolt's "I Don't Have The
 * Information Yet" UI lets the user fill in the payer after opening the
 * draft. The validator's `requireCommissionPayer` rule already defaults the
 * payer to `null` in this case.
 */
export const finalizeDraft = defineTool({
  name: "finalize_draft",
  description:
    "Run the required end-of-flow calls in one shot: opcity(false), personal-deal, additional-fees(empty), title-info(useRealTitle:false), and (Georgia) fmls. Also sets commission-payer WHEN provided — omit it when the user doesn't have full title/lawyer info (role + firstName + lastName + companyName + email + phone). arrakis accepts a null payer at submit; user fills it in Bolt post-draft. Returns the bolt draftUrl.",
  input: z.object({
    env: envSchema,
    builderId: z.string(),
    /**
     * OPTIONAL. Omit when user lacks full payer info — arrakis won't reject
     * a null payer, and partial info (e.g. companyName only) DOES fail
     * CommissionPayerInfoRequestValidator. See tool description.
     */
    commissionPayerParticipant: addParticipantRequestSchema.optional(),
    commissionPayer: commissionPayerInfoSchema
      .pick({ role: true, participantId: true })
      .partial({ role: true })
      .optional(),
    fmls: z.object({ propertyListedOnFmls: z.boolean() }).optional(),
  }),
  async handler(args, { arrakis }): Promise<ToolResult<{ draftUrl: string; payerSet: boolean }>> {
    const { env, builderId, commissionPayerParticipant, commissionPayer, fmls } = args;
    try {
      await arrakis.setOpcity(env, builderId, false);
      await arrakis.updatePersonalDealInfo(env, builderId, {
        personalDeal: false,
        representedByAgent: true,
      });
      await arrakis.updateAdditionalFees(env, builderId, {
        hasAdditionalFees: false,
        additionalFeesParticipantInfos: [],
      });

      // Commission payer: only wire when we have SOMETHING to wire (either an
      // existing participantId or a full payer participant payload). Otherwise
      // skip — see tool doc for why.
      let payerSet = false;
      if (commissionPayer?.participantId) {
        await arrakis.setCommissionPayer(env, builderId, {
          participantId: commissionPayer.participantId,
          role: commissionPayer.role ?? commissionPayerParticipant?.role,
        });
        payerSet = true;
      } else if (commissionPayerParticipant) {
        const created = (await arrakis.addOtherParticipant(
          env,
          builderId,
          commissionPayerParticipant,
        )) as { id?: string } | undefined;
        const payerId = created?.id ?? "";
        if (payerId) {
          await arrakis.setCommissionPayer(env, builderId, {
            participantId: payerId,
            role: commissionPayer?.role ?? commissionPayerParticipant.role,
          });
          payerSet = true;
        }
      }

      await arrakis.updateTitleInfo(env, builderId, { useRealTitle: false });

      if (fmls) {
        await arrakis.updateFmlsInfo(env, builderId, fmls);
      }

      return ok({ draftUrl: buildDraftUrl(env, builderId), payerSet });
    } catch (err) {
      return fromError(err);
    }
  },
});

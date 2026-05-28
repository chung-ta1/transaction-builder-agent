import { z } from "zod";
import { defineTool, fail, ok, type ToolResult } from "../Tool.js";
import { commissionSplitsArraySchema, envSchema, participantRoleSchema } from "../../types/schemas.js";
import { diffSplits, extractCommittedSplits } from "../../math/verifySplits.js";
import { fromError } from "./init.js";

export const setOpcity = defineTool({
  name: "set_opcity",
  description:
    "Set the realtor.com / opcity flag. MUST run (even with false) before set_commission_splits — arrakis uses this to finalize participants.",
  input: z.object({ env: envSchema, builderId: z.string(), opcity: z.boolean().default(false) }),
  async handler({ env, builderId, opcity }, { arrakis }): Promise<ToolResult<unknown>> {
    try { return ok(await arrakis.setOpcity(env, builderId, opcity)); } catch (err) { return fromError(err); }
  },
});

/**
 * Write commission splits to arrakis, optionally re-fetching the draft and
 * verifying the committed splits match what was sent (the G5 mandate). The
 * verify pass is the previous standalone `verify_draft_splits` tool, folded
 * in as a flag — the runbook ALWAYS pairs them, so two tools created drift
 * risk.
 *
 *   verify: false (default) → write only.
 *   verify: true            → write, then refetch + diff. Any drift fails the
 *                              call with code SPLITS_DRIFT.
 */
export const setCommissionSplits = defineTool({
  name: "set_commission_splits",
  description:
    "Write commission splits. Pass verify=true to refetch and diff after write (G5 mandate; fails SPLITS_DRIFT on mismatch). Percents are of post-referral pool; must sum to 100. DUAL: ≥1 agent on both sides.",
  input: z.object({
    env: envSchema,
    builderId: z.string(),
    splits: commissionSplitsArraySchema.refine((s) => s.length >= 1, "at least one split required"),
    verify: z.boolean().default(false).describe("Re-fetch the draft after write and diff committed splits against `splits`. Required for the G5 post-write verification gate."),
  }),
  async handler({ env, builderId, splits, verify }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      const result = await arrakis.updateCommissionSplits(env, builderId, splits);
      if (!verify) return ok(result);
      const draft = await arrakis.getDraft(env, builderId);
      const committed = extractCommittedSplits(draft);
      const sent = splits.map((s) => ({
        participantId: s.participantId,
        percent: s.commission.commissionPercent ?? s.commission.commissionAmount?.amount ?? "0",
      }));
      const diff = diffSplits(sent, committed);
      if (!diff.ok) {
        return fail(`Draft splits did not match what was sent: ${diff.issues.join("; ")}`,
          { code: "SPLITS_DRIFT", body: diff });
      }
      return ok({ written: result, verified: diff });
    } catch (err) {
      return fromError(err);
    }
  },
});

/**
 * Wire the commission payer in one call: creates the payer participant and
 * points the draft at it. The runbook used to call
 * add_commission_payer_participant + set_commission_payer separately; merging
 * them removes the chance of half-wiring.
 *
 * Requires all 6 fields — arrakis's CommissionPayerInfoRequestValidator
 * rejects partial input. If the user doesn't have full info, skip this tool —
 * but note submit does NOT silently accept a null payer: it succeeds yet parks
 * the transaction in NEW with a CRITICAL "Commission Payer information is
 * missing" until the payer is added (here or in Bolt). Surface that as the one
 * expected post-submit step, not a failure.
 */
export const wireCommissionPayer = defineTool({
  name: "wire_commission_payer",
  description:
    "Create + wire the commission-payer participant in one call. Requires all 6 fields (role, first, last, company, email, phone) — partial input fails arrakis's bean validator. Skip if info is incomplete, but note submit does NOT silently accept a null payer: it succeeds yet leaves the transaction in NEW with a CRITICAL 'Commission Payer information is missing' until the payer is added (here or in Bolt). Roles: US sale=TITLE, Canada=SELLERS_LAWYER, Lease=LANDLORD/TENANT/MANAGEMENT_COMPANY.",
  input: z.object({
    env: envSchema, builderId: z.string(),
    role: participantRoleSchema, firstName: z.string().min(1), lastName: z.string().min(1),
    companyName: z.string().min(1), email: z.string().email(), phoneNumber: z.string().min(1),
    address: z.string().optional(),
    receivesInvoice: z.boolean().optional(),
  }),
  async handler(args, { arrakis }): Promise<ToolResult<unknown>> {
    const { env, builderId, ...participant } = args;
    try {
      const created = await arrakis.addOtherParticipant(env, builderId, participant);
      const participantId = (created as { id?: string })?.id;
      if (!participantId) throw new Error("arrakis did not return a participantId for the payer");
      return ok(await arrakis.setCommissionPayer(env, builderId, {
        ...participant, participantId,
      }));
    } catch (err) {
      return fromError(err);
    }
  },
});

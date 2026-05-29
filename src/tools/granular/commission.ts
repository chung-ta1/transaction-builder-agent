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
      // addOtherParticipant returns the whole updated DRAFT, whose top-level
      // `id` is the builderId — NOT the new participant. Using `created.id`
      // here set the payer's participantId to the builderId, a broken
      // self-reference that 500s at submit (verified 2026-05-29). Find the
      // participant we just created inside the returned draft instead.
      const draft = await arrakis.addOtherParticipant(env, builderId, participant);
      const participantId = findCreatedParticipantId(draft, participant, builderId);
      if (!participantId) throw new Error("could not locate the created commission-payer participant in the draft response");
      return ok(await arrakis.setCommissionPayer(env, builderId, {
        ...participant, participantId,
      }));
    } catch (err) {
      return fromError(err);
    }
  },
});

/**
 * Locate the participant just created by addOtherParticipant inside the
 * returned draft. The draft lists participants under `otherParticipants` (and
 * `allParticipants`); match on role + email (the identifying fields we sent),
 * exclude the builderId itself, and prefer the most-recently-created match.
 */
export function findCreatedParticipantId(
  draft: unknown,
  participant: { role: string; email: string },
  builderId: string,
): string | undefined {
  if (!draft || typeof draft !== "object") return undefined;
  const d = draft as Record<string, unknown>;
  const pools = [d.otherParticipants, d.allParticipants].filter(Array.isArray) as Array<Record<string, unknown>>[];
  const matches = pools
    .flat()
    .filter((p) => p && typeof p === "object")
    .filter((p) => p.id && p.id !== builderId)
    .filter((p) => p.role === participant.role && p.email === participant.email);
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  return matches[0].id as string;
}

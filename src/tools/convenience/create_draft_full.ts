import { z } from "zod";
import { defineTool, fail, ok, type ToolResult } from "../Tool.js";
import {
  additionalFeesSchema,
  agentParticipantInfoSchema,
  buyerSellerSchema,
  commissionSplitsArraySchema,
  envSchema,
  fmlsInfoSchema,
  locationInfoSchema,
  ownerAgentInfoSchema,
  personalDealInfoSchema,
  priceAndDatesSchema,
  titleInfoSchema,
} from "../../types/schemas.js";
import { ApiError } from "../../services/BaseApi.js";
import { buildDraftUrl } from "../../config.js";

/**
 * One-call orchestrator for the happy-path create flow. Replaces 12+ sequential
 * MCP tool calls with one server-side run. Subsection writes are issued
 * STRICTLY SEQUENTIALLY — arrakis intermittently 400s ("Invalid request") on
 * concurrent PUTs to the same draft, so reliability is chosen over the ~1s a
 * parallel fan-out would save.
 *
 * Pure orchestration glue. NO business logic:
 *   - No commission math (caller pre-computes via compute_commission_splits)
 *   - No DUAL twice-registration (caller passes each agent twice with different sides)
 *   - No validation (caller validates via validate_draft_completeness first)
 *
 * Still a single caller round-trip (vs issuing the granular chain tool-by-tool);
 * the server-side section writes themselves run sequentially (~2–3s).
 *
 * Failure handling: if any required write fails, the partial builderId is
 * returned in `error.body.builderId` so the caller can offer /resume-draft
 * or /delete-draft.
 */
export const createDraftFull = defineTool({
  name: "create_draft_full",
  description:
    "Happy-path one-shot: creates a draft and runs every subsection write server-side in dependency-safe SEQUENTIAL order (arrakis rejects concurrent writes to one draft). Use AFTER `validate_draft_completeness` returns ready=true and AFTER `compute_commission_splits` has finalized the splits (with the G2b confirm gate when renormalized). Returns { builderId, draftUrl, applied[], skippedSections[], warnings[] }. On partial failure: returns the builderId of the partial draft so /resume-draft can pick it up.",
  input: z.object({
    env: envSchema,
    type: z.enum(["TRANSACTION", "LISTING"]).default("TRANSACTION"),
    transactionOwnerId: z.string().uuid().describe("The owning agent's yentaId."),
    callerYentaId: z.string().uuid().optional()
      .describe("The authenticated caller's yentaId (from pre_flight.auth.user.yentaId). When it equals transactionOwnerId, the explicit set_transaction_owner step is SKIPPED — arrakis already sets owner = caller on create, and a redundant re-set 403s on the not-yet-committed builder. Pass it on every self-owned create; omit only for on-behalf-of (owner ≠ caller), where the explicit set is required."),
    location: locationInfoSchema.optional(),
    priceAndDates: priceAndDatesSchema.optional(),
    buyerSeller: buyerSellerSchema.optional(),
    owner: ownerAgentInfoSchema.optional(),
    coAgents: z.array(agentParticipantInfoSchema).optional()
      .describe("Co-agents on the same side as the owner. For DUAL representation, pass each agent TWICE — once with role=BUYERS_AGENT, once with role=SELLERS_AGENT — the tool does not synthesize that for you."),
    opcity: z.boolean().default(false)
      .describe("realtor.com / opcity flag. Always required (even false) before set_commission_splits."),
    commissionSplits: commissionSplitsArraySchema.optional()
      .describe("Pre-computed splits from compute_commission_splits. Required for TRANSACTION (listings skip this)."),
    finalize: z.object({
      personalDeal: personalDealInfoSchema.optional(),
      additionalFees: additionalFeesSchema.optional(),
      title: titleInfoSchema.optional(),
      fmls: fmlsInfoSchema.optional(),
    }).optional()
      .describe("Finalize-flag subsections. Common no-op: { personalDeal: {personalDeal:false,representedByAgent:true}, additionalFees: {hasAdditionalFees:false,additionalFeesParticipantInfos:[]}, title: {useRealTitle:false} }. FMLS only matters in Georgia."),
  }),
  async handler(args, { arrakis }): Promise<ToolResult<{
    builderId: string;
    draftUrl: string;
    applied: string[];
    skippedSections: string[];
    warnings: string[];
  }>> {
    const { env, type, transactionOwnerId } = args;
    const applied: string[] = [];
    const skippedSections: string[] = [];
    const warnings: string[] = [];

    let builderId: string;
    try {
      // Phase A: create. arrakis's POST /transaction-builder already sets
      // owner = the authenticated caller (TransactionBuilderService
      // .createEmptyTransactionBuilder → setTransactionOwner). So an explicit
      // re-set is only needed for on-behalf-of (owner ≠ caller). When owner ==
      // caller, re-setting races the not-yet-committed builder and the
      // authorize() check 403s (verified 2026-05-27 against team1: redundant
      // PATCH /transaction-owner returned 403 "Not authorized" on a builder
      // whose create had not settled). Skip the redundant call.
      builderId = await arrakis.initializeDraft(env, type);
      applied.push("create_draft");
      const ownerIsCaller = args.callerYentaId !== undefined
        && args.callerYentaId === transactionOwnerId;
      if (!ownerIsCaller) {
        await arrakis.setTransactionOwner(env, builderId, transactionOwnerId);
        applied.push("set_transaction_owner");
      } else {
        skippedSections.push("set_transaction_owner (owner already set by create — owner == caller)");
      }
    } catch (err) {
      return toFail(err, undefined, applied, skippedSections);
    }

    try {
      // Phase B: section writes run STRICTLY SEQUENTIALLY. arrakis does not
      // safely handle concurrent PUTs to the same draft — two simultaneous
      // section writes intermittently 400 with a generic "Invalid request"
      // (a server-side read-modify-write / version conflict on the builder doc).
      // Parallel versions raced non-deterministically: different sections failed
      // on different runs (price-date, then owner, then buyer-seller). Reliability
      // beats the ~1s a fan-out saves, so every write is serialized. Order also
      // honors the address dependency: location must commit before price-date and
      // owner; co-agents follow the owner (granular chain owner → add_participant).
      if (args.location) {
        await arrakis.updateLocationInfo(env, builderId, args.location);
        applied.push("location");
      } else {
        skippedSections.push("location");
      }
      if (args.priceAndDates) {
        await arrakis.updatePriceAndDateInfo(env, builderId, args.priceAndDates);
        applied.push("price-date");
      } else {
        skippedSections.push("price-date");
      }
      if (args.buyerSeller) {
        await arrakis.updateBuyerAndSellerInfo(env, builderId, args.buyerSeller);
        applied.push("buyer-seller");
      } else {
        skippedSections.push("buyer-seller");
      }
      if (args.owner) {
        await arrakis.updateOwnerAgentInfo(env, builderId, args.owner);
        applied.push("owner");
      } else {
        skippedSections.push("owner");
      }
      for (const ca of args.coAgents ?? []) {
        await arrakis.addCoAgent(env, builderId, ca);
        applied.push(`co_agent:${ca.agentId.slice(0, 8)}`);
      }
    } catch (err) {
      return toFail(err, builderId, applied, skippedSections);
    }

    try {
      // Phase C: commission chain. set_opcity must precede set_commission_splits
      // (arrakis uses set_opcity to finalize participants).
      await arrakis.setOpcity(env, builderId, args.opcity);
      applied.push("set_opcity");
      if (args.commissionSplits && args.commissionSplits.length > 0) {
        await arrakis.updateCommissionSplits(env, builderId, args.commissionSplits);
        applied.push("set_commission_splits");
      } else if (type === "TRANSACTION") {
        warnings.push("commissionSplits omitted; draft will fail submit until set via /update-draft.");
      }
    } catch (err) {
      return toFail(err, builderId, applied, skippedSections);
    }

    try {
      // Phase D: finalize-flag subsections — also serialized (same concurrent-
      // write hazard as Phase B; a parallel fan-out could intermittently drop a
      // finalize write, e.g. additionalFees).
      if (args.finalize) {
        if (args.finalize.personalDeal) {
          await arrakis.updatePersonalDealInfo(env, builderId, args.finalize.personalDeal);
          applied.push("finalize:personalDeal");
        }
        if (args.finalize.additionalFees) {
          await arrakis.updateAdditionalFees(env, builderId, args.finalize.additionalFees);
          applied.push("finalize:additionalFees");
        }
        if (args.finalize.title) {
          await arrakis.updateTitleInfo(env, builderId, args.finalize.title);
          applied.push("finalize:title");
        }
        if (args.finalize.fmls) {
          await arrakis.updateFmlsInfo(env, builderId, args.finalize.fmls);
          applied.push("finalize:fmls");
        }
      }
    } catch (err) {
      return toFail(err, builderId, applied, skippedSections);
    }

    return ok({ builderId, draftUrl: buildDraftUrl(env, builderId), applied, skippedSections, warnings });
  },
});

function toFail(
  err: unknown,
  builderId: string | undefined,
  applied: string[],
  skippedSections: string[],
): ToolResult<never> {
  const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
  const status = err instanceof ApiError ? err.status : undefined;
  const arrakisBody = err instanceof ApiError ? err.body : undefined;
  return fail(message, {
    status,
    body: { builderId, applied, skippedSections, arrakisBody },
  });
}

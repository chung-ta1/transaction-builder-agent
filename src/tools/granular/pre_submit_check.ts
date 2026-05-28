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
import { fromError } from "./init.js";

/**
 * Run the same validator that gates create — but against the live arrakis
 * draft state. Catches drift between when we last wrote the draft and now
 * (user may have edited in Bolt, splits may have been removed, etc.).
 *
 * The runbook for /submit-draft calls this BEFORE submit_draft. If anything
 * is missing, the runbook batches the gaps into AskUserQuestion (≤4 per
 * call), applies fixes via update_draft_section (or other writers), then
 * fires submit_draft.
 */
export const preSubmitCheck = defineTool({
  name: "pre_submit_check",
  description:
    "Run the validator against the LIVE arrakis draft state (not the in-memory answers). Returns { ready, gaps, softGaps, defaults, blockers, note }. Call BEFORE submit_draft to batch-catch missing fields in one ask cycle (avoiding the sequential-failure trap where the user fixes one field, submits, fails on the next, repeats). Pass addressHistory + agentProfile to enable silent defaults.",
  input: z.object({
    env: envSchema,
    builderId: z.string(),
    addressHistory: z
      .array(z.object({
        key: z.string(),
        yearBuilt: z.number().int().optional(),
        lastMlsNumber: z.string().optional(),
        teamId: z.string().optional(),
        lastUsed: z.string().optional(),
        useCount: z.number().int().optional(),
      }))
      .optional(),
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
      .optional(),
  }),
  async handler({ env, builderId, addressHistory, agentProfile }, { arrakis }): Promise<ToolResult<ValidationResult & { note: string[] }>> {
    try {
      const draft = await arrakis.getDraft(env, builderId);
      const answers = draftToAnswers(draft);
      const note = collectExtraNotes(draft);
      const result = validateDraft({
        env,
        userPrompt: `pre-submit check for builder ${builderId}`,
        answers,
        addressHistory: addressHistory as AddressHistoryEntry[] | undefined,
        agentProfile: agentProfile as AgentProfile | undefined,
      });
      return ok({ ...result, note });
    } catch (err) {
      return fromError(err);
    }
  },
});

/**
 * Coerce arrakis's loose draft response into the DraftAnswers shape the
 * validator expects. Best-effort: missing fields stay undefined and surface
 * as gaps. Field names mirror arrakis DTOs.
 */
function draftToAnswers(draft: unknown): DraftAnswers {
  if (!draft || typeof draft !== "object") return {};
  const d = draft as Record<string, unknown>;
  const addr = (d.address ?? d.addressInfo ?? {}) as Record<string, unknown>;
  const price = (d.priceAndDateInfo ?? d.priceAndDates ?? {}) as Record<string, unknown>;
  const bs = (d.buyerAndSellerInfo ?? d.buyersAndSellers ?? {}) as Record<string, unknown>;
  const own = (d.ownerInfo ?? d.ownerAgentInfo ?? {}) as Record<string, unknown>;

  const out: DraftAnswers = {};
  out.address = {
    street: asString(addr.street),
    city: asString(addr.city),
    state: asString(addr.state),
    zip: asString(addr.zip),
    country: (asString(addr.country) === "UNITED_STATES" || asString(addr.country) === "CANADA")
      ? (addr.country as "UNITED_STATES" | "CANADA")
      : undefined,
    yearBuilt: typeof addr.yearBuilt === "number" ? addr.yearBuilt : undefined,
    mlsNumber: asString(addr.mlsNumber),
  };
  out.deal = {
    dealType: asEnum(price.dealType, ["SALE", "LEASE", "REFERRAL", "COMPENSATING", "COMMERCIAL_LEASE", "PLOT", "OTHER", "INTERNAL_REFERRAL"] as const),
    salePrice: price.salePrice as { amount: string; currency: "USD" | "CAD" } | undefined,
    propertyType: asEnum(price.propertyType, ["RESIDENTIAL", "COMMERCIAL", "LAND_LOT", "CONDO", "MOBILE_HOME", "NEW_CONSTRUCTION"] as const),
    representationType: asEnum(price.representationType, ["SELLER", "BUYER", "DUAL", "LANDLORD", "TENANT"] as const),
    saleCommission: price.saleCommission as { kind: "percent" | "amount"; value: string } | undefined,
    listingCommission: price.listingCommission as { kind: "percent" | "amount"; value: string } | undefined,
    acceptanceDate: asString(price.acceptanceDate),
    closingDate: asString(price.closingDate),
  };
  if (Array.isArray(bs.sellers)) out.sellers = bs.sellers as DraftAnswers["sellers"];
  if (Array.isArray(bs.buyers)) out.buyers = bs.buyers as DraftAnswers["buyers"];
  out.owner = {
    yentaId: asString(own.yentaId ?? (own.ownerAgent as Record<string, unknown> | undefined)?.agentId),
    officeId: asString(own.officeId),
    teamId: asString(own.teamId),
  };
  return out;
}

/** Surface non-blocking but worth-knowing facts about the draft. */
function collectExtraNotes(draft: unknown): string[] {
  const notes: string[] = [];
  if (!draft || typeof draft !== "object") return notes;
  const d = draft as Record<string, unknown>;
  const price = (d.priceAndDateInfo ?? d.priceAndDates ?? {}) as Record<string, unknown>;
  if (price.requiresInstallments === true) {
    notes.push("requiresInstallments=true → installment schedule must be defined post-submit via upsert_installments");
  }
  const splits = d.commissionSplitsInfo;
  if (Array.isArray(splits) && splits.length === 0) {
    notes.push("commissionSplitsInfo is empty — submit will fail unless splits are written first");
  }
  const lifecycle = (d.lifecycleState ?? {}) as Record<string, unknown>;
  const state = asString(lifecycle.state);
  if (state && !["NEW", "DRAFT"].includes(state)) {
    notes.push(`lifecycleState.state = ${state} (not a fresh draft — may already be submitted)`);
  }
  const dealType = asString(price.dealType);
  const needsPayer = dealType !== "REFERRAL" && dealType !== "INTERNAL_REFERRAL";
  if (needsPayer && d.commissionPayerInfo == null) {
    notes.push("commissionPayerInfo is missing — submit will SUCCEED but the transaction lands in NEW with a CRITICAL 'Commission Payer information is missing' until the payer is added (wire_commission_payer or in Bolt). Expected; surface it, don't treat it as a failure.");
  }
  return notes;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asEnum<T extends string>(v: unknown, valid: readonly T[]): T | undefined {
  return typeof v === "string" && (valid as readonly string[]).includes(v) ? (v as T) : undefined;
}

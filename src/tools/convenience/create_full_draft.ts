import { z } from "zod";
import { defineTool, fail, ok, type ToolResult } from "../Tool.js";
import {
  buyerSellerSchema,
  envSchema,
  fmlsInfoSchema,
  locationInfoSchema,
  moneyValueSchema,
  priceAndDatesSchema,
} from "../../types/schemas.js";
import {
  computeCommissionSplits,
  dollarsToCents,
  CommissionMathError,
} from "../../math/commissionSplits.js";
import {
  diffSplits,
  extractCommittedSplits,
} from "../../math/verifySplits.js";
import { buildDraftUrl } from "../../config.js";
import { ApiError } from "../../services/BaseApi.js";

/**
 * Consolidated happy-path: arrakis's full transaction/listing create sequence
 * in a single MCP call. Replaces the 7-step Claude orchestration of
 * create_draft_with_essentials → add_partner_agent × N → add_referral →
 * compute_commission_splits → set_commission_splits → verify_draft_splits →
 * finalize_draft with one server-side sequence.
 *
 * Claude still owns policy (parsing, gap analysis, G2 interpretation gate,
 * type-to-confirm, preview, audit log). Workflow (writes, participant-id
 * plumbing, post-write verification) lives here in code.
 *
 * Failure model: returns {ok:false, error:{code, body:{builderId, completedSteps,
 * nextStage}}}. When builderId is present the caller can offer /resume-draft or
 * /delete-draft. No auto-retry — the caller decides.
 *
 * Scope: single-rep (BUYER, SELLER, TENANT, LANDLORD) transactions and
 * listings. DUAL representation falls back to the granular chain.
 */

const STAGES = [
  "initialize",
  "location",
  "price_dates",
  "buyer_seller",
  "owner",
  "partners",
  "referral",
  "resolve_participants",
  "compute_splits",
  "set_splits",
  "verify_splits",
  "finalize",
] as const;

type Stage = typeof STAGES[number];

const partnerSchema = z.object({
  kind: z.literal("internal"),
  agentId: z.string().uuid(),
  ratio: z
    .number()
    .positive()
    .describe("Partner's raw ratio in the agent split (e.g. 40 for 'me 60 / partner 40')."),
  side: z
    .enum(["BUYERS_AGENT", "SELLERS_AGENT", "TENANT_AGENT"])
    .optional()
    .describe("Override the inferred side. Default matches the owner's side."),
  receivesInvoice: z.boolean().default(false),
});

const referralSchema = z
  .object({
    kind: z.enum(["internal", "external"]),
    percent: z
      .number()
      .min(0)
      .max(99.99)
      .describe("Referral's off-the-top percent of gross (0 ≤ x < 100)."),
    agentId: z.string().uuid().optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    companyName: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    ein: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phoneNumber: z.string().optional(),
    vendorDirectoryId: z.string().uuid().optional(),
    w9FilePath: z.string().optional(),
    receivesInvoice: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "internal" && !v.agentId) {
      ctx.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "agentId required for internal referral",
      });
    }
    if (v.kind === "external") {
      for (const f of ["firstName", "lastName", "companyName", "address"] as const) {
        if (!v[f])
          ctx.addIssue({
            code: "custom",
            path: [f],
            message: `${f} required for external referral`,
          });
      }
    }
  });

const commissionPayerShape = z.object({
  role: z.enum([
    "TITLE",
    "SELLERS_LAWYER",
    "BUYERS_LAWYER",
    "OTHER_AGENT",
    "LANDLORD",
    "TENANT",
    "MANAGEMENT_COMPANY",
  ]),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  companyName: z.string().min(1),
  email: z.string().email(),
  phoneNumber: z.string().min(1),
});

export const createFullDraft = defineTool({
  name: "create_full_draft",
  description:
    "End-to-end draft creation in ONE MCP round-trip. Sequences arrakis writes server-side (create → location → price/dates → buyer+seller → owner → partners → referral → compute splits → set splits → verify → finalize) and returns { builderId, draftUrl, splits, participants, renormalized }. On mid-chain failure, returns { ok:false, error:{ stage, builderId, completedSteps } } so the caller can offer /resume-draft or /delete-draft. Covers single-rep transactions (BUYER, SELLER, TENANT, LANDLORD) and listings. DUAL rep falls back to the granular tool chain.",
  input: z.object({
    env: envSchema,
    type: z.enum(["TRANSACTION", "LISTING"]).default("TRANSACTION"),
    owner: z.object({
      yentaId: z.string().uuid(),
      officeId: z.string().uuid(),
      teamId: z.string().uuid().optional(),
      ratio: z
        .number()
        .positive()
        .describe("Owner's raw ratio in the agent split (e.g. 60 for 'me 60 / partner 40')."),
    }),
    location: locationInfoSchema,
    priceAndDates: priceAndDatesSchema,
    buyerSeller: buyerSellerSchema,
    partners: z.array(partnerSchema).default([]),
    referral: referralSchema.optional(),
    commission: z
      .object({ gross: moneyValueSchema })
      .describe(
        "Gross commission on which to compute splits. Caller resolves this from saleCommission (+ listingCommission for DUAL) BEFORE calling this tool.",
      ),
    commissionPayer: commissionPayerShape
      .optional()
      .describe(
        "All 6 fields or OMIT entirely. Partial payloads fail CommissionPayerInfoRequestValidator; arrakis tolerates a null payer at submit.",
      ),
    fmls: fmlsInfoSchema.optional().describe("Georgia only."),
  }),
  async handler(args, { arrakis }): Promise<ToolResult<unknown>> {
    const completed: Stage[] = [];
    let builderId: string | undefined;
    const rep = args.priceAndDates.representationType;

    if (rep === "DUAL") {
      return fail(
        "DUAL representation isn't yet handled by create_full_draft. Fall back to the granular chain: create_draft_with_essentials + add_partner_agent (side=DUAL) + set_commission_splits per side + finalize_draft.",
        { code: "NOT_IMPLEMENTED_DUAL" },
      );
    }

    try {
      builderId = await arrakis.initializeDraft(args.env, args.type);
      completed.push("initialize");

      await arrakis.updateLocationInfo(args.env, builderId, args.location);
      completed.push("location");

      await arrakis.updatePriceAndDateInfo(args.env, builderId, args.priceAndDates);
      completed.push("price_dates");

      const bs =
        args.type === "LISTING" ? { ...args.buyerSeller, buyers: [] } : args.buyerSeller;
      await arrakis.updateBuyerAndSellerInfo(args.env, builderId, bs);
      completed.push("buyer_seller");

      const ownerRole = inferOwnerRole(rep);
      await arrakis.updateOwnerAgentInfo(args.env, builderId, {
        ownerAgent: { agentId: args.owner.yentaId, role: ownerRole },
        officeId: args.owner.officeId,
        ...(args.owner.teamId ? { teamId: args.owner.teamId } : {}),
      });
      completed.push("owner");

      const defaultPartnerSide = inferOwnerRole(rep);
      for (const p of args.partners) {
        await arrakis.addCoAgent(args.env, builderId, {
          agentId: p.agentId,
          role: p.side ?? defaultPartnerSide,
          receivesInvoice: p.receivesInvoice,
        });
      }
      completed.push("partners");

      let referralParticipantId: string | undefined;
      if (args.referral) {
        if (args.referral.kind === "internal") {
          const r = (await arrakis.addReferralInfo(args.env, builderId, {
            role: "REFERRING_AGENT",
            type: "AGENT",
            agentId: args.referral.agentId!,
            receivesInvoice: args.referral.receivesInvoice ?? false,
          })) as { id?: string } | undefined;
          referralParticipantId = r?.id;
        } else {
          const r = (await arrakis.addReferralInfo(args.env, builderId, {
            role: "REFERRING_AGENT",
            type: "EXTERNAL_ENTITY",
            firstName: args.referral.firstName!,
            lastName: args.referral.lastName!,
            companyName: args.referral.companyName!,
            address: args.referral.address!,
            ein: args.referral.ein,
            email: args.referral.email,
            phoneNumber: args.referral.phoneNumber,
            vendorDirectoryId: args.referral.vendorDirectoryId,
            receivesInvoice: args.referral.receivesInvoice ?? true,
          })) as { id?: string } | undefined;
          referralParticipantId = r?.id;
          if (args.referral.w9FilePath && referralParticipantId) {
            await arrakis.uploadReferralW9(
              args.env,
              builderId,
              referralParticipantId,
              args.referral.w9FilePath,
            );
          }
        }
      }
      completed.push("referral");

      const draft = (await arrakis.getDraft(args.env, builderId)) as Record<string, unknown>;
      const agentsInfo = draft?.agentsInfo as Record<string, unknown> | undefined;
      const ownerArray = agentsInfo?.ownerAgent as Array<{ id?: string }> | undefined;
      const ownerParticipantId = ownerArray?.[0]?.id;
      const coAgentsRaw =
        (agentsInfo?.coAgents as Array<{ id?: string; agentId?: string; yentaId?: string; role?: string }>) ??
        [];
      const coAgentParticipants = coAgentsRaw
        .map((c) => ({
          id: c.id ?? "",
          agentId: c.agentId ?? c.yentaId ?? "",
          role: c.role ?? "",
        }))
        .filter((c) => c.id);
      if (!referralParticipantId) {
        const referralInfo = draft?.referralInfo as Record<string, unknown> | undefined;
        const all = referralInfo?.allReferralParticipantInfo as Array<{ id?: string }> | undefined;
        referralParticipantId = all?.[0]?.id;
      }
      if (!ownerParticipantId) {
        return fail("Couldn't resolve owner participantId from draft after owner update.", {
          code: "RESOLVE_FAILED",
          body: { builderId, completedSteps: completed, nextStage: "resolve_participants" },
        });
      }
      completed.push("resolve_participants");

      const agentInputs: Array<{ key: string; displayName: string; rawRatio: number }> = [
        { key: ownerParticipantId, displayName: "owner", rawRatio: args.owner.ratio },
      ];
      for (let i = 0; i < args.partners.length; i++) {
        const p = args.partners[i];
        const match = coAgentParticipants.find((c) => c.agentId === p.agentId);
        if (!match) {
          return fail(
            `Couldn't match partner agent ${p.agentId} to a co-agent participant in the draft.`,
            { code: "PARTNER_MATCH_FAILED", body: { builderId, completedSteps: completed } },
          );
        }
        agentInputs.push({ key: match.id, displayName: `partner-${i}`, rawRatio: p.ratio });
      }
      const computed = computeCommissionSplits({
        grossCents: dollarsToCents(args.commission.gross.amount),
        currency: args.commission.gross.currency,
        agents: agentInputs,
        referral:
          args.referral && referralParticipantId
            ? {
                key: referralParticipantId,
                displayName: "referral",
                rawPercent: args.referral.percent,
              }
            : undefined,
      });
      completed.push("compute_splits");

      const splitsPayload = computed.splits.map((s) => ({
        participantId: s.key,
        commission: { percentEnabled: true, commissionPercent: s.percent },
      }));
      await arrakis.updateCommissionSplits(args.env, builderId, splitsPayload);
      completed.push("set_splits");

      const postWriteDraft = await arrakis.getDraft(args.env, builderId);
      const committed = extractCommittedSplits(postWriteDraft);
      const sent = computed.splits.map((s) => ({ participantId: s.key, percent: s.percent }));
      const diff = diffSplits(sent, committed);
      if (!diff.ok) {
        return fail(`Commission splits drifted after write: ${diff.issues.join("; ")}`, {
          code: "SPLITS_DRIFT",
          body: { builderId, completedSteps: completed, diff },
        });
      }
      completed.push("verify_splits");

      await arrakis.setOpcity(args.env, builderId, false);
      await arrakis.updatePersonalDealInfo(args.env, builderId, {
        personalDeal: false,
        representedByAgent: true,
      });
      await arrakis.updateAdditionalFees(args.env, builderId, {
        hasAdditionalFees: false,
        additionalFeesParticipantInfos: [],
      });
      let payerSet = false;
      if (args.commissionPayer) {
        const created = (await arrakis.addOtherParticipant(args.env, builderId, {
          role: args.commissionPayer.role,
          firstName: args.commissionPayer.firstName,
          lastName: args.commissionPayer.lastName,
          companyName: args.commissionPayer.companyName,
          email: args.commissionPayer.email,
          phoneNumber: args.commissionPayer.phoneNumber,
        })) as { id?: string } | undefined;
        if (created?.id) {
          await arrakis.setCommissionPayer(args.env, builderId, {
            participantId: created.id,
            role: args.commissionPayer.role,
          });
          payerSet = true;
        }
      }
      await arrakis.updateTitleInfo(args.env, builderId, { useRealTitle: false });
      if (args.fmls) {
        await arrakis.updateFmlsInfo(args.env, builderId, args.fmls);
      }
      completed.push("finalize");

      return ok({
        builderId,
        draftUrl: buildDraftUrl(args.env, builderId),
        type: args.type,
        splits: computed.splits,
        total: computed.total,
        gross: computed.gross,
        renormalized: computed.renormalized,
        payerSet,
        participants: {
          owner: { participantId: ownerParticipantId, yentaId: args.owner.yentaId },
          partners: coAgentParticipants.map((c) => ({
            participantId: c.id,
            agentId: c.agentId,
            role: c.role,
          })),
          referral: referralParticipantId
            ? { participantId: referralParticipantId, kind: args.referral?.kind ?? null }
            : null,
        },
      });
    } catch (err) {
      const nextStage = STAGES.find((s) => !completed.includes(s));
      const code =
        err instanceof CommissionMathError
          ? "COMMISSION_MATH_ERROR"
          : err instanceof ApiError
            ? "ARRAKIS_ERROR"
            : "CREATE_FULL_DRAFT_FAILED";
      const message = err instanceof Error ? err.message : String(err);
      return fail(message, {
        code,
        status: err instanceof ApiError ? err.status : undefined,
        body: {
          builderId,
          completedSteps: completed,
          nextStage,
          detail: err instanceof ApiError ? err.body : undefined,
        },
      });
    }
  },
});

function inferOwnerRole(rep: string): "BUYERS_AGENT" | "SELLERS_AGENT" | "TENANT_AGENT" {
  if (rep === "BUYER") return "BUYERS_AGENT";
  if (rep === "SELLER" || rep === "LANDLORD") return "SELLERS_AGENT";
  if (rep === "TENANT") return "TENANT_AGENT";
  return "BUYERS_AGENT";
}

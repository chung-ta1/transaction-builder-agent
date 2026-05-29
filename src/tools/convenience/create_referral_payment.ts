import { z } from "zod";
import { defineTool, fail, ok, type ToolResult } from "../Tool.js";
import { envSchema, stateOrProvinceSchema } from "../../types/schemas.js";
import { fromError } from "../granular/init.js";
import { buildTransactionDetailUrl } from "../../config.js";
import type { ReferralPaymentRequest } from "../../services/ReferralPaymentApi.js";

const PLACEHOLDER_CLIENT_NAME_REGEX = /\b(unknown|n\/a|na|tbd|no\s+client|placeholder)\b/i;
const AMOUNT_REQUIRING_EXPLICIT_DATE = 1000;

/**
 * Create a Real Brokerage referral-payment transaction via
 * `POST /api/v1/agent/{yentaId}/referral-and-disburse`.
 *
 * This is the "Create Referral" flow from Bolt: one-shot
 * create-and-submit. arrakis has NO draft stage for this — the endpoint
 * produces a real Transaction immediately (type=REFERRAL, lifecycle=NEW).
 * The skill runbook enforces a chat-side preview + confirm gate before
 * calling this tool, since the user can't review a draft in Bolt first.
 *
 * Use when:
 *  - A referral payment is owed to Real (or owed by Real) and it's NOT
 *    attached to a sale the user is also closing. If it IS attached to a
 *    sale, use `add_referral` on the sale's transaction builder instead.
 *  - You need the payment recorded on Real's books for CDA / commission
 *    split / 1099 routing.
 *
 * Do NOT use for:
 *  - Posting a client handoff opportunity on the marketplace — that's
 *    `create_marketplace_referral`.
 *  - A referral fee line item on an existing sale — that's `add_referral`.
 */
const moneyAmountPattern = /^-?\d+(\.\d{1,2})?$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const moneySchema = z.object({
  amount: z.number().positive().describe("Referral amount in major units (e.g. 2500 for $2,500)."),
  currency: z.enum(["USD", "CAD"]).default("USD"),
});

const addressSchema = z.object({
  street: z.string().min(1),
  street2: z.string().optional(),
  city: z.string().min(1),
  state: stateOrProvinceSchema,
  zip: z.string().min(1),
  country: z.enum(["UNITED_STATES", "CANADA"]),
});

const referralPaymentInput = z.object({
  env: envSchema,
  senderAgentYentaId: z
    .string()
    .uuid()
    .describe("The authenticated user's yentaId. Used in the URL path as the sender."),
  transactionOwnerAgentId: z
    .string()
    .uuid()
    .optional()
    .describe("Defaults to the sender. Pass only when the owner differs (e.g., TC creating on behalf of their agent)."),
  externalAgentName: z
    .string()
    .min(1)
    .describe("FULL name, single string. The UI splits first/last but the API joins them — pass e.g. 'Jane Smith' not separate parts."),
  externalAgentEmail: z.string().email(),
  externalAgentBrokerage: z.string().min(1),
  clientName: z
    .string()
    .min(1)
    .describe("FULL name of the client being referred. Single string like externalAgentName."),
  clientEmail: z.string().email().optional(),
  expectedReferralAmount: moneySchema,
  expectedCloseDate: z
    .string()
    .regex(isoDatePattern)
    .describe("ISO yyyy-MM-dd. Expected close of the deal the referral is attached to."),
  expectedCloseDateSource: z
    .enum(["user", "defaulted"])
    .optional()
    .describe(
      "Whether the expectedCloseDate came from the user (\"user\") or was silently defaulted by the skill (\"defaulted\", e.g. today+60d). When amount ≥ $1,000 and source=\"defaulted\", the tool rejects the call so the skill is forced to ask the user — fabricated dates on large referrals land in wrong tax quarters and poison reporting.",
    ),
  contractAcceptanceDate: z.string().regex(isoDatePattern).optional(),
  representeeType: z.enum(["BUYER", "SELLER", "TENANT", "LANDLORD"]).optional(),
  referredPropertyAddress: addressSchema.optional(),
  officeOfSaleState: stateOrProvinceSchema.optional(),
  externalPaymentDateSent: z.string().regex(isoDatePattern).optional(),
  externalPaymentMethod: z
    .enum(["CHECK", "WIRE"])
    .optional()
    .describe("arrakis enum values are CHECK / WIRE (uppercase)."),
  externalReferenceNumber: z.string().optional(),
  externalSenderName: z.string().optional(),
  comments: z.string().optional(),
  transactionCoordinatorIds: z
    .array(z.string().uuid())
    .optional()
    .describe("Optional TCs to attach to the new Transaction after creation."),
  classification: z
    .enum(["REFERRAL", "OTHER"])
    .optional()
    .describe(
      "REFERRAL = traditional External Referral (default). OTHER = Non-Referral Payment — termination fees, BPOs, spiffs, any other licensed-activity payment to Real that isn't a referral or a normal sale. When the prompt mentions termination, BPO, spiff, or 'not really a referral', pass OTHER. Omit to let arrakis default to REFERRAL.",
    ),
});

type ReferralPaymentInput = z.infer<typeof referralPaymentInput>;

export const createReferralPayment = defineTool({
  name: "create_referral_payment",
  description:
    "Create AND submit a referral-payment transaction in one call (arrakis `POST /agent/{yentaId}/referral-and-disburse`). REQUIRED: externalAgentName (single string), externalAgentEmail, externalAgentBrokerage, clientName (single string), expectedReferralAmount ({amount, currency}), expectedCloseDate (yyyy-MM-dd). Unlike `create_draft_with_essentials`, this endpoint has no draft stage — it's immediate submit. Runbook MUST show a preview and require a confirmation click before calling this tool. Returns the new Transaction id + a bolt /transactions/{id}/detail URL.",
  input: referralPaymentInput,
  async handler(args: ReferralPaymentInput, { referralPayment }): Promise<ToolResult<unknown>> {
    const { env, senderAgentYentaId, expectedReferralAmount, expectedCloseDateSource, ...rest } = args;

    // arrakis MoneyValue takes `amount` as a number. Bolt sends integer
    // dollars (2500, not 25.00); keep that contract. Round to 2dp for
    // defensiveness and reject NaN / zero / negative.
    const amount = Math.round(expectedReferralAmount.amount * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(`Invalid expectedReferralAmount: ${expectedReferralAmount.amount}`);
    }
    void moneyAmountPattern; // reserved for a future string-amount variant.

    // Pre-fire guard: placeholder clientName + REFERRAL classification is
    // semantically incoherent. REFERRAL means "a specific client was referred";
    // a missing/unknown client suggests the user meant OTHER (Non-Referral
    // Payment — BPO, termination fee, etc.). Force them to resolve before firing.
    const classification = rest.classification;
    if (
      (classification === undefined || classification === "REFERRAL") &&
      PLACEHOLDER_CLIENT_NAME_REGEX.test(rest.clientName)
    ) {
      return fail(
        `Refusing to fire: clientName "${rest.clientName}" looks like a placeholder but classification is REFERRAL. A traditional referral has a specific client being referred. Either supply the real client's name, or switch classification to OTHER (Non-Referral Payment — termination fee / BPO / spiff / consulting fee).`,
        {
          code: "PLACEHOLDER_CLIENT_ON_REFERRAL",
          body: { field: "clientName", suggestedFix: "set classification=OTHER OR supply real clientName" },
        },
      );
    }

    // Pre-fire guard: fabricated date on a large referral corrupts 1099
    // reporting and referral-disbursement windows. Force the skill to ask
    // when the user didn't explicitly supply the date.
    if (
      expectedCloseDateSource === "defaulted" &&
      amount >= AMOUNT_REQUIRING_EXPLICIT_DATE
    ) {
      return fail(
        `Refusing to fire: expectedCloseDate was silently defaulted and the referral amount ($${amount}) is ≥ $${AMOUNT_REQUIRING_EXPLICIT_DATE}. Fabricated close dates on large referrals land in wrong tax quarters. Ask the user for a real date.`,
        {
          code: "DEFAULTED_DATE_ON_LARGE_REFERRAL",
          body: { field: "expectedCloseDate", amount, threshold: AMOUNT_REQUIRING_EXPLICIT_DATE },
        },
      );
    }

    const body: ReferralPaymentRequest = {
      ...rest,
      expectedReferralAmount: {
        amount,
        currency: expectedReferralAmount.currency,
      },
    };

    try {
      const response = await referralPayment.createAndDisburse(env, senderAgentYentaId, body);
      const transactionId = response.transaction?.id;
      const transaction = response.transaction as Record<string, unknown> | undefined;
      const systemModifications = diffReferralPaymentSystemModifications({
        requestedTransactionOwner: rest.transactionOwnerAgentId ?? senderAgentYentaId,
        transaction,
      });

      return ok({
        transactionId,
        referralId: response.referral?.id,
        transactionCode: response.transaction?.code,
        detailUrl: transactionId ? buildTransactionDetailUrl(env, transactionId) : undefined,
        systemModifications,
        raw: response,
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

/**
 * Diff what the caller requested against what arrakis committed. arrakis's
 * post-POST rules frequently override team (based on owner's team
 * memberships) and attach a default Transaction Coordinator. The user on
 * ca181852 literally asked "how is this selected?" — surfacing this as a
 * structured list closes that UX gap.
 */
function diffReferralPaymentSystemModifications(args: {
  requestedTransactionOwner: string;
  transaction: Record<string, unknown> | undefined;
}): Array<{ field: string; requested: unknown; actual: unknown; note: string }> {
  const out: Array<{ field: string; requested: unknown; actual: unknown; note: string }> = [];
  if (!args.transaction) return out;
  const actualTeamId = asNullableString(args.transaction.teamId);
  if (actualTeamId) {
    out.push({
      field: "teamId",
      requested: "(not specified in request)",
      actual: actualTeamId,
      note: "arrakis auto-assigned a team based on the owner's yenta team memberships. Splits and pre-cap fees apply per this team's config.",
    });
  }
  const otherParticipants = (args.transaction.otherParticipants ?? []) as Array<{
    id?: string;
    yentaId?: string;
    role?: string;
    firstName?: string;
    lastName?: string;
  }>;
  const autoAttachedTCs = otherParticipants.filter(
    (p) => p.role === "TRANSACTION_COORDINATOR",
  );
  if (autoAttachedTCs.length > 0) {
    out.push({
      field: "transactionCoordinators",
      requested: "(not specified in request)",
      actual: autoAttachedTCs.map((t) => ({
        id: t.id,
        name: `${t.firstName ?? ""} ${t.lastName ?? ""}`.trim(),
      })),
      note: `arrakis auto-attached ${autoAttachedTCs.length} Transaction Coordinator(s) based on the owner's team default TC. Remove via Bolt's "Other Participants" section if unwanted.`,
    });
  }
  return out;
}

function asNullableString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

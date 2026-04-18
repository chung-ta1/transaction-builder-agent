import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema, stateOrProvinceSchema } from "../../types/schemas.js";
import { fromError } from "../granular/init.js";
import { buildTransactionDetailUrl } from "../../config.js";
import type { ReferralPaymentRequest } from "../../services/ReferralPaymentApi.js";

/**
 * Create a Real Brokerage referral-payment transaction via
 * `POST /api/v1/agent/{yentaId}/referral-and-disburse`.
 *
 * This is the "Create Referral / Payment" flow from Bolt: one-shot
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
    const { env, senderAgentYentaId, expectedReferralAmount, ...rest } = args;

    // arrakis MoneyValue takes `amount` as a number. Bolt sends integer
    // dollars (2500, not 25.00); keep that contract. Round to 2dp for
    // defensiveness and reject NaN / zero / negative.
    const amount = Math.round(expectedReferralAmount.amount * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        ok: false,
        error: {
          message: `Invalid expectedReferralAmount: ${expectedReferralAmount.amount}`,
        },
      };
    }
    void moneyAmountPattern; // reserved for a future string-amount variant.

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
      return ok({
        transactionId,
        referralId: response.referral?.id,
        transactionCode: response.transaction?.code,
        detailUrl: transactionId ? buildTransactionDetailUrl(env, transactionId) : undefined,
        raw: response,
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

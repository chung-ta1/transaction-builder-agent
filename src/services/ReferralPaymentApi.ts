import { BaseApi } from "./BaseApi.js";
import type { AuthService } from "../auth/AuthService.js";
import { urlsFor, type Env } from "../config.js";

/**
 * Shape of the JSON body consumed by
 * `POST /api/v1/agent/{yentaId}/referral-and-disburse`. Mirrors arrakis's
 * `CreateAndDisburseReferralRequest` (see arrakis-core/.../CreateAndDisburseReferralRequest.java).
 *
 * Required vs optional tracks arrakis's `@NotNull` / `@Email` annotations:
 * - `externalAgentName`, `externalAgentEmail`, `externalAgentBrokerage`
 * - `clientName`
 * - `expectedReferralAmount` (MoneyValue, currency-enforced)
 * - `expectedCloseDate` (ISO `yyyy-MM-dd`)
 *
 * Everything else is optional. The UI collects first + last separately, but
 * the API takes a single joined name string.
 */
export interface ReferralPaymentRequest {
  externalAgentName: string;
  externalAgentEmail: string;
  externalAgentBrokerage: string;
  clientName: string;
  clientEmail?: string;
  transactionOwnerAgentId?: string;
  expectedReferralAmount: { amount: number; currency: "USD" | "CAD" };
  expectedCloseDate: string;
  contractAcceptanceDate?: string;
  representeeType?: "BUYER" | "SELLER" | "TENANT" | "LANDLORD";
  referredPropertyAddress?: ReferralAddress;
  officeOfSaleState?: string;
  externalPaymentDateSent?: string;
  externalPaymentMethod?: "CHECK" | "WIRE";
  externalReferenceNumber?: string;
  externalSenderName?: string;
  comments?: string;
  transactionCoordinatorIds?: string[];
  /**
   * Mirrors arrakis's `ReferralClassification` enum:
   *   - `REFERRAL` — "External Referral": traditional agent-to-agent referral
   *     from an outside brokerage for a client referral.
   *   - `OTHER` — "Non-Referral Payment": any other payment owed to Real for
   *     licensed activity that isn't a traditional referral or transaction
   *     (termination fees, BPOs, spiffs, one-off licensed services).
   *
   * Optional. When omitted, arrakis defaults to `REFERRAL`. The field is
   * client-side feature-flagged in Bolt (US_EXTERNAL_REFERRALS) — when the
   * flag is off, the UI always sends REFERRAL even when OTHER would be
   * appropriate. The API accepts OTHER regardless of the flag.
   */
  classification?: "REFERRAL" | "OTHER";
}

export interface ReferralAddress {
  street: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: "UNITED_STATES" | "CANADA";
}

export interface ReferralPaymentResponse {
  transaction?: {
    id?: string;
    code?: string;
    [key: string]: unknown;
  };
  referral?: {
    id?: string;
    [key: string]: unknown;
  };
}

/**
 * Thin client for arrakis's single-shot referral-payment endpoint. Unlike
 * the transaction-builder flow, this is one POST: create + submit together.
 * Any "draft" UX lives in the MCP skill (preview + confirm gate before
 * calling this method).
 */
export class ReferralPaymentApi extends BaseApi {
  constructor(auth: AuthService) {
    super(auth, (env) => urlsFor(env).arrakis);
  }

  createAndDisburse(
    env: Env,
    senderAgentYentaId: string,
    body: ReferralPaymentRequest,
  ): Promise<ReferralPaymentResponse> {
    return this.request<ReferralPaymentResponse>(env, {
      method: "POST",
      url: `/api/v1/agent/${senderAgentYentaId}/referral-and-disburse`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }
}

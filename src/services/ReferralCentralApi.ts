import { BaseApi } from "./BaseApi.js";
import type { AuthService } from "../auth/AuthService.js";
import { urlsFor, type Env } from "../config.js";

/**
 * Thin client over arrakis's referral-central endpoint
 * (`POST /api/v1/referrals` with `ReferralCentralReferralDto`). This is the
 * marketplace-style referral — "I have a client looking for X in Y, paying N%
 * fee, expires Z". Separate from `add_referral` (which adds a referring
 * agent as a participant on a transaction).
 */
export class ReferralCentralApi extends BaseApi {
  constructor(auth: AuthService) {
    super(auth, (env) => urlsFor(env).arrakis);
  }

  /**
   * Create a marketplace referral. Required fields per OpenAPI:
   * applicantAgentIds, referralFeePercentage, priceRange, locations,
   * referralAgentId, expirationDate, languages, timeline, clientType, status.
   * Returns the created `ReferralCentralReferralDto`.
   */
  createReferral(env: Env, body: MarketplaceReferralBody): Promise<unknown> {
    return this.request(env, {
      method: "POST",
      url: "/api/v1/referrals",
      data: body,
    });
  }
}

export interface MarketplaceReferralBody {
  /** Agent IDs allowed to apply (usually the user themselves). */
  applicantAgentIds: Array<{ agentId: string }>;
  /** e.g. 25 for 25% fee. */
  referralFeePercentage: number;
  priceRange: {
    minimum: { amount: number; currency: "USD" | "CAD" };
    maximum: { amount: number; currency: "USD" | "CAD" };
  };
  /** Geo locations the referral covers. */
  locations: Array<{
    city?: string;
    stateOrProvince?: string;
    zipCode?: string;
    coordinates: { latitude: number; longitude: number };
    radius: number;
    unitOfMeasure: "MILES" | "KILOMETERS";
  }>;
  /** The referring agent (usually the user). */
  referralAgentId: string;
  /** Agent who will take the client if accepted. Optional — marketplace fills. */
  receivingAgentId?: string;
  /** ISO yyyy-MM-dd. */
  expirationDate: string;
  /** Language enum values. */
  languages: string[];
  timeline: "FROM_0_TO_3_MONTHS" | "FROM_3_TO_6_MONTHS" | "FROM_6_TO_12_MONTHS" | "UNKNOWN";
  clientType: "BUYER" | "SELLER" | "TENANT" | "LANDLORD";
  status: "SENT" | "PAUSED" | "POSTED" | "ACCEPTED";
  /** Optional extras. */
  nickname?: string;
  notes?: string;
  clientInformation?: {
    firstName: string;
    lastName: string;
    email: string;
    phoneNumber: string;
    address: {
      street?: string;
      street2?: string;
      city?: string;
      state?: string;
      zip?: string;
      country?: "UNITED_STATES" | "CANADA";
    };
  };
}

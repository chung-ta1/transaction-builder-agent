import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "../granular/init.js";
import type { MarketplaceReferralBody } from "../../services/ReferralCentralApi.js";

/**
 * Create a marketplace referral via `POST /api/v1/referrals`. This is the
 * `ReferralCentralReferralDto` flow — "I have a client looking for X in Y,
 * paying N% fee, expires Z". Separate from `add_referral` (which adds a
 * referring agent as a participant on an existing transaction).
 *
 * Use when the user wants to POST a referral to the marketplace (other agents
 * can apply to take the client). Use `add_referral` instead when the user is
 * paying a referral fee to someone who sent them a deal.
 */
export const createMarketplaceReferral = defineTool({
  name: "create_marketplace_referral",
  description:
    "POST a marketplace referral (`/api/v1/referrals`) — the user has a client looking for X in location Y and wants to match to another agent in exchange for an N% referral fee. Input shape mirrors arrakis's ReferralCentralReferralDto. Prefer `add_referral` when the user is paying a fee TO someone on an existing transaction — that's a different flow.",
  input: z.object({
    env: envSchema,
    referralAgentId: z.string().uuid().describe("The user's own yentaId (the referring agent)."),
    applicantAgentIds: z
      .array(z.string().uuid())
      .default([])
      .describe("Agent yentaIds allowed to apply. OPTIONAL per arrakis canonical test (CreateReferralHandlerTest). Leave empty or omit to allow any agent to apply; include specific yentaIds to restrict."),
    referralFeePercentage: z.number().min(0).max(100).describe("e.g. 25 for 25%"),
    priceMin: z.number().nonnegative(),
    priceMax: z.number().positive(),
    currency: z.enum(["USD", "CAD"]).default("USD"),
    locations: z
      .array(
        z.object({
          city: z.string().optional(),
          state: z.string().optional(),
          zipCode: z.string().optional(),
          latitude: z.number(),
          longitude: z.number(),
          radius: z.number().positive(),
          unitOfMeasure: z.enum(["MILES", "KILOMETERS"]).default("MILES"),
        }),
      )
      .min(1),
    expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("ISO yyyy-MM-dd"),
    languages: z.array(z.string()).min(1).default(["ENGLISH"]),
    timeline: z.enum(["FROM_0_TO_3_MONTHS", "FROM_3_TO_6_MONTHS", "FROM_6_TO_12_MONTHS", "UNKNOWN"]),
    clientType: z.enum(["BUYER", "SELLER", "TENANT", "LANDLORD"]),
    nickname: z.string().optional(),
    notes: z.string().optional(),
    clientContact: z
      .object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email(),
        phoneNumber: z.string().min(1),
        addressStreet: z.string().optional(),
        addressCity: z.string().optional(),
        addressState: z.string().optional(),
        addressZip: z.string().optional(),
        addressCountry: z.enum(["UNITED_STATES", "CANADA"]).optional(),
      })
      .optional()
      .describe("Optional client contact. If omitted, arrakis keeps the referral anonymous until an agent accepts."),
  }),
  async handler(args, { referralCentral }): Promise<ToolResult<unknown>> {
    const body: MarketplaceReferralBody = {
      referralAgentId: args.referralAgentId,
      applicantAgentIds: args.applicantAgentIds.map((agentId) => ({ agentId })),
      referralFeePercentage: args.referralFeePercentage,
      priceRange: {
        minimum: { amount: args.priceMin, currency: args.currency },
        maximum: { amount: args.priceMax, currency: args.currency },
      },
      locations: args.locations.map((l) => ({
        city: l.city,
        stateOrProvince: l.state,
        zipCode: l.zipCode,
        coordinates: { latitude: l.latitude, longitude: l.longitude },
        radius: l.radius,
        unitOfMeasure: l.unitOfMeasure,
      })),
      expirationDate: args.expirationDate,
      languages: args.languages,
      timeline: args.timeline,
      clientType: args.clientType,
      status: "POSTED",
      nickname: args.nickname,
      notes: args.notes,
      ...(args.clientContact && {
        clientInformation: {
          firstName: args.clientContact.firstName,
          lastName: args.clientContact.lastName,
          email: args.clientContact.email,
          phoneNumber: args.clientContact.phoneNumber,
          address: {
            street: args.clientContact.addressStreet,
            city: args.clientContact.addressCity,
            state: args.clientContact.addressState,
            zip: args.clientContact.addressZip,
            country: args.clientContact.addressCountry,
          },
        },
      }),
    };
    try {
      const result = await referralCentral.createReferral(args.env, body);
      return ok({ referral: result });
    } catch (err) {
      return fromError(err);
    }
  },
});

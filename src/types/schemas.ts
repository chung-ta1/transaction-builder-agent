import { z } from "zod";
import { SUPPORTED_ENVS } from "../config.js";
import { STATE_OR_PROVINCE } from "./enums.js";

/**
 * zod schemas for every MCP tool input. Each tool parses its raw args through
 * the matching schema before calling arrakis, so invalid LLM output becomes a
 * structured error (not a silent malformed API call).
 */

export const envSchema = z.enum(SUPPORTED_ENVS);

export const moneyValueSchema = z.object({
  amount: z.string().regex(/^-?\d+(\.\d{1,2})?$/, "amount must be a decimal string"),
  currency: z.enum(["USD", "CAD"]),
});

export const commissionFractionalPercentSchema = z.object({
  commissionAmount: moneyValueSchema.nullish(),
  commissionPercent: z.string().regex(/^\d+(\.\d+)?$/).nullish(),
  percentEnabled: z.boolean(),
});

export const stateOrProvinceSchema = z.enum(STATE_OR_PROVINCE);

export const representationTypeSchema = z.enum(["SELLER", "BUYER", "DUAL", "LANDLORD", "TENANT"]);

export const participantRoleSchema = z.enum([
  "REAL", "BUYERS_AGENT", "TENANT_AGENT", "REFERRING_AGENT", "SELLERS_AGENT",
  "OTHER_AGENT", "EXTERNAL_AGENT", "TEAM_LEADER", "TEAM_MEMBER", "DOMESTIC_LEAD",
  "TRANSACTION_COORDINATOR", "ADMIN", "INSPECTION", "ESCROW", "TITLE",
  "LANDLORD", "MANAGEMENT_COMPANY", "ATTORNEY", "APPRAISER", "HOME_WARRANTY",
  "LENDER", "TAX_COLLECTOR", "BUYER", "SELLER", "TENANT", "OTHER", "UNKNOWN",
  "REFERRAL_PAYER", "SELLERS_LAWYER", "BUYERS_LAWYER", "TRUSTEE", "REAL_ADMIN",
  "BUILDER", "PRO_TEAM_LEADER",
]);

export const participantTypeSchema = z.enum(["EXTERNAL_ENTITY", "AGENT"]);

// Authoritative values synced by hand from the arrakis source
// (arrakis-core/src/main/java/com/real/arrakis/domain/transaction/DealType.java).
// A prior version had SALE/LEASE/REFERRAL only — arrakis actually accepts
// 8 dealTypes, and rejects unknown values at write time.
export const dealTypeSchema = z.enum([
  "SALE", "LEASE", "REFERRAL",
  "COMPENSATING", "COMMERCIAL_LEASE", "PLOT", "OTHER", "INTERNAL_REFERRAL",
]);

// Authoritative values from arrakis spec. A prior version used LAND /
// CONDOMINIUM / MANUFACTURED_MOBILE_HOME / TOWNHOUSE / FARM_AND_RANCH /
// OTHER — arrakis rejects those. Real names below.
export const propertyTypeSchema = z.enum([
  "RESIDENTIAL", "COMMERCIAL", "LAND_LOT", "CONDO",
  "MOBILE_HOME", "NEW_CONSTRUCTION",
]);

export const personSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  companyName: z.string().optional(),
  phoneNumber: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  vendorDirectoryId: z.string().uuid().optional(),
});

export const locationInfoSchema = z.object({
  street: z.string().min(1),
  street2: z.string().optional(),
  unit: z.string().optional(),
  city: z.string().min(1),
  state: stateOrProvinceSchema,
  zip: z.string().min(1),
  yearBuilt: z.number().int().optional(),
  mlsNumber: z.string().optional(),
  escrowNumber: z.string().optional(),
  propertySlug: z.string().min(3).max(255).optional(),
});

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO yyyy-MM-dd");

export const priceAndDatesSchema = z.object({
  dealType: dealTypeSchema,
  propertyType: propertyTypeSchema.default("RESIDENTIAL"),
  salePrice: moneyValueSchema,
  saleCommission: commissionFractionalPercentSchema,
  listingCommission: commissionFractionalPercentSchema.optional(),
  acceptanceDate: isoDate.optional(),
  closingDate: isoDate.optional(),
  firmDate: isoDate.optional(),
  financingConditionsExpirationDate: isoDate.optional(),
  propertyInspectionExpirationDate: isoDate.optional(),
  saleOfBuyersPropertyExpirationDate: isoDate.optional(),
  condoDocumentsExpirationDate: isoDate.optional(),
  otherConditionsExpirationDate: isoDate.optional(),
  representationType: representationTypeSchema,
  listingDate: isoDate.optional(),
  listingExpirationDate: isoDate.optional(),
  requiresInstallments: z.boolean().optional(),
});

export const buyerSellerSchema = z.object({
  buyers: z.array(personSchema).optional(),
  sellers: z.array(personSchema).min(1, "at least one seller is required"),
});

export const agentParticipantInfoSchema = z.object({
  agentId: z.string().uuid(),
  role: participantRoleSchema,
  receivesInvoice: z.boolean().optional(),
});

export const ownerAgentInfoSchema = z.object({
  ownerAgent: agentParticipantInfoSchema,
  officeId: z.string().uuid().optional(),
  officeIds: z.array(z.string().uuid()).optional(),
  teamId: z.string().uuid().optional(),
  leadSource: z.unknown().optional(),
});

export const commissionSplitSchema = z.object({
  participantId: z.string(),
  commission: commissionFractionalPercentSchema,
});

export const addParticipantRequestSchema = z.object({
  role: participantRoleSchema,
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  companyName: z.string().optional(),
  email: z.string().email().optional(),
  ein: z.string().optional(),
  phoneNumber: z.string().optional(),
  address: z.string().optional(),
  agentId: z.string().uuid().optional(),
  receivesInvoice: z.boolean().optional(),
  type: participantTypeSchema.optional(),
  vendorDirectoryId: z.string().uuid().optional(),
  w9FilePath: z.string().optional(),
});

export const commissionPayerInfoSchema = z.object({
  role: participantRoleSchema.optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  companyName: z.string().optional(),
  email: z.string().email().optional(),
  phoneNumber: z.string().optional(),
  address: z.string().optional(),
  participantId: z.string(),
  w9FilePath: z.string().optional(),
  receivesInvoice: z.boolean().optional(),
  vendorDirectoryId: z.string().uuid().optional(),
});

export const titleInfoSchema = z
  .object({
    useRealTitle: z.boolean(),
    manualOrderPlaced: z.boolean().optional(),
    titleContactInfo: z
      .object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email(),
        phoneNumber: z.string().min(1),
        companyName: z.string().min(1),
      })
      .optional(),
  })
  .refine(
    (data) => !data.useRealTitle || (data.titleContactInfo && data.manualOrderPlaced !== undefined),
    { message: "useRealTitle=true requires titleContactInfo and manualOrderPlaced" },
  );

export const fmlsInfoSchema = z.object({
  propertyListedOnFmls: z.boolean(),
});

export const personalDealInfoSchema = z.object({
  personalDeal: z.boolean(),
  representedByAgent: z.boolean(),
});

export const additionalFeesSchema = z.object({
  hasAdditionalFees: z.boolean(),
  additionalFeesParticipantInfos: z
    .array(
      z.object({
        feeType: z.string(),
        amount: moneyValueSchema,
        participantId: z.string(),
        description: z.string().optional(),
      }),
    )
    .default([]),
});

export const opcitySchema = z.object({
  opcity: z.boolean(),
});

export const searchAgentSchema = z.object({
  env: envSchema,
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  query: z.string().optional(),
}).refine(
  (v) => v.firstName || v.lastName || v.email || v.query,
  { message: "Provide at least one of firstName, lastName, email, or query." },
);

export type Env = z.infer<typeof envSchema>;
export type LocationInfo = z.infer<typeof locationInfoSchema>;
export type PriceAndDates = z.infer<typeof priceAndDatesSchema>;
export type BuyerSeller = z.infer<typeof buyerSellerSchema>;
export type AgentParticipantInfo = z.infer<typeof agentParticipantInfoSchema>;
export type OwnerAgentInfo = z.infer<typeof ownerAgentInfoSchema>;
export type CommissionSplit = z.infer<typeof commissionSplitSchema>;
export type AddParticipantRequest = z.infer<typeof addParticipantRequestSchema>;
export type CommissionPayerInfo = z.infer<typeof commissionPayerInfoSchema>;
export type TitleInfo = z.infer<typeof titleInfoSchema>;
export type FmlsInfo = z.infer<typeof fmlsInfoSchema>;
export type PersonalDealInfo = z.infer<typeof personalDealInfoSchema>;
export type AdditionalFees = z.infer<typeof additionalFeesSchema>;
export type SearchAgent = z.infer<typeof searchAgentSchema>;

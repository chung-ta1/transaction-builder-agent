/**
 * Enums mirroring arrakis domain. Sources:
 *   - arrakis-core/src/main/java/com/real/arrakis/domain/transaction/builder/RepresentationType.java
 *   - arrakis-core/src/main/java/com/real/arrakis/domain/transaction/builder/TransactionBuilderType.java
 *   - arrakis-core/src/main/java/com/real/arrakis/domain/transaction/builder/CommissionPayerDisplay.java
 *   - arrakis-core/src/main/java/com/real/arrakis/domain/ParticipantRole.java
 *   - arrakis-core/src/main/java/com/real/arrakis/domain/ParticipantType.java
 *   - real-commons: com.real.commons.domain.transaction.{TransactionType, PropertyType}
 *   - real-commons: com.real.commons.geo.StateOrProvince
 *
 * When arrakis changes these, update this file by hand (the `/sync-rules`
 * skill flags drift; there is no automated codegen).
 */

export type RepresentationType = "SELLER" | "BUYER" | "DUAL" | "LANDLORD" | "TENANT";

export type TransactionBuilderType = "TRANSACTION" | "LISTING";

export type ParticipantType = "EXTERNAL_ENTITY" | "AGENT";

export type TransactionType = "SALE" | "LEASE" | "REFERRAL";

export type PropertyType =
  | "RESIDENTIAL"
  | "COMMERCIAL"
  | "LAND"
  | "CONDOMINIUM"
  | "TOWNHOUSE"
  | "MANUFACTURED_MOBILE_HOME"
  | "FARM_AND_RANCH"
  | "OTHER";

export type ParticipantRole =
  | "REAL"
  | "BUYERS_AGENT"
  | "TENANT_AGENT"
  | "REFERRING_AGENT"
  | "SELLERS_AGENT"
  | "OTHER_AGENT"
  | "EXTERNAL_AGENT"
  | "TEAM_LEADER"
  | "TEAM_MEMBER"
  | "DOMESTIC_LEAD"
  | "TRANSACTION_COORDINATOR"
  | "ADMIN"
  | "INSPECTION"
  | "ESCROW"
  | "TITLE"
  | "LANDLORD"
  | "MANAGEMENT_COMPANY"
  | "ATTORNEY"
  | "APPRAISER"
  | "HOME_WARRANTY"
  | "LENDER"
  | "TAX_COLLECTOR"
  | "BUYER"
  | "SELLER"
  | "TENANT"
  | "OTHER"
  | "UNKNOWN"
  | "REFERRAL_PAYER"
  | "SELLERS_LAWYER"
  | "BUYERS_LAWYER"
  | "TRUSTEE"
  | "REAL_ADMIN"
  | "BUILDER"
  | "PRO_TEAM_LEADER";

/**
 * US states + Canadian provinces. Mirror of com.real.commons.geo.StateOrProvince.
 * Arrakis uses these exact spellings in the builder payloads.
 */
export const US_STATES = [
  "ALABAMA", "ALASKA", "ARIZONA", "ARKANSAS", "CALIFORNIA", "COLORADO",
  "CONNECTICUT", "DELAWARE", "FLORIDA", "GEORGIA", "HAWAII", "IDAHO",
  "ILLINOIS", "INDIANA", "IOWA", "KANSAS", "KENTUCKY", "LOUISIANA", "MAINE",
  "MARYLAND", "MASSACHUSETTS", "MICHIGAN", "MINNESOTA", "MISSISSIPPI", "MISSOURI",
  "MONTANA", "NEBRASKA", "NEVADA", "NEW_HAMPSHIRE", "NEW_JERSEY", "NEW_MEXICO",
  "NEW_YORK", "NORTH_CAROLINA", "NORTH_DAKOTA", "OHIO", "OKLAHOMA", "OREGON",
  "PENNSYLVANIA", "RHODE_ISLAND", "SOUTH_CAROLINA", "SOUTH_DAKOTA", "TENNESSEE",
  "TEXAS", "UTAH", "VERMONT", "VIRGINIA", "WASHINGTON", "WEST_VIRGINIA",
  "WISCONSIN", "WYOMING", "DISTRICT_OF_COLUMBIA",
] as const;

export const CA_PROVINCES = [
  "ALBERTA", "BRITISH_COLUMBIA", "MANITOBA", "NEW_BRUNSWICK",
  "NEWFOUNDLAND_AND_LABRADOR", "NOVA_SCOTIA", "NORTHWEST_TERRITORIES", "NUNAVUT",
  "ONTARIO", "PRINCE_EDWARD_ISLAND", "QUEBEC", "SASKATCHEWAN", "YUKON",
] as const;

export const STATE_OR_PROVINCE = [...US_STATES, ...CA_PROVINCES] as const;

export type StateOrProvince = (typeof STATE_OR_PROVINCE)[number];

export type Country = "UNITED_STATES" | "CANADA";

export function countryOf(state: StateOrProvince): Country {
  return (US_STATES as readonly string[]).includes(state) ? "UNITED_STATES" : "CANADA";
}

export function currencyOf(state: StateOrProvince): "USD" | "CAD" {
  return countryOf(state) === "UNITED_STATES" ? "USD" : "CAD";
}

/**
 * Valid commission-payer display options from arrakis's `CommissionPayerDisplay`
 * enum. Each maps to a concrete ParticipantRole when the MCP creates the payer
 * participant.
 */
export type CommissionPayerDisplay =
  | "SELLERS_LAWYER"
  | "SELLER"
  | "BUYER"
  | "BUYERS_LAWYER"
  | "LANDLORD"
  | "TENANT"
  | "LISTING_BROKERAGE"
  | "CO_OPERATING_BROKERAGE"
  | "TITLE"
  | "MANAGEMENT_COMPANY"
  | "ATTORNEY";

/**
 * Represents a commission value that is either an absolute amount or a percent.
 * Mirrors `com.real.arrakis.domain.CommissionFractionalPercent`. Exactly one of
 * (commissionAmount, commissionPercent) is populated based on `percentEnabled`.
 */
export interface CommissionFractionalPercent {
  commissionAmount?: MoneyValue | null;
  commissionPercent?: string | null; // decimal as string (e.g. "60" for 60%)
  percentEnabled: boolean;
}

export interface MoneyValue {
  amount: string; // decimal as string, e.g. "20000.00"
  currency: "USD" | "CAD";
}

export function commissionPercent(percent: number): CommissionFractionalPercent {
  return {
    commissionPercent: percent.toString(),
    commissionAmount: null,
    percentEnabled: true,
  };
}

export function commissionAmount(amount: number, currency: "USD" | "CAD"): CommissionFractionalPercent {
  return {
    commissionAmount: { amount: amount.toFixed(2), currency },
    commissionPercent: null,
    percentEnabled: false,
  };
}

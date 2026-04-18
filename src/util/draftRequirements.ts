import { guessFromPostalCode } from "./zipLookup.js";
import type { Env } from "../config.js";

/**
 * Rule engine that computes gaps/defaults/blockers for a draft-in-progress.
 * Data source: memory/bolt-field-matrix.md (kept in sync manually — when that
 * file updates, add/adjust rules here).
 *
 * Design:
 *   - Pure functions over a DraftAnswers snapshot.
 *   - One rule per conditional (e.g., "listing pre-check" is its own rule).
 *   - Each rule returns 0-N of Gap | Default | Blocker.
 *   - No I/O; no arrakis calls; no yenta calls. Just reasoning.
 *
 * The MCP tool wrapper (validate_draft_completeness) runs the rules and hands
 * the structured result to Claude, which batches gaps into AskUserQuestion
 * calls and applies defaults silently.
 */

// Enum values authoritative from arrakis OpenAPI spec. Do not invent values;
// arrakis rejects anything outside these sets.
export type DealType =
  | "SALE" | "LEASE" | "REFERRAL"
  | "COMPENSATING" | "COMMERCIAL_LEASE" | "PLOT" | "OTHER" | "INTERNAL_REFERRAL";
export type Representation = "SELLER" | "BUYER" | "DUAL" | "TENANT" | "LANDLORD";
export type Country = "UNITED_STATES" | "CANADA";
export type Currency = "USD" | "CAD";
export type PropertyType =
  | "RESIDENTIAL" | "COMMERCIAL" | "LAND_LOT" | "CONDO"
  | "MOBILE_HOME" | "NEW_CONSTRUCTION";
export type PayerRole = "TITLE" | "SELLERS_LAWYER" | "OTHER_AGENT" | "LANDLORD" | "TENANT" | "MANAGEMENT_COMPANY";

export interface DraftAnswers {
  /** Property (step 1). */
  address?: {
    street?: string;
    street2?: string;
    unit?: string;
    city?: string;
    state?: string;      // enum like "NEW_YORK"
    zip?: string;
    country?: Country;
    yearBuilt?: number;
    mlsNumber?: string;
    escrowNumber?: string;
  };
  /** Deal (step 2). */
  deal?: {
    dealType?: DealType;
    salePrice?: { amount: string; currency: Currency };
    propertyType?: PropertyType;
    representationType?: Representation;
    saleCommission?: { kind: "percent" | "amount"; value: string };
    listingCommission?: { kind: "percent" | "amount"; value: string };
    acceptanceDate?: string; // ISO yyyy-MM-dd
    closingDate?: string;    // ISO yyyy-MM-dd
  };
  /** People (step 3). */
  sellers?: Array<Person>;
  buyers?: Array<Person>;
  /** Owner (step 4). */
  owner?: { yentaId?: string; officeId?: string; teamId?: string };
  /** Partners / co-agents (added via add_partner_agent). */
  partners?: Array<{ agentId: string; side: "BUYERS_AGENT" | "SELLERS_AGENT" | "TENANT_AGENT" | "DUAL" }>;
  /** Referral (optional, max 1 non-opcity). */
  referral?: { kind: "internal" | "external"; agentId?: string } | null;
  /** Step 5: the OTHER side's agent. */
  otherSideAgent?:
    | { kind: "UNREPRESENTED" }
    | { kind: "REAL_AGENT"; yentaId: string }
    | { kind: "EXTERNAL_AGENT"; firstName: string; lastName: string; email: string; phoneNumber: string; brokerageName: string; brokerageAddress: string };
  /** Step 7: commission document payer. */
  payer?: {
    role?: PayerRole;
    companyName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneNumber?: string;
  };
  /** The user's listing pre-check answer for SELLER/DUAL/LANDLORD deals. */
  hasActiveListing?: boolean;
}

export interface Person {
  kind?: "person" | "company";
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  phoneNumber?: string;
  address?: string;
}

export interface Gap {
  field: string;
  step: number;
  question: string;
  /** Either a fixed set of options (radio-style) or free_text. */
  options?: Array<{ label: string; description: string }>;
  priority: "required" | "conditional";
}
export interface AppliedDefault {
  field: string;
  value: unknown;
  reason: string;
}
export interface Blocker {
  field: string;
  message: string;
  resolution: string;
}

export interface ValidationResult {
  /** True when there are zero gaps and zero blockers. */
  ready: boolean;
  gaps: Gap[];
  /** Fields the validator populated on the user's behalf; Claude should
   *  surface these in the parse summary so the user can correct if wrong. */
  defaults: AppliedDefault[];
  /** Hard stops. Non-empty blockers[] means DO NOT write to arrakis. */
  blockers: Blocker[];
}

export interface ValidateInput {
  env: Env;
  userPrompt: string;
  answers: DraftAnswers;
}

export function validateDraft(input: ValidateInput): ValidationResult {
  const answers: DraftAnswers = structuredClone(input.answers);
  const gaps: Gap[] = [];
  const defaults: AppliedDefault[] = [];
  const blockers: Blocker[] = [];

  // === Sanity checks FIRST ===
  // Reject obviously-invalid user inputs before we run the "is it present?"
  // rules. An obvious typo (yearBuilt=20011, salePrice=-100, zip=9999999) must
  // not flow downstream — the validator re-asks with the rejected value in
  // the question text so Claude knows to confirm the correction.
  sanityCheckYearBuilt(answers, gaps);
  sanityCheckZip(answers, gaps);
  sanityCheckSalePrice(answers, gaps);
  sanityCheckCommission(answers, gaps);
  sanityCheckDates(answers, gaps);

  // === Normal presence / defaulting rules ===
  resolveAddressFromZip(answers, defaults);
  requireAddressFields(answers, gaps);
  requireYearBuilt(answers, gaps);
  requireMlsNumber(answers, gaps);

  requireDealType(answers, defaults);
  requireSalePrice(answers, gaps);
  inferCurrencyFromState(answers, defaults);
  requirePropertyType(answers, defaults);
  requireRepresentationType(answers, gaps);
  requireSaleCommission(answers, gaps);
  requireListingCommissionForSellerOrDual(answers, gaps);
  defaultDates(answers, defaults);

  listingPreCheck(answers, blockers, gaps);

  requireSeller(answers, defaults, gaps);
  requireBuyerForSale(answers, defaults, gaps);

  requireOwner(answers, blockers);
  requireTeam(answers, blockers);

  requireOtherSideAgentForSingleRep(answers, defaults, gaps);
  requireCommissionPayer(answers, defaults);

  // Dedup: if a sanity check already flagged a field, the later presence rule
  // might have also asked. Keep the sanity-check gap (it carries the typo
  // context).
  const seenFields = new Set<string>();
  const deduped = gaps.filter((g) => {
    if (seenFields.has(g.field)) return false;
    seenFields.add(g.field);
    return true;
  });

  const ready = deduped.length === 0 && blockers.length === 0;
  return { ready, gaps: deduped, defaults, blockers };
}

// === Sanity checks — reject obvious typos early ===

function sanityCheckYearBuilt(a: DraftAnswers, gaps: Gap[]): void {
  const yb = a.address?.yearBuilt;
  if (yb == null) return;
  const current = new Date().getFullYear();
  // Oldest reasonable year: 1600 (historic structures). Newest: current + 2
  // (under construction / pre-built).
  if (!Number.isInteger(yb) || yb < 1600 || yb > current + 2) {
    // Clear the bad value so downstream rules don't use it.
    if (a.address) a.address.yearBuilt = undefined;
    gaps.push({
      field: "address.yearBuilt",
      step: 1,
      priority: "required",
      question: `"${yb}" doesn't look like a real year. Valid range is 1600 to ${current + 2}. What's the actual year built?`,
      options: [
        { label: "I'll type the correct year", description: "Click 'Other' below." },
        { label: "Unknown / skip", description: "Leave blank; fill in Bolt later." },
      ],
    });
  }
}

function sanityCheckZip(a: DraftAnswers, gaps: Gap[]): void {
  const zip = a.address?.zip;
  if (!zip) return;
  const trimmed = zip.trim().toUpperCase();
  const us = /^\d{5}(?:-\d{4})?$/.test(trimmed);
  const ca = /^[ABCEGHJKLMNPRSTVXY]\d[A-Z] ?\d[A-Z]\d$/.test(trimmed);
  if (!us && !ca) {
    if (a.address) a.address.zip = "";
    gaps.push({
      field: "address.zip",
      step: 1,
      priority: "required",
      question: `"${zip}" isn't a valid ZIP/postal code (expected 5-digit US like '10025' or Canadian like 'M5V 3A1'). What's the correct code?`,
      options: [
        { label: "I'll type the correct code", description: "Click 'Other' below." },
      ],
    });
  }
}

function sanityCheckSalePrice(a: DraftAnswers, gaps: Gap[]): void {
  const raw = a.deal?.salePrice?.amount;
  if (!raw) return;
  const n = Number(raw);
  // $100 minimum (sanity floor); $1B ceiling (anything higher is a typo).
  if (!Number.isFinite(n) || n <= 100 || n > 1_000_000_000) {
    if (a.deal?.salePrice) a.deal.salePrice.amount = "";
    gaps.push({
      field: "deal.salePrice",
      step: 2,
      priority: "required",
      question: `Sale price "${raw}" doesn't look right (expected between $100 and $1B). What's the actual sale price, in dollars?`,
      options: [
        { label: "I'll type the correct price", description: "Click 'Other' below." },
      ],
    });
  }
}

function sanityCheckCommission(a: DraftAnswers, gaps: Gap[]): void {
  for (const [key, label] of [
    ["saleCommission", "sale commission"],
    ["listingCommission", "listing commission"],
  ] as const) {
    const c = a.deal?.[key];
    if (!c?.value) continue;
    const n = Number(c.value);
    if (!Number.isFinite(n) || n < 0) {
      if (a.deal && a.deal[key]) a.deal[key] = undefined;
      gaps.push({
        field: `deal.${key}`,
        step: 2,
        priority: "required",
        question: `${label} value "${c.value}" doesn't look right. Must be a non-negative number. What's the correct value?`,
        options: [
          { label: "I'll type the correct value", description: "Click 'Other' below." },
        ],
      });
      continue;
    }
    // If percent, must be 0..100
    if (c.kind === "percent" && n > 100) {
      if (a.deal && a.deal[key]) a.deal[key] = undefined;
      gaps.push({
        field: `deal.${key}`,
        step: 2,
        priority: "required",
        question: `${label} is ${c.value}% — that's over 100%. Did you mean a dollar amount instead?`,
        options: [
          { label: "Fix the percent", description: "Click 'Other' and type the correct %." },
          { label: "It's a flat amount", description: "Click 'Other' and type the dollar amount." },
        ],
      });
    }
  }
}

function sanityCheckDates(a: DraftAnswers, gaps: Gap[]): void {
  const check = (val: string | undefined, field: string, label: string): void => {
    if (!val) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      gaps.push({
        field,
        step: 2,
        priority: "required",
        question: `${label} "${val}" isn't an ISO date (expected yyyy-MM-dd). What's the correct date?`,
        options: [{ label: "I'll type the correct date", description: "Click 'Other'." }],
      });
      return;
    }
    const [y] = val.split("-").map(Number);
    const nowY = new Date().getFullYear();
    if (y < nowY - 5 || y > nowY + 10) {
      gaps.push({
        field,
        step: 2,
        priority: "required",
        question: `${label} year "${y}" looks off (expected between ${nowY - 5} and ${nowY + 10}). Confirm or correct.`,
        options: [{ label: "I'll type the correct date", description: "Click 'Other'." }],
      });
    }
  };
  check(a.deal?.acceptanceDate, "deal.acceptanceDate", "Acceptance date");
  check(a.deal?.closingDate, "deal.closingDate", "Closing date");
}

// === Rule implementations ===

function resolveAddressFromZip(a: DraftAnswers, defaults: AppliedDefault[]): void {
  if (!a.address?.zip) return;
  if (a.address.state && a.address.country) return;
  const guess = guessFromPostalCode(a.address.zip);
  if (!guess) return;
  a.address.state ??= guess.state;
  a.address.country ??= guess.country;
  defaults.push({ field: "address.state", value: guess.state, reason: `derived from ZIP ${a.address.zip}` });
  defaults.push({ field: "address.country", value: guess.country, reason: `derived from ZIP ${a.address.zip}` });
}

function requireAddressFields(a: DraftAnswers, gaps: Gap[]): void {
  if (!a.address?.street) gaps.push(freeTextGap("address.street", 1, "What's the property street address?"));
  if (!a.address?.city) gaps.push(freeTextGap("address.city", 1, "What city is the property in?"));
  if (!a.address?.state) gaps.push(freeTextGap("address.state", 1, "Which state or province? (full name, e.g. 'New York')"));
  if (!a.address?.zip) gaps.push(freeTextGap("address.zip", 1, "What's the ZIP or postal code?"));
}

function requireYearBuilt(a: DraftAnswers, gaps: Gap[]): void {
  // yearBuilt is ALWAYS required for a transaction draft. Although the
  // arrakis error message reads "Year built is required in the USA" and the
  // enforcement lives in `TransactionBuilder.updateYearBuilt`, per user
  // feedback we treat the field as mandatory regardless of country —
  // Bolt's UI also always marks it `*`-required at step 1, and Canadian
  // submits downstream fail without it when other rules kick in.
  if (a.address?.yearBuilt != null) return;
  gaps.push({
    field: "address.yearBuilt",
    step: 1,
    priority: "required",
    question: "What year was the property built?",
    options: [
      { label: "2020", description: "Recent build" },
      { label: "2000", description: "~25 years old" },
      { label: "1970", description: "Older build" },
      { label: "I'll type the year", description: "Click 'Other' and enter, e.g. 1948" },
    ],
  });
}

function requireMlsNumber(a: DraftAnswers, gaps: Gap[]): void {
  // arrakis: mlsNumber is OPTIONAL. Bolt UI marks it `*`-required with
  // literal "N/A" allowed. Ask as conditional.
  if (a.address?.mlsNumber) return;
  gaps.push({
    field: "address.mlsNumber",
    step: 1,
    priority: "conditional",
    question: "MLS number? (Bolt asks; accepts literal 'N/A' for exclusive/non-MLS deals; arrakis accepts without)",
    options: [
      { label: "N/A (exclusive / non-MLS deal)", description: "Bolt accepts the literal string 'N/A'." },
      { label: "Provide MLS number", description: "Click 'Other' below and type the MLS #." },
      { label: "Skip", description: "Draft saves without it; user fills in Bolt later" },
    ],
  });
}

function requireDealType(a: DraftAnswers, defaults: AppliedDefault[]): void {
  if (a.deal?.dealType) return;
  const rep = a.deal?.representationType;
  const inferred: DealType = rep === "TENANT" || rep === "LANDLORD" ? "LEASE" : "SALE";
  a.deal = a.deal ?? {};
  a.deal.dealType = inferred;
  defaults.push({ field: "deal.dealType", value: inferred, reason: rep === "TENANT" || rep === "LANDLORD" ? "representation side implies LEASE" : "SALE default" });
}

function requireSalePrice(a: DraftAnswers, gaps: Gap[]): void {
  if (a.deal?.salePrice?.amount) return;
  gaps.push(freeTextGap("deal.salePrice", 2, "What was the sale price, in dollars?"));
}

function inferCurrencyFromState(a: DraftAnswers, defaults: AppliedDefault[]): void {
  if (a.deal?.salePrice?.currency) return;
  const currency: Currency = a.address?.country === "CANADA" ? "CAD" : "USD";
  a.deal = a.deal ?? {};
  a.deal.salePrice = a.deal.salePrice ?? { amount: "", currency };
  a.deal.salePrice.currency = currency;
  defaults.push({ field: "deal.salePrice.currency", value: currency, reason: a.address?.country === "CANADA" ? "Canadian province → CAD" : "US state → USD" });
}

function requirePropertyType(a: DraftAnswers, defaults: AppliedDefault[]): void {
  if (a.deal?.propertyType) return;
  a.deal = a.deal ?? {};
  a.deal.propertyType = "RESIDENTIAL";
  defaults.push({
    field: "deal.propertyType",
    value: "RESIDENTIAL",
    reason: "Residential default. arrakis enum accepts RESIDENTIAL, COMMERCIAL, LAND_LOT, CONDO, MOBILE_HOME, NEW_CONSTRUCTION — override if the prompt names one of those.",
  });
}

function requireRepresentationType(a: DraftAnswers, gaps: Gap[]): void {
  if (a.deal?.representationType) return;
  gaps.push({
    field: "deal.representationType",
    step: 2,
    priority: "required",
    question: "Which side are you representing? This affects commission math — cannot be defaulted.",
    options: [
      { label: "Buyer's agent", description: "You represent the buyer only." },
      { label: "Seller's agent", description: "You represent the seller only. REQUIRES an in-contract listing in Bolt." },
      { label: "Dual (both sides)", description: "You represent both buyer and seller. REQUIRES listing + both commissions." },
    ],
  });
}

function requireSaleCommission(a: DraftAnswers, gaps: Gap[]): void {
  if (a.deal?.saleCommission?.value) return;
  gaps.push(freeTextGap("deal.saleCommission", 2, "What's the sale commission? (percent like '2.5' or flat amount like '$20000')"));
}

function requireListingCommissionForSellerOrDual(a: DraftAnswers, gaps: Gap[]): void {
  const rep = a.deal?.representationType;
  if (rep !== "SELLER" && rep !== "DUAL") return;
  if (a.deal?.listingCommission?.value) return;
  gaps.push(freeTextGap("deal.listingCommission", 2, "What's the listing commission? (required for SELLER / DUAL rep)"));
}

function defaultDates(a: DraftAnswers, defaults: AppliedDefault[]): void {
  a.deal = a.deal ?? {};
  const today = new Date();
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  if (!a.deal.acceptanceDate) {
    a.deal.acceptanceDate = iso(today);
    defaults.push({ field: "deal.acceptanceDate", value: a.deal.acceptanceDate, reason: "defaulted to today; edit in Bolt if wrong" });
  }
  if (!a.deal.closingDate) {
    const closing = new Date(today);
    closing.setDate(closing.getDate() + 45);
    a.deal.closingDate = iso(closing);
    defaults.push({ field: "deal.closingDate", value: a.deal.closingDate, reason: "defaulted to today + 45d; edit in Bolt if wrong" });
  }
}

/**
 * NO-OP now. Prior version blocked/asked when rep was SELLER/DUAL/LANDLORD
 * and the user hadn't confirmed an in-contract listing. That was the wrong
 * UX — the MCP now creates + submits the listing autonomously (via the
 * `submit_draft` + `transition_listing` + `build_transaction_from_listing`
 * tools) when the user asks for a seller-side transaction. The validator
 * only blocks if arrakis itself returns an error we can't resolve.
 *
 * Kept as a no-op documentation stub so the call site in `validateDraft`
 * reads the same. The runbook's autonomous chain (see
 * `create_transaction.md` step 7a "Seller-side autonomous chain") drives
 * the end-to-end listing → transaction sequence.
 */
function listingPreCheck(_a: DraftAnswers, _blockers: Blocker[], _gaps: Gap[]): void {
  // intentionally empty — handled by runbook, not validator
}

function requireSeller(a: DraftAnswers, defaults: AppliedDefault[], gaps: Gap[]): void {
  if (a.sellers && a.sellers.length > 0) return;
  const rep = a.deal?.representationType;
  // Buyer-side deals: seller identity usually unknown at draft time. Use Unknown placeholder.
  if (rep === "BUYER" || rep === "TENANT") {
    const address = a.address?.street
      ? `${a.address.street}${a.address.city ? ", " + a.address.city : ""}`
      : undefined;
    a.sellers = [{ kind: "person", firstName: "Unknown", lastName: "Seller", address }];
    defaults.push({ field: "sellers", value: a.sellers, reason: "buyer-side deal: defaulted to 'Unknown Seller' at property address; edit in Bolt if you know the seller" });
    return;
  }
  // Seller-side: we need the seller's actual name.
  gaps.push(freeTextGap("sellers", 3, "What's the seller's first + last name? (or company name)"));
}

function requireBuyerForSale(a: DraftAnswers, defaults: AppliedDefault[], gaps: Gap[]): void {
  if (a.deal?.dealType !== "SALE") return;
  if (a.buyers && a.buyers.length > 0) return;
  const rep = a.deal?.representationType;
  // Seller-side: buyer identity usually unknown at draft time.
  if (rep === "SELLER") {
    a.buyers = [{ kind: "person", firstName: "Unknown", lastName: "Buyer" }];
    defaults.push({ field: "buyers", value: a.buyers, reason: "seller-side deal: defaulted to 'Unknown Buyer'; edit in Bolt when known" });
    return;
  }
  gaps.push(freeTextGap("buyers", 3, "What's the buyer's first + last name? (or company name)"));
}

function requireOwner(a: DraftAnswers, blockers: Blocker[]): void {
  if (a.owner?.yentaId) return;
  blockers.push({
    field: "owner.yentaId",
    message: "Owner agent (you) couldn't be resolved. verify_auth / pre_flight should populate this from yenta /users/me.",
    resolution: "Ensure verify_auth was called at pre-flight and the user is signed in to the target env. If verify_auth returned no user, the yenta token may be invalid — re-login.",
  });
}

function requireTeam(_a: DraftAnswers, _blockers: Blocker[]): void {
  // NO-OP (kept as doc). Earlier version blocked when teamId was missing.
  // Corrected per arrakis OpenAPI: teamId is OPTIONAL on
  // TransactionOwnerAgentInfoRequest. arrakis saves the draft fine without
  // it. Bolt's step 4 UI does mark Team as `*`-required, so the user will
  // need to pick one in Bolt before submitting — but that's a UI-level
  // finalize step, not a draft-creation blocker. The MCP creates drafts;
  // users submit in Bolt. Blocking here would prevent any draft for agents
  // who legitimately aren't on a team yet.
}

function requireOtherSideAgentForSingleRep(a: DraftAnswers, defaults: AppliedDefault[], gaps: Gap[]): void {
  const rep = a.deal?.representationType;
  const singleRep = rep === "BUYER" || rep === "SELLER" || rep === "TENANT" || rep === "LANDLORD";
  if (!singleRep) return;
  if (a.otherSideAgent) return;
  a.otherSideAgent = { kind: "UNREPRESENTED" };
  defaults.push({
    field: "otherSideAgent",
    value: a.otherSideAgent,
    reason: "defaulted to Unrepresented; override if the other side has a listing/selling agent",
  });
}

function requireCommissionPayer(a: DraftAnswers, defaults: AppliedDefault[]): void {
  if (a.payer?.role) return;
  // IMPORTANT: arrakis's TransactionBuilder.validate() has the commission-payer
  // presence check COMMENTED OUT (line ~644 of TransactionBuilder.java):
  //
  //   if (this.getCommissionPayerInfo() == null) {
  //     //ignore this for now until we remove skyslope all tests have no commission payer on the builder
  //     //throw new InvalidUserArgumentException("commissionPayer needs to be presented");
  //   }
  //
  // Meanwhile, `CommissionPayerInfoRequestValidator` REQUIRES all of role,
  // firstName, lastName, companyName, email, phoneNumber when creating a NEW
  // participant. So if we default to a placeholder (e.g. "Title Company TBD"
  // without an email), the bean validator rejects the payload and the flow
  // breaks.
  //
  // The safe path: do NOT set a default payer. The MCP simply skips the
  // `add_commission_payer_participant` + `set_commission_payer` calls when
  // there's no real payer info. Arrakis saves the draft fine; the user fills
  // the payer in Bolt via its "I Don't Have The Information Yet" checkbox
  // flow after opening the draft URL.
  const isCanada = a.address?.country === "CANADA";
  const dealType = a.deal?.dealType;
  if (dealType === "LEASE") {
    // LEASE payer flow: claude asks role directly (LANDLORD/TENANT/MGMT_CO).
    return;
  }
  defaults.push({
    field: "payer",
    value: null,
    reason: `No default payer set — arrakis commissionPayer is optional at submit. User fills in Bolt via 'I Don't Have The Information Yet' after draft creation. (Typical role for ${isCanada ? "Canadian" : "US"} SALE: ${isCanada ? "SELLERS_LAWYER" : "TITLE"}.)`,
  });
}

function freeTextGap(field: string, step: number, question: string): Gap {
  return {
    field,
    step,
    priority: "required",
    question,
    options: [
      { label: "I'll type the answer", description: "Click 'Other' and enter the value." },
      { label: "Skip for now", description: "Default/placeholder will be used; edit in Bolt later." },
    ],
  };
}

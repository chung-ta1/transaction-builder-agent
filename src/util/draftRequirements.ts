import { guessFromPostalCode } from "./zipLookup.js";
import type { Env } from "../config.js";

// arrakis enums (do not invent values; arrakis rejects anything outside)
export type DealType = "SALE" | "LEASE" | "REFERRAL" | "COMPENSATING" | "COMMERCIAL_LEASE" | "PLOT" | "OTHER" | "INTERNAL_REFERRAL";
export type Representation = "SELLER" | "BUYER" | "DUAL" | "TENANT" | "LANDLORD";
export type Country = "UNITED_STATES" | "CANADA";
export type Currency = "USD" | "CAD";
export type PropertyType = "RESIDENTIAL" | "COMMERCIAL" | "LAND_LOT" | "CONDO" | "MOBILE_HOME" | "NEW_CONSTRUCTION";

export interface Person { kind?: "person" | "company"; firstName?: string; lastName?: string; companyName?: string; email?: string; phoneNumber?: string; address?: string; }

export interface DraftAnswers {
  address?: { street?: string; street2?: string; unit?: string; city?: string; state?: string; zip?: string; country?: Country; yearBuilt?: number; mlsNumber?: string; escrowNumber?: string; };
  deal?: { dealType?: DealType; salePrice?: { amount: string; currency: Currency }; propertyType?: PropertyType; representationType?: Representation; saleCommission?: { kind: "percent" | "amount"; value: string }; listingCommission?: { kind: "percent" | "amount"; value: string }; acceptanceDate?: string; closingDate?: string; requiresInstallments?: boolean; };
  sellers?: Person[];
  buyers?: Person[];
  owner?: { yentaId?: string; officeId?: string; teamId?: string };
  partners?: Array<{ agentId: string; side: "BUYERS_AGENT" | "SELLERS_AGENT" | "TENANT_AGENT" | "DUAL" }>;
  referral?: { kind: "internal" | "external"; agentId?: string } | null;
  otherSideAgent?: { kind: "UNREPRESENTED" } | { kind: "REAL_AGENT"; yentaId: string } | { kind: "EXTERNAL_AGENT"; firstName: string; lastName: string; email: string; phoneNumber: string; brokerageName: string; brokerageAddress: string };
  payer?: { role?: string; companyName?: string; firstName?: string; lastName?: string; email?: string; phoneNumber?: string };
  hasActiveListing?: boolean;
}

export interface Gap { field: string; step: number; question: string; options?: Array<{ label: string; description: string }>; priority: "required" | "conditional"; }
export interface AppliedDefault { field: string; value: unknown; reason: string; }
export interface Blocker { field: string; message: string; resolution: string; }
export interface ValidationResult { ready: boolean; gaps: Gap[]; softGaps: Gap[]; defaults: AppliedDefault[]; blockers: Blocker[]; }

/** One row in `memory/user-patterns.md:address_history`. Same address →
 * same yearBuilt, full stop. Looked up by `${zip}|${lowercased street}`. */
export interface AddressHistoryEntry {
  key: string;
  yearBuilt?: number;
  lastMlsNumber?: string;
  teamId?: string;
  lastUsed?: string;
  useCount?: number;
}

/** Subset of yenta /users/me used to seed defaults on the first draft.
 *  Pulled from `pre_flight.auth.user` so the runbook passes it through. */
export interface AgentProfile {
  yentaId?: string;
  country?: string;          // "UNITED_STATES" | "CANADA"
  agentStatus?: string;      // "ACTIVE" | "CANDIDATE" | "INACTIVE" | ...
  officeId?: string;
  teamId?: string;
  teams?: Array<{ teamId: string; name: string; teamType?: string; flex?: boolean }>;
}

export interface ValidateInput {
  env: Env;
  userPrompt: string;
  answers: DraftAnswers;
  /** Per-address cache so repeat properties auto-fill yearBuilt/MLS without
   *  asking. Caller reads from `memory/user-patterns.md:address_history`. */
  addressHistory?: AddressHistoryEntry[];
  /** Agent profile from pre_flight.auth.user. When supplied, the validator
   *  seeds owner.officeId/teamId and country from the user's yenta record,
   *  and fails early on CANDIDATE/INACTIVE status. */
  agentProfile?: AgentProfile;
}

/** Build the lookup key the same way readers + writers do. Idempotent on
 *  whitespace + case so "123 Main St" and "  123 main st  " collide. */
export function addressHistoryKey(zip: string, street: string): string {
  return `${zip.trim().toUpperCase()}|${street.trim().toLowerCase()}`;
}

/**
 * Pure validator. Returns hard `gaps` (block create), `softGaps` (surface
 * post-create — yearBuilt, MLS, etc.), `defaults` applied silently, and
 * `blockers` (do not write to arrakis). The runbook fires create as soon as
 * gaps + blockers are empty; soft gaps become a "still required before submit"
 * list shown after the draft URL.
 */
export function validateDraft(input: ValidateInput): ValidationResult {
  const a: DraftAnswers = structuredClone(input.answers);
  const gaps: Gap[] = [], softGaps: Gap[] = [], defaults: AppliedDefault[] = [], blockers: Blocker[] = [];

  // Normalize commission inputs before any commission logic runs. Callers may
  // pass the arrakis price-date shape ({ percentEnabled, commissionPercent |
  // commissionAmount }) rather than the validator's { kind, value }; coerce so a
  // commission that WAS provided isn't read as missing (which forced a spurious
  // re-ask of a value the user already gave).
  if (a.deal) {
    a.deal.saleCommission = coerceCommission(a.deal.saleCommission);
    a.deal.listingCommission = coerceCommission(a.deal.listingCommission);
  }

  // Sanity checks: reject obvious typos before downstream rules use the value.
  sanityYearBuilt(a, gaps);
  sanityZip(a, gaps);
  sanitySalePrice(a, gaps);
  sanityCommission(a, gaps);
  sanityDates(a, gaps);

  // Agent profile from yenta: seed owner identity + country + early-blocker
  // on CANDIDATE/INACTIVE status. Runs before address resolution so a
  // cross-country prompt (e.g. agent registered US, property in Canada)
  // produces a clear blocker.
  if (input.agentProfile) {
    const p = input.agentProfile;
    if (p.agentStatus && !["ACTIVE", "WORKING"].includes(p.agentStatus.toUpperCase())) {
      blockers.push({
        field: "owner.agentStatus",
        message: `Your yenta account is ${p.agentStatus}; arrakis won't accept a transaction owned by this status.`,
        resolution: "Wait for your account to be activated, or sign in as a different (ACTIVE) agent via `pre_flight` with `forceFresh: true`.",
      });
    }
    a.owner ??= {};
    if (!a.owner.yentaId && p.yentaId) {
      a.owner.yentaId = p.yentaId;
      defaults.push({ field: "owner.yentaId", value: p.yentaId, reason: "from yenta /users/me" });
    }
    if (!a.owner.officeId && p.officeId) {
      a.owner.officeId = p.officeId;
      defaults.push({ field: "owner.officeId", value: p.officeId, reason: "yenta default office" });
    }
    // Single-team auto-resolve: user on exactly one team → use silently.
    if (!a.owner.teamId && p.teams && p.teams.length === 1) {
      a.owner.teamId = p.teams[0].teamId;
      defaults.push({ field: "owner.teamId", value: p.teams[0].teamId, reason: `only team: ${p.teams[0].name}` });
    }
    // Country auto-default: from yenta if address doesn't carry one.
    if (a.address && !a.address.country && p.country) {
      a.address.country = p.country as Country;
      defaults.push({ field: "address.country", value: p.country, reason: "agent's registered country" });
    }
  }

  // ZIP → state/country/currency.
  if (a.address?.zip && (!a.address.state || !a.address.country)) {
    const guess = guessFromPostalCode(a.address.zip);
    if (guess) {
      a.address.state ??= guess.state;
      a.address.country ??= guess.country;
      defaults.push({ field: "address.state", value: guess.state, reason: `derived from ZIP ${a.address.zip}` });
    }
  }

  // Per-address cache: zip + street → prior yearBuilt / MLS. Same property
  // always has the same year built; this kills the most common soft gap on
  // repeat addresses.
  if (a.address?.zip && a.address?.street && input.addressHistory?.length) {
    const key = addressHistoryKey(a.address.zip, a.address.street);
    const hit = input.addressHistory.find((h) => h.key === key);
    if (hit) {
      if (a.address.yearBuilt == null && hit.yearBuilt != null) {
        a.address.yearBuilt = hit.yearBuilt;
        defaults.push({ field: "address.yearBuilt", value: hit.yearBuilt, reason: `prior draft at this address (used ${hit.useCount ?? 1}×)` });
      }
      if (!a.address.mlsNumber && hit.lastMlsNumber) {
        a.address.mlsNumber = hit.lastMlsNumber;
        defaults.push({ field: "address.mlsNumber", value: hit.lastMlsNumber, reason: `prior draft at this address (used ${hit.useCount ?? 1}×)` });
      }
    }
  }

  // Address: hard requirement (zod requires street/city/state/zip on PUT /location-info).
  if (!a.address?.street) gaps.push(freeText("address.street", 1, "What's the property street address?"));
  if (!a.address?.city) gaps.push(freeText("address.city", 1, "What city is the property in?"));
  if (!a.address?.state) gaps.push(freeText("address.state", 1, "Which state or province? (full name)"));
  if (!a.address?.zip) gaps.push(freeText("address.zip", 1, "What's the ZIP or postal code?"));

  // yearBuilt: SOFT — arrakis location-info accepts it later; the runbook
  // surfaces it (offering typical_year_built as a one-click default).
  if (a.address?.yearBuilt == null) softGaps.push({ field: "address.yearBuilt", step: 1, priority: "required", question: "Year built" });
  // MLS: HARD for non-referral deals — arrakis rejects a null MLS at submit
  // ("mls number can't be null in Transaction"), so resolve it BEFORE create
  // rather than letting submit fail. "N/A" is the valid answer for an off-MLS /
  // exclusive deal. Referrals carry no MLS, so it stays soft there.
  const mlsRequired = a.deal?.dealType !== "REFERRAL" && a.deal?.dealType !== "INTERNAL_REFERRAL";
  if (!a.address?.mlsNumber) {
    if (mlsRequired) {
      gaps.push({ field: "address.mlsNumber", step: 1, priority: "required", question: "MLS number? ('N/A' for an off-MLS / exclusive deal)", options: [
        { label: "N/A — off-MLS / exclusive", description: "Off-market or exclusive listing." },
        { label: "I'll enter the MLS number", description: "Click 'Other' and type it." },
      ] });
    } else {
      softGaps.push({ field: "address.mlsNumber", step: 1, priority: "conditional", question: "MLS number (or 'N/A')" });
    }
  }

  // Deal defaults + hard requirements (zod requires dealType/salePrice/saleCommission/representation on PUT /price-date-info).
  a.deal ??= {};
  if (!a.deal.dealType) {
    const inferred: DealType = a.deal.representationType === "TENANT" || a.deal.representationType === "LANDLORD" ? "LEASE" : "SALE";
    a.deal.dealType = inferred;
    defaults.push({ field: "deal.dealType", value: inferred, reason: "default" });
  }
  if (!a.deal.salePrice?.amount) gaps.push(freeText("deal.salePrice", 2, "Sale price in dollars?"));
  if (!a.deal.salePrice?.currency) {
    const cur: Currency = a.address?.country === "CANADA" ? "CAD" : "USD";
    a.deal.salePrice = { amount: a.deal.salePrice?.amount ?? "", currency: cur };
    defaults.push({ field: "deal.salePrice.currency", value: cur, reason: "country → currency" });
  }
  if (!a.deal.propertyType) {
    a.deal.propertyType = "RESIDENTIAL";
    defaults.push({ field: "deal.propertyType", value: "RESIDENTIAL", reason: "default" });
  }
  // Payment type ("How Will This Transaction Be Paid?") is required at submit —
  // Bolt blocks with "Please select an option" if unset. Default to Single
  // Payment (full payment at closing = no installments). The runbook only
  // flips this to true when the prompt says installments/sub-transactions.
  if (a.deal.requiresInstallments == null) {
    a.deal.requiresInstallments = false;
    defaults.push({ field: "deal.requiresInstallments", value: false, reason: "Single Payment (full payment at closing) — default; flip to Multiple only if prompt says installments" });
  }
  if (!a.deal.representationType) {
    gaps.push({ field: "deal.representationType", step: 2, priority: "required", question: "Which side are you representing?", options: [
      { label: "Buyer's agent", description: "Buyer only" },
      { label: "Seller's agent", description: "Requires in-contract listing" },
      { label: "Dual", description: "Both sides" },
    ]});
  }
  if (!a.deal.saleCommission?.value) gaps.push(freeText("deal.saleCommission", 2, "Sale commission? (e.g. '2.5%' or '$20000')"));
  const rep = a.deal.representationType;
  if ((rep === "SELLER" || rep === "DUAL") && !a.deal.listingCommission?.value) {
    gaps.push(freeText("deal.listingCommission", 2, "Listing commission?"));
  }
  // Default dates (SOFT — runbook can omit and surface post-create).
  const today = new Date(), iso = (d: Date) => d.toISOString().slice(0, 10);
  a.deal.acceptanceDate ??= iso(today);
  if (!input.answers.deal?.acceptanceDate) defaults.push({ field: "deal.acceptanceDate", value: a.deal.acceptanceDate, reason: "today" });
  if (!a.deal.closingDate) {
    const c = new Date(today); c.setDate(c.getDate() + 45);
    a.deal.closingDate = iso(c);
    defaults.push({ field: "deal.closingDate", value: a.deal.closingDate, reason: "today + 45d" });
  }

  // People: defaults for Unknown buyer/seller; ask if seller-side and seller missing.
  if (!a.sellers?.length) {
    if (rep === "BUYER" || rep === "TENANT") {
      a.sellers = [{ kind: "person", firstName: "Unknown", lastName: "Seller", address: a.address?.street }];
      defaults.push({ field: "sellers", value: a.sellers, reason: "buyer-side: defaulted to Unknown Seller" });
    } else {
      gaps.push(freeText("sellers", 3, "Seller's first + last name? (or company)"));
    }
  }
  if (a.deal.dealType === "SALE" && !a.buyers?.length) {
    // Symmetric with Unknown Seller for buyer-side: at draft time the buyer
    // is often not formally identified yet (ATS, contract pending). User
    // edits in Bolt or via /update-draft when the name is known.
    a.buyers = [{ kind: "person", firstName: "Unknown", lastName: "Buyer" }];
    const reason = rep === "SELLER"
      ? "seller-side: defaulted to Unknown Buyer"
      : "buyer name not provided — placeholder; edit in Bolt when known";
    defaults.push({ field: "buyers", value: a.buyers, reason });
  }

  // Owner: hard blocker (auth must populate).
  if (!a.owner?.yentaId) blockers.push({ field: "owner.yentaId", message: "Owner agent (you) couldn't be resolved.", resolution: "Re-run pre_flight; if still missing, sign in to the target env." });

  // Other-side agent: default Unrepresented for single-rep.
  if ((rep === "BUYER" || rep === "SELLER" || rep === "TENANT" || rep === "LANDLORD") && !a.otherSideAgent) {
    a.otherSideAgent = { kind: "UNREPRESENTED" };
    defaults.push({ field: "otherSideAgent", value: a.otherSideAgent, reason: "defaulted to Unrepresented" });
  }

  // Commission payer: never default (we can't fabricate a real title/brokerage
  // contact). The bean validator requires all 6 fields if a payer is set, so we
  // skip rather than half-set. submit does NOT silently accept a null payer — it
  // succeeds but parks the transaction in NEW with a CRITICAL "Commission Payer
  // information is missing" until it's added. So surface it as a SOFT gap (never
  // a hard block — the create still proceeds): the runbook lists it under "still
  // required before submit" and the agent collects it (wire_commission_payer) or
  // the user knowingly defers to Bolt. Referrals disburse differently and don't
  // need a payer here.
  const dealNeedsPayer = a.deal?.dealType !== "REFERRAL" && a.deal?.dealType !== "INTERNAL_REFERRAL";
  if (dealNeedsPayer && !a.payer?.companyName) {
    softGaps.push({ field: "payer", step: 8, priority: "required", question: "Commission payer (the title company / party that disburses payment to Real) — required before the transaction can leave NEW; add now or in Bolt" });
  }

  // Dedupe gaps by field.
  const seen = new Set<string>();
  const uniqGaps = gaps.filter((g) => seen.has(g.field) ? false : (seen.add(g.field), true));

  return { ready: uniqGaps.length === 0 && blockers.length === 0, gaps: uniqGaps, softGaps, defaults, blockers };
}

// === Sanity checks (reject obvious typos) ===
function sanityYearBuilt(a: DraftAnswers, gaps: Gap[]): void {
  const yb = a.address?.yearBuilt;
  if (yb == null) return;
  const cur = new Date().getFullYear();
  if (!Number.isInteger(yb) || yb < 1600 || yb > cur + 2) {
    if (a.address) a.address.yearBuilt = undefined;
    gaps.push({ field: "address.yearBuilt", step: 1, priority: "required",
      question: `"${yb}" doesn't look like a real year (1600–${cur + 2}). What's the actual year built?`,
      options: [{ label: "I'll type the correct year", description: "Click 'Other'." }] });
  }
}
function sanityZip(a: DraftAnswers, gaps: Gap[]): void {
  const z = a.address?.zip;
  if (!z) return;
  const t = z.trim().toUpperCase();
  if (!/^\d{5}(?:-\d{4})?$/.test(t) && !/^[ABCEGHJKLMNPRSTVXY]\d[A-Z] ?\d[A-Z]\d$/.test(t)) {
    if (a.address) a.address.zip = "";
    gaps.push({ field: "address.zip", step: 1, priority: "required",
      question: `"${z}" isn't a valid ZIP/postal code. Correct?`,
      options: [{ label: "I'll type the correct code", description: "Click 'Other'." }] });
  }
}
function sanitySalePrice(a: DraftAnswers, gaps: Gap[]): void {
  const raw = a.deal?.salePrice?.amount;
  if (!raw) return;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 100 || n > 1_000_000_000) {
    if (a.deal?.salePrice) a.deal.salePrice.amount = "";
    gaps.push({ field: "deal.salePrice", step: 2, priority: "required",
      question: `Sale price "${raw}" doesn't look right ($100–$1B). Actual price?`,
      options: [{ label: "I'll type the correct price", description: "Click 'Other'." }] });
  }
}
/**
 * Accept either the validator's native commission shape ({ kind, value }) or
 * the arrakis price-date shape ({ percentEnabled, commissionPercent,
 * commissionAmount }). Returns normalized { kind, value }, or undefined when no
 * usable commission is present.
 */
function coerceCommission(c: unknown): { kind: "percent" | "amount"; value: string } | undefined {
  if (!c || typeof c !== "object") return undefined;
  const o = c as Record<string, unknown>;
  if (typeof o.value === "string" && (o.kind === "percent" || o.kind === "amount")) {
    return { kind: o.kind, value: o.value };
  }
  if (o.commissionPercent != null && o.percentEnabled !== false) {
    return { kind: "percent", value: String(o.commissionPercent) };
  }
  const amt = o.commissionAmount as { amount?: unknown } | null | undefined;
  if (amt && amt.amount != null) {
    return { kind: "amount", value: String(amt.amount) };
  }
  return undefined;
}

function sanityCommission(a: DraftAnswers, gaps: Gap[]): void {
  for (const [key, label] of [["saleCommission", "sale commission"], ["listingCommission", "listing commission"]] as const) {
    const c = a.deal?.[key];
    if (!c?.value) continue;
    const n = Number(c.value);
    if (!Number.isFinite(n) || n < 0) {
      if (a.deal && a.deal[key]) a.deal[key] = undefined;
      gaps.push({ field: `deal.${key}`, step: 2, priority: "required",
        question: `${label} "${c.value}" must be non-negative. Correct value?`,
        options: [{ label: "I'll type the correct value", description: "Click 'Other'." }] });
      continue;
    }
    if (c.kind === "percent" && n > 100) {
      if (a.deal && a.deal[key]) a.deal[key] = undefined;
      gaps.push({ field: `deal.${key}`, step: 2, priority: "required",
        question: `${label} is ${c.value}% — over 100%. Did you mean a flat amount?`,
        options: [{ label: "Fix the percent", description: "Click 'Other'." }, { label: "It's a flat amount", description: "Click 'Other'." }] });
    }
  }
}
function sanityDates(a: DraftAnswers, gaps: Gap[]): void {
  const check = (val: string | undefined, field: string, label: string): void => {
    if (!val) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      gaps.push({ field, step: 2, priority: "required",
        question: `${label} "${val}" isn't ISO yyyy-MM-dd. Correct?`,
        options: [{ label: "I'll type the correct date", description: "Click 'Other'." }] });
      return;
    }
    const y = Number(val.split("-")[0]);
    const now = new Date().getFullYear();
    if (y < now - 5 || y > now + 10) {
      gaps.push({ field, step: 2, priority: "required",
        question: `${label} year "${y}" looks off (${now - 5}–${now + 10}). Confirm?`,
        options: [{ label: "I'll type the correct date", description: "Click 'Other'." }] });
    }
  };
  check(a.deal?.acceptanceDate, "deal.acceptanceDate", "Acceptance date");
  check(a.deal?.closingDate, "deal.closingDate", "Closing date");
}

function freeText(field: string, step: number, question: string): Gap {
  return { field, step, priority: "required", question,
    options: [{ label: "I'll type the answer", description: "Click 'Other'." }, { label: "Skip for now", description: "Default applied; edit in Bolt." }] };
}

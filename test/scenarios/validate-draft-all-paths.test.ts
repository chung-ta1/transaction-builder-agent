import { describe, expect, it } from "vitest";
import {
  validateDraft,
  type DraftAnswers,
  type ValidationResult,
} from "../../src/util/draftRequirements.js";

/**
 * Exhaustive coverage of every transaction / listing / referral path through
 * the validator. Asserts both positive paths (ready=true) and negative paths
 * (expected gaps/blockers). Authoritative inputs from:
 *   - arrakis request DTOs (required fields)
 *   - arrakis TransactionBuilder.validate() (service-layer rules)
 *   - arrakis ListingGeneralValidator (listing participant rules)
 *   - arrakis DualRepresentationAgentCommissionValidation (DUAL rules)
 *   - arrakis CreateReferralHandlerTest (referral participant canonical shape)
 *   - Live Playwright walkthrough of Bolt (UI-level requirements noted as
 *     "conditional" gaps rather than blockers).
 *
 * Each test names the flow variant it covers so gap coverage is easy to audit.
 */

const FAKE_OWNER = {
  yentaId: "00000000-0000-0000-0000-000000000001",
  officeId: "00000000-0000-0000-0000-000000000002",
  teamId: "00000000-0000-0000-0000-000000000003",
};

function run(answers: DraftAnswers): ValidationResult {
  return validateDraft({ env: "team1", userPrompt: "test", answers });
}

function gapFields(r: ValidationResult): string[] {
  return r.gaps.map((g) => g.field).sort();
}

function blockerFields(r: ValidationResult): string[] {
  return r.blockers.map((b) => b.field).sort();
}

function defaultFields(r: ValidationResult): string[] {
  return r.defaults.map((d) => d.field).sort();
}

describe("validateDraft — Transaction flows", () => {
  describe("BUYER + SALE (US)", () => {
    it("ready when address + price + commission + buyer given, with Unknown Seller default", () => {
      // Buyer-side agent knows their client (the buyer). Validator still asks
      // for buyer name, so include it.
      const r = run({
        address: {
          street: "123 Main St",
          city: "New York",
          state: "NEW_YORK",
          zip: "10025",
          country: "UNITED_STATES",
          yearBuilt: 1948,
          mlsNumber: "N/A",
        },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "USD" },
          propertyType: "RESIDENTIAL",
          representationType: "BUYER",
          saleCommission: { kind: "percent", value: "3" },
        },
        buyers: [{ firstName: "Jane", lastName: "Doe" }],
        owner: FAKE_OWNER,
      });
      expect(r.ready).toBe(true);
      expect(r.blockers).toEqual([]);
      expect(defaultFields(r)).toContain("sellers");
      expect(defaultFields(r)).toContain("otherSideAgent");
      expect(defaultFields(r)).toContain("payer");
      // payer default is NULL — we skip add_commission_payer_participant
      // because arrakis's bean validator requires all 6 fields and the
      // commission-payer presence check in validate() is commented out.
      const payerDefault = r.defaults.find((d) => d.field === "payer");
      expect(payerDefault?.value).toBeNull();
    });

    it("gaps list sale price + year built + MLS when prompt omits them", () => {
      const r = run({
        address: {
          street: "123 Main St",
          city: "New York",
          state: "NEW_YORK",
          zip: "10025",
          country: "UNITED_STATES",
        },
        deal: {
          dealType: "SALE",
          representationType: "BUYER",
        },
        owner: FAKE_OWNER,
      });
      expect(r.ready).toBe(false);
      expect(gapFields(r)).toEqual(
        expect.arrayContaining([
          "address.mlsNumber",
          "address.yearBuilt",
          "deal.salePrice",
          "deal.saleCommission",
        ]),
      );
    });

    it("state + country auto-fill from ZIP when given only zip", () => {
      const r = run({
        address: { zip: "10025", street: "123 Main St", city: "NY" },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "USD" },
          representationType: "BUYER",
          saleCommission: { kind: "percent", value: "3" },
        },
        owner: FAKE_OWNER,
      });
      expect(defaultFields(r)).toEqual(
        expect.arrayContaining(["address.state", "address.country"]),
      );
    });

    it("dates, property type auto-default; currency auto when omitted", () => {
      // Note: if priceAndDates.salePrice.currency is set explicitly, it won't
      // appear in defaults. Test the omitted-currency case separately.
      const r = run({
        address: {
          street: "1", city: "Miami", state: "FLORIDA", zip: "33101",
          country: "UNITED_STATES", yearBuilt: 2000, mlsNumber: "N/A",
        },
        deal: {
          dealType: "SALE",
          // no salePrice given → currency will be defaulted
          representationType: "BUYER",
          saleCommission: { kind: "percent", value: "3" },
        },
        buyers: [{ firstName: "J", lastName: "D" }],
        owner: FAKE_OWNER,
      });
      expect(defaultFields(r)).toEqual(
        expect.arrayContaining([
          "deal.acceptanceDate",
          "deal.closingDate",
          "deal.propertyType",
          "deal.salePrice.currency",
        ]),
      );
    });
  });

  describe("BUYER + SALE (Canada)", () => {
    it("currency is CAD when country is CANADA; yearBuilt still required per user policy", () => {
      // yearBuilt is ALWAYS required for transaction drafts (user decision
      // 2026-04-17). Even though arrakis's explicit enforcement message
      // mentions the USA, we treat the field as mandatory regardless of
      // country — matches Bolt UI and prevents downstream surprises.
      const r = run({
        address: {
          street: "1", city: "Toronto", state: "ONTARIO", zip: "M5V 3A1",
          country: "CANADA",
          mlsNumber: "N/A",
          yearBuilt: 1985,
        },
        deal: {
          dealType: "SALE",
          representationType: "BUYER",
          saleCommission: { kind: "percent", value: "3" },
          salePrice: { amount: "500000", currency: "CAD" },
        },
        buyers: [{ firstName: "J", lastName: "D" }],
        owner: FAKE_OWNER,
      });
      expect(r.ready).toBe(true);
      expect(gapFields(r).filter((f) => f.includes("yearBuilt"))).toEqual([]);
    });

    it("commission payer skipped with helpful note for Canadian SALE (arrakis bean validator rejects TBD payloads)", () => {
      const r = run({
        address: { street: "1", city: "Toronto", state: "ONTARIO", zip: "M5V 3A1", country: "CANADA" },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "CAD" },
          representationType: "BUYER",
          saleCommission: { kind: "percent", value: "3" },
        },
        owner: FAKE_OWNER,
      });
      const payerDefault = r.defaults.find((d) => d.field === "payer");
      expect(payerDefault).toBeDefined();
      expect(payerDefault?.value).toBeNull();
      expect(payerDefault?.reason).toMatch(/SELLERS_LAWYER/);
    });
  });

  describe("SELLER + SALE — listing handled autonomously (not a blocker)", () => {
    it("does NOT block on missing listing — runbook creates it via autonomous chain", () => {
      const r = run({
        address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES", yearBuilt: 2000, mlsNumber: "MLS123" },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "USD" },
          representationType: "SELLER",
          saleCommission: { kind: "percent", value: "3" },
          listingCommission: { kind: "percent", value: "3" },
        },
        owner: FAKE_OWNER,
      });
      expect(blockerFields(r)).not.toContain("listing");
      expect(gapFields(r)).not.toContain("hasActiveListing");
      // Seller-side → buyer defaults to Unknown Buyer; validator doesn't ask
      expect(defaultFields(r)).toContain("buyers");
    });

    it("requires listingCommission for SELLER", () => {
      const r = run({
        address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "USD" },
          representationType: "SELLER",
          saleCommission: { kind: "percent", value: "3" },
        },
        owner: FAKE_OWNER,
      });
      expect(gapFields(r)).toContain("deal.listingCommission");
    });
  });

  describe("DUAL + SALE", () => {
    it("requires listingCommission for DUAL rep", () => {
      const r = run({
        address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "USD" },
          representationType: "DUAL",
          saleCommission: { kind: "percent", value: "3" },
        },
        owner: FAKE_OWNER,
      });
      expect(gapFields(r)).toContain("deal.listingCommission");
    });

    it("DUAL does NOT block on missing listing (autonomous chain handles it)", () => {
      const r = run({
        address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "USD" },
          representationType: "DUAL",
          saleCommission: { kind: "percent", value: "3" },
          listingCommission: { kind: "percent", value: "3" },
        },
        owner: FAKE_OWNER,
      });
      expect(blockerFields(r)).not.toContain("listing");
    });
  });

  describe("LEASE variants", () => {
    it("TENANT → dealType auto-infers LEASE", () => {
      const r = run({
        address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES", yearBuilt: 2000, mlsNumber: "N/A" },
        deal: {
          salePrice: { amount: "3000", currency: "USD" },
          representationType: "TENANT",
          saleCommission: { kind: "amount", value: "3000" },
        },
        owner: FAKE_OWNER,
      });
      const dealTypeDefault = r.defaults.find((d) => d.field === "deal.dealType");
      expect(dealTypeDefault?.value).toBe("LEASE");
    });

    it("LANDLORD does NOT block on missing listing (autonomous chain)", () => {
      const r = run({
        address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
        deal: {
          dealType: "LEASE",
          salePrice: { amount: "3000", currency: "USD" },
          representationType: "LANDLORD",
          saleCommission: { kind: "amount", value: "3000" },
        },
        owner: FAKE_OWNER,
      });
      expect(blockerFields(r)).not.toContain("listing");
    });
  });

  describe("Owner blocker", () => {
    it("blocks when owner.yentaId is missing (verify_auth failed)", () => {
      const r = run({
        address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "USD" },
          representationType: "BUYER",
          saleCommission: { kind: "percent", value: "3" },
        },
      });
      expect(blockerFields(r)).toContain("owner.yentaId");
    });

    it("does NOT block on missing teamId (teamId is optional at arrakis)", () => {
      const r = run({
        address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES", yearBuilt: 2000, mlsNumber: "N/A" },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "USD" },
          representationType: "BUYER",
          saleCommission: { kind: "percent", value: "3" },
        },
        owner: { yentaId: FAKE_OWNER.yentaId, officeId: FAKE_OWNER.officeId }, // no teamId
      });
      // Must not have owner.teamId in blockers (relaxed after arrakis review)
      expect(blockerFields(r)).not.toContain("owner.teamId");
    });
  });

  describe("Representation type never defaults", () => {
    it("asks when representationType missing", () => {
      const r = run({
        address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES", yearBuilt: 2000, mlsNumber: "N/A" },
        deal: {
          dealType: "SALE",
          salePrice: { amount: "500000", currency: "USD" },
          saleCommission: { kind: "percent", value: "3" },
        },
        owner: FAKE_OWNER,
      });
      expect(gapFields(r)).toContain("deal.representationType");
    });
  });
});

describe("MLS and Year Built are SOFT gaps (skippable)", () => {
  it("marks mlsNumber as priority=conditional, not required", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES", yearBuilt: 2000 },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
      },
      owner: FAKE_OWNER,
    });
    const mls = r.gaps.find((g) => g.field === "address.mlsNumber");
    expect(mls?.priority).toBe("conditional");
  });

  it("marks yearBuilt as priority=required for US (arrakis rejects missing)", () => {
    // arrakis enforces "Year built is required in the USA" at
    // TransactionBuilder.updateYearBuilt, returning 400 on any US draft
    // without it. Validator must surface this as a blocking gap, not a
    // conditional/skippable one.
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES", mlsNumber: "N/A" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
      },
      owner: FAKE_OWNER,
    });
    const yb = r.gaps.find((g) => g.field === "address.yearBuilt");
    expect(yb?.priority).toBe("required");
  });

  it("still requires yearBuilt for Canadian properties (user policy: always required)", () => {
    const r = run({
      address: { street: "1", city: "Toronto", state: "ONTARIO", zip: "M5V 3A1", country: "CANADA", mlsNumber: "N/A" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "CAD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
      },
      owner: FAKE_OWNER,
    });
    expect(gapFields(r)).toContain("address.yearBuilt");
  });
});

/**
 * Coverage of arrakis server-side rules that aren't directly validator-facing
 * but the runbook should understand. These tests document what the MCP's
 * write calls need to avoid, since the validator can't fully enforce them
 * (some require live yenta/arrakis data).
 */
describe("arrakis server-side rules the runbook handles via error-messages.md", () => {
  it("payer default value is NULL (never a partial/TBD payload, which arrakis bean validator rejects)", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES", yearBuilt: 2000, mlsNumber: "N/A" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
      },
      buyers: [{ firstName: "J", lastName: "D" }],
      owner: FAKE_OWNER,
    });
    const payerDefault = r.defaults.find((d) => d.field === "payer");
    expect(payerDefault?.value).toBeNull();
  });

  // Documented rules NOT encoded as validator checks because they need yenta
  // data (referral-only flag on the agent, agent's registered country) or
  // post-commission state (zero-commission consistency). These are enforced
  // at the arrakis write-time layer with dedicated error-messages.md entries:
  //
  // - "Referral-only agents can only create referral transactions."
  // - "Referral-only agents cannot own regular transactions or listings,
  //    only referral transactions."
  // - "Referral-only agents cannot be agent representatives in a non-referral
  //    transaction."
  // - "You cannot create a transaction in a country where your account is
  //    not registered. …"
  // - "This transaction can't be zero commission deal with the current
  //    provided commissions" / "have to be zero commission deal …"
  // - "sum of commission percentage should be 100"
  // - "sum of total commission splits should be equal to total commissions"
  // - "A participant was provided in the commission splits that is no longer
  //    a part of the transaction."
  //
  // When any of these fires, the MCP's error-messages.md look-up surfaces a
  // plain-English fix. No validator change needed.
});

describe("Sanity checks — reject obvious typos before they reach preview", () => {
  it("rejects yearBuilt=20011 (out of range)", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES", yearBuilt: 20011 },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
      },
      buyers: [{ firstName: "J", lastName: "D" }],
      owner: FAKE_OWNER,
    });
    const yb = r.gaps.find((g) => g.field === "address.yearBuilt");
    expect(yb).toBeDefined();
    expect(yb?.question).toMatch(/20011/);
    expect(yb?.question).toMatch(/doesn't look like/);
  });

  it("accepts yearBuilt in the valid range (1600..currentYear+2)", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES", yearBuilt: 1948, mlsNumber: "N/A" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
      },
      buyers: [{ firstName: "J", lastName: "D" }],
      owner: FAKE_OWNER,
    });
    expect(r.gaps.find((g) => g.field === "address.yearBuilt")).toBeUndefined();
  });

  it("rejects ZIP like '999' (not 5-digit US or Canadian format)", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "999", country: "UNITED_STATES" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
      },
      owner: FAKE_OWNER,
    });
    const zip = r.gaps.find((g) => g.field === "address.zip");
    expect(zip?.question).toMatch(/isn't a valid/);
  });

  it("accepts ZIP 10025 (US) and M5V 3A1 (Canada)", () => {
    const us = run({
      address: { street: "1", city: "NY", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
      deal: { dealType: "SALE", salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      owner: FAKE_OWNER,
    });
    expect(us.gaps.find((g) => g.field === "address.zip")).toBeUndefined();

    const ca = run({
      address: { street: "1", city: "Toronto", state: "ONTARIO", zip: "M5V 3A1", country: "CANADA" },
      deal: { dealType: "SALE", salePrice: { amount: "500000", currency: "CAD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      owner: FAKE_OWNER,
    });
    expect(ca.gaps.find((g) => g.field === "address.zip")).toBeUndefined();
  });

  it("rejects negative or zero sale price", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "-100", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
      },
      owner: FAKE_OWNER,
    });
    const price = r.gaps.find((g) => g.field === "deal.salePrice");
    expect(price?.question).toMatch(/doesn't look right/);
  });

  it("rejects absurdly high sale price (> $1B)", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "5000000000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
      },
      owner: FAKE_OWNER,
    });
    expect(r.gaps.find((g) => g.field === "deal.salePrice")).toBeDefined();
  });

  it("rejects commission percent > 100", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "150" },
      },
      owner: FAKE_OWNER,
    });
    expect(r.gaps.find((g) => g.field === "deal.saleCommission")).toBeDefined();
  });

  it("rejects malformed acceptance date", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
        acceptanceDate: "04/17/2026", // US format instead of ISO
      },
      owner: FAKE_OWNER,
    });
    expect(r.gaps.find((g) => g.field === "deal.acceptanceDate")).toBeDefined();
  });

  it("rejects year-off dates (< currentYear-5 or > currentYear+10)", () => {
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
      deal: {
        dealType: "SALE",
        salePrice: { amount: "500000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { kind: "percent", value: "3" },
        closingDate: "2099-01-01",
      },
      owner: FAKE_OWNER,
    });
    expect(r.gaps.find((g) => g.field === "deal.closingDate")).toBeDefined();
  });
});

describe("validateDraft — edge cases", () => {
  it("empty answers produce owner blocker + many gaps but never crashes", () => {
    const r = run({});
    expect(r.blockers.length).toBeGreaterThan(0);
    expect(r.gaps.length).toBeGreaterThan(0);
    expect(r.ready).toBe(false);
  });

  it("representationType=SELLER + dealType=LEASE = LANDLORD-style lease listing", () => {
    // Weird combo; validator still handles.
    const r = run({
      address: { street: "1", city: "X", state: "NEW_YORK", zip: "10025", country: "UNITED_STATES" },
      deal: {
        dealType: "LEASE",
        salePrice: { amount: "3000", currency: "USD" },
        representationType: "SELLER", // unusual but legal
        saleCommission: { kind: "amount", value: "3000" },
        listingCommission: { kind: "amount", value: "3000" },
      },
      owner: FAKE_OWNER,
      hasActiveListing: true,
    });
    expect(r.blockers).toEqual([]);
  });
});

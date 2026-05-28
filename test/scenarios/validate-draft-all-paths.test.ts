import { describe, expect, it } from "vitest";
import { addressHistoryKey, validateDraft, type AddressHistoryEntry, type AgentProfile, type DraftAnswers, type ValidationResult } from "../../src/util/draftRequirements.js";

const FAKE_OWNER = {
  yentaId: "00000000-0000-0000-0000-000000000001",
  officeId: "00000000-0000-0000-0000-000000000002",
  teamId: "00000000-0000-0000-0000-000000000003",
};
const run = (answers: DraftAnswers, addressHistory?: AddressHistoryEntry[], agentProfile?: AgentProfile): ValidationResult =>
  validateDraft({ env: "team1", userPrompt: "test", answers, addressHistory, agentProfile });
const fields = (gs: { field: string }[]): string[] => gs.map((g) => g.field).sort();

describe("validateDraft — happy paths (ready=true)", () => {
  it("BUYER + SALE — ready when address + price + commission + buyer; seller defaulted", () => {
    const r = run({
      address: { street: "123 Main", city: "NYC", state: "NEW_YORK", zip: "10025", mlsNumber: "M1" },
      deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      buyers: [{ firstName: "Jane", lastName: "Doe" }],
      owner: FAKE_OWNER,
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(fields(r.defaults)).toContain("sellers");
    expect(fields(r.defaults)).toContain("otherSideAgent");
  });

  it("SELLER + SALE — ready with both commissions + seller name; buyer defaulted; listing pre-check is runbook concern (not a blocker)", () => {
    const r = run({
      address: { street: "1 Oak St", city: "NYC", state: "NEW_YORK", zip: "10025", mlsNumber: "M1" },
      deal: { salePrice: { amount: "750000", currency: "USD" }, representationType: "SELLER", saleCommission: { kind: "percent", value: "3" }, listingCommission: { kind: "percent", value: "3" } },
      sellers: [{ firstName: "Sam", lastName: "Seller" }],
      owner: FAKE_OWNER,
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(fields(r.defaults)).toContain("buyers");
  });

  it("DUAL — both commissions required; ready when both present", () => {
    const r = run({
      address: { street: "5 Pine", city: "Toronto", state: "ONTARIO", zip: "M5V 3A1", mlsNumber: "M1" },
      deal: { salePrice: { amount: "1000000", currency: "CAD" }, representationType: "DUAL", saleCommission: { kind: "percent", value: "2.5" }, listingCommission: { kind: "percent", value: "2.5" } },
      sellers: [{ firstName: "Sam", lastName: "Seller" }],
      buyers: [{ firstName: "Bob", lastName: "Buyer" }],
      owner: FAKE_OWNER,
    });
    expect(r.ready).toBe(true);
  });
});

describe("validateDraft — hard gaps (block create)", () => {
  it("missing representationType is a hard gap", () => {
    const r = run({ address: { street: "1 St", city: "NYC", state: "NEW_YORK", zip: "10025" }, deal: { salePrice: { amount: "500000", currency: "USD" }, saleCommission: { kind: "percent", value: "3" } }, owner: FAKE_OWNER });
    expect(r.ready).toBe(false);
    expect(fields(r.gaps)).toContain("deal.representationType");
  });

  it("DUAL without listingCommission is a hard gap", () => {
    const r = run({ address: { street: "1 St", city: "NYC", state: "NEW_YORK", zip: "10025" }, deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "DUAL", saleCommission: { kind: "percent", value: "3" } }, owner: FAKE_OWNER });
    expect(fields(r.gaps)).toContain("deal.listingCommission");
  });

  it("seller-side without seller name is a hard gap", () => {
    const r = run({ address: { street: "1 St", city: "NYC", state: "NEW_YORK", zip: "10025" }, deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "SELLER", saleCommission: { kind: "percent", value: "3" }, listingCommission: { kind: "percent", value: "3" } }, owner: FAKE_OWNER });
    expect(fields(r.gaps)).toContain("sellers");
  });
});

describe("validateDraft — soft gaps (post-create only)", () => {
  it("missing yearBuilt is SOFT; missing MLS is a HARD gap (arrakis requires it at submit)", () => {
    const r = run({
      address: { street: "1 St", city: "NYC", state: "NEW_YORK", zip: "10025" },
      deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      buyers: [{ firstName: "Jane", lastName: "Doe" }],
      owner: FAKE_OWNER,
      payer: { role: "TITLE", companyName: "Acme Title", firstName: "T", lastName: "C", email: "t@acme.com", phoneNumber: "5551234567" },
    });
    expect(r.ready).toBe(false);
    expect(fields(r.softGaps)).toEqual(["address.yearBuilt"]);
    expect(fields(r.gaps)).toContain("address.mlsNumber");
  });

  it("supplied yearBuilt/MLS do not appear in softGaps", () => {
    const r = run({
      address: { street: "1 St", city: "NYC", state: "NEW_YORK", zip: "10025", yearBuilt: 1948, mlsNumber: "M123" },
      deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      buyers: [{ firstName: "Jane", lastName: "Doe" }],
      owner: FAKE_OWNER,
      payer: { role: "TITLE", companyName: "Acme Title", firstName: "T", lastName: "C", email: "t@acme.com", phoneNumber: "5551234567" },
    });
    expect(r.softGaps).toEqual([]);
  });
});

describe("validateDraft — blockers", () => {
  it("missing owner.yentaId is a blocker (auth must populate)", () => {
    const r = run({
      address: { street: "1 St", city: "NYC", state: "NEW_YORK", zip: "10025" },
      deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      buyers: [{ firstName: "Jane", lastName: "Doe" }],
    });
    expect(fields(r.blockers)).toEqual(["owner.yentaId"]);
    expect(r.ready).toBe(false);
  });
});

describe("validateDraft — defaults from ZIP / state", () => {
  it("US ZIP populates state + USD currency", () => {
    const r = run({
      address: { street: "1 St", city: "NYC", zip: "10025" },
      deal: { salePrice: { amount: "500000" } as { amount: string; currency: "USD" | "CAD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      buyers: [{ firstName: "Jane", lastName: "Doe" }],
      owner: FAKE_OWNER,
    });
    expect(fields(r.defaults)).toContain("address.state");
    const cur = r.defaults.find((d) => d.field === "deal.salePrice.currency");
    expect(cur?.value).toBe("USD");
  });

  it("Canadian postal → CAD", () => {
    const r = run({
      address: { street: "1 King", city: "Toronto", zip: "M5V 3A1" },
      deal: { salePrice: { amount: "500000" } as { amount: string; currency: "USD" | "CAD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      buyers: [{ firstName: "Jane", lastName: "Doe" }],
      owner: FAKE_OWNER,
    });
    const cur = r.defaults.find((d) => d.field === "deal.salePrice.currency");
    expect(cur?.value).toBe("CAD");
  });
});

describe("validateDraft — address history cache", () => {
  const buyerSide: DraftAnswers = {
    address: { street: "123 Main St", city: "NYC", state: "NEW_YORK", zip: "10025" },
    deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
    buyers: [{ firstName: "Jane", lastName: "Doe" }],
    owner: FAKE_OWNER,
    payer: { role: "TITLE", companyName: "Acme Title", firstName: "T", lastName: "C", email: "t@acme.com", phoneNumber: "5551234567" },
  };

  it("cache hit fills yearBuilt + MLS silently — surfaced in defaults, not softGaps", () => {
    const history: AddressHistoryEntry[] = [{
      key: addressHistoryKey("10025", "123 Main St"),
      yearBuilt: 1948, lastMlsNumber: "M12345", useCount: 3,
    }];
    const r = run(buyerSide, history);
    expect(r.softGaps).toEqual([]);
    expect(fields(r.defaults)).toContain("address.yearBuilt");
    expect(fields(r.defaults)).toContain("address.mlsNumber");
    const yb = r.defaults.find((d) => d.field === "address.yearBuilt");
    expect(yb?.value).toBe(1948);
    expect(yb?.reason).toContain("prior draft");
  });

  it("cache miss leaves yearBuilt + MLS as softGaps", () => {
    const history: AddressHistoryEntry[] = [{
      key: addressHistoryKey("99999", "999 Other Rd"),
      yearBuilt: 2010,
    }];
    const r = run(buyerSide, history);
    expect(fields(r.softGaps)).toEqual(["address.yearBuilt"]);
    expect(fields(r.gaps)).toContain("address.mlsNumber");
  });

  it("cache key normalizes whitespace and case — '  123 MAIN ST  ' matches '123 main st'", () => {
    const history: AddressHistoryEntry[] = [{
      key: addressHistoryKey("10025", "  123 MAIN ST  "),
      yearBuilt: 1948,
    }];
    const r = run(buyerSide, history);
    expect(r.softGaps.find((g) => g.field === "address.yearBuilt")).toBeUndefined();
    const yb = r.defaults.find((d) => d.field === "address.yearBuilt");
    expect(yb?.value).toBe(1948);
  });

  it("user-supplied yearBuilt wins over cache (no overwrite)", () => {
    const history: AddressHistoryEntry[] = [{
      key: addressHistoryKey("10025", "123 Main St"),
      yearBuilt: 1948,
    }];
    const r = run({ ...buyerSide, address: { ...buyerSide.address!, yearBuilt: 2020 } }, history);
    const yb = r.defaults.find((d) => d.field === "address.yearBuilt");
    expect(yb).toBeUndefined();
  });

  it("no addressHistory input → yearBuilt soft, MLS hard", () => {
    const r = run(buyerSide);
    expect(fields(r.softGaps)).toEqual(["address.yearBuilt"]);
    expect(fields(r.gaps)).toContain("address.mlsNumber");
  });
});

describe("validateDraft — agent profile defaults (cold-start kill)", () => {
  const buyerSideNoOwner: DraftAnswers = {
    address: { street: "1 Main", city: "NYC", state: "NEW_YORK", zip: "10025" },
    deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
    buyers: [{ firstName: "Jane", lastName: "Doe" }],
  };

  it("seeds owner.yentaId/officeId from agent profile silently", () => {
    const profile: AgentProfile = {
      yentaId: "00000000-0000-0000-0000-000000000001",
      officeId: "00000000-0000-0000-0000-000000000002",
      agentStatus: "ACTIVE",
    };
    const r = run(buyerSideNoOwner, undefined, profile);
    expect(r.blockers).toEqual([]);
    expect(fields(r.defaults)).toContain("owner.yentaId");
    expect(fields(r.defaults)).toContain("owner.officeId");
  });

  it("single-team auto-resolve: user on exactly one team → silent default", () => {
    const profile: AgentProfile = {
      yentaId: "00000000-0000-0000-0000-000000000001",
      officeId: "00000000-0000-0000-0000-000000000002",
      agentStatus: "ACTIVE",
      teams: [{ teamId: "team-xyz", name: "Solo Team" }],
    };
    const r = run(buyerSideNoOwner, undefined, profile);
    expect(fields(r.defaults)).toContain("owner.teamId");
    const t = r.defaults.find((d) => d.field === "owner.teamId");
    expect(t?.value).toBe("team-xyz");
  });

  it("multiple teams → no team default (user must pick)", () => {
    const profile: AgentProfile = {
      yentaId: "00000000-0000-0000-0000-000000000001",
      officeId: "00000000-0000-0000-0000-000000000002",
      agentStatus: "ACTIVE",
      teams: [
        { teamId: "a", name: "Team A" },
        { teamId: "b", name: "Team B" },
      ],
    };
    const r = run(buyerSideNoOwner, undefined, profile);
    expect(fields(r.defaults)).not.toContain("owner.teamId");
  });

  it("CANDIDATE agent status produces a blocker (fail-fast)", () => {
    const profile: AgentProfile = {
      yentaId: "00000000-0000-0000-0000-000000000001",
      agentStatus: "CANDIDATE",
    };
    const r = run(buyerSideNoOwner, undefined, profile);
    expect(fields(r.blockers)).toContain("owner.agentStatus");
    expect(r.ready).toBe(false);
  });

  it("country defaults from agent profile when prompt's address lacks it", () => {
    const profile: AgentProfile = {
      yentaId: "00000000-0000-0000-0000-000000000001",
      agentStatus: "ACTIVE",
      country: "UNITED_STATES",
    };
    const noCountry: DraftAnswers = {
      address: { street: "1 Main", city: "NYC", state: "NEW_YORK", zip: "10025" },
      deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      buyers: [{ firstName: "Jane", lastName: "Doe" }],
    };
    delete noCountry.address!.country;
    const r = run(noCountry, undefined, profile);
    expect(fields(r.defaults)).toContain("address.country");
  });
});

describe("validateDraft — payment type + other-side defaults (submit-required fields)", () => {
  const base: DraftAnswers = {
    address: { street: "1 St", city: "NYC", state: "NEW_YORK", zip: "10025" },
    deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
    owner: FAKE_OWNER,
  };

  it("payment type defaults to Single Payment (requiresInstallments=false)", () => {
    const r = run(base);
    const pt = r.defaults.find((d) => d.field === "deal.requiresInstallments");
    expect(pt?.value).toBe(false);
    expect(pt?.reason).toContain("Single Payment");
  });

  it("explicit requiresInstallments is preserved (not overwritten)", () => {
    const r = run({ ...base, deal: { ...base.deal!, requiresInstallments: true } });
    expect(r.defaults.find((d) => d.field === "deal.requiresInstallments")).toBeUndefined();
  });

  it("other side defaults to UNREPRESENTED for single-rep (never a fabricated external agent)", () => {
    const r = run(base);
    const os = r.defaults.find((d) => d.field === "otherSideAgent");
    expect(os?.value).toEqual({ kind: "UNREPRESENTED" });
  });
});

describe("validateDraft — Unknown Buyer default (symmetric with Unknown Seller)", () => {
  it("buyer-side SALE with no buyer name → defaulted to Unknown Buyer", () => {
    const r = run({
      address: { street: "1 St", city: "NYC", state: "NEW_YORK", zip: "10025", mlsNumber: "M1" },
      deal: { salePrice: { amount: "500000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
      owner: FAKE_OWNER,
    });
    expect(r.ready).toBe(true);
    expect(fields(r.defaults)).toContain("buyers");
    const buyer = r.defaults.find((d) => d.field === "buyers");
    expect(buyer?.reason).toContain("placeholder");
  });
});

describe("validateDraft — sanity checks (reject typos)", () => {
  it("yearBuilt out of range → gap with rejected value in question", () => {
    const r = run({ address: { yearBuilt: 20011 } });
    const g = r.gaps.find((g) => g.field === "address.yearBuilt");
    expect(g?.question).toContain("20011");
  });
  it("invalid ZIP → gap", () => {
    const r = run({ address: { zip: "9999999" } });
    expect(fields(r.gaps)).toContain("address.zip");
  });
  it("salePrice <= 100 → gap", () => {
    const r = run({ deal: { salePrice: { amount: "5", currency: "USD" } } });
    expect(fields(r.gaps)).toContain("deal.salePrice");
  });
  it("saleCommission > 100% → gap suggesting flat-amount alternative", () => {
    const r = run({ deal: { saleCommission: { kind: "percent", value: "150" } } });
    const g = r.gaps.find((g) => g.field === "deal.saleCommission");
    expect(g?.question).toContain("over 100");
  });
  it("non-ISO date → gap", () => {
    const r = run({ deal: { acceptanceDate: "next Tuesday" } });
    expect(fields(r.gaps)).toContain("deal.acceptanceDate");
  });
});

describe("validateDraft — commission shape coercion (accept arrakis shape)", () => {
  const base = {
    address: { street: "123 Main", city: "NYC", state: "NEW_YORK", zip: "10025", mlsNumber: "M1" },
    representationType: "BUYER" as const,
    buyers: [{ firstName: "Jane", lastName: "Doe" }],
    owner: FAKE_OWNER,
  };

  it("percent commission in arrakis shape ({percentEnabled,commissionPercent}) is NOT flagged as missing", () => {
    const r = run({
      address: base.address,
      deal: {
        salePrice: { amount: "100000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { percentEnabled: true, commissionPercent: "5" } as never,
      },
      buyers: base.buyers,
      owner: FAKE_OWNER,
    });
    expect(fields(r.gaps)).not.toContain("deal.saleCommission");
    expect(r.ready).toBe(true);
  });

  it("flat commission in arrakis shape ({percentEnabled:false,commissionAmount}) is NOT flagged as missing", () => {
    const r = run({
      address: base.address,
      deal: {
        salePrice: { amount: "100000", currency: "USD" },
        representationType: "BUYER",
        saleCommission: { percentEnabled: false, commissionAmount: { amount: "5000", currency: "USD" } } as never,
      },
      buyers: base.buyers,
      owner: FAKE_OWNER,
    });
    expect(fields(r.gaps)).not.toContain("deal.saleCommission");
    expect(r.ready).toBe(true);
  });

  it("still flags a genuinely-missing commission", () => {
    const r = run({
      address: base.address,
      deal: { salePrice: { amount: "100000", currency: "USD" }, representationType: "BUYER" },
      buyers: base.buyers,
      owner: FAKE_OWNER,
    });
    expect(fields(r.gaps)).toContain("deal.saleCommission");
  });
});

describe("validateDraft — commission payer soft gap", () => {
  const saleAnswers = (extra: Partial<DraftAnswers> = {}): DraftAnswers => ({
    address: { street: "123 Main", city: "NYC", state: "NEW_YORK", zip: "10025", mlsNumber: "M1" },
    deal: { dealType: "SALE", salePrice: { amount: "100000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "5" } },
    buyers: [{ firstName: "Jane", lastName: "Doe" }],
    owner: FAKE_OWNER,
    ...extra,
  });

  it("SALE with no payer → payer is a SOFT gap (not a hard gap; still ready)", () => {
    const r = run(saleAnswers());
    expect(r.ready).toBe(true);
    expect(fields(r.gaps)).not.toContain("payer");
    expect(fields(r.softGaps)).toContain("payer");
  });

  it("payer provided → no payer soft gap", () => {
    const r = run(saleAnswers({
      payer: { role: "TITLE", companyName: "Acme Title", firstName: "T", lastName: "C", email: "t@acme.com", phoneNumber: "5551234567" },
    }));
    expect(fields(r.softGaps)).not.toContain("payer");
  });

  it("REFERRAL deal does not soft-gap the payer", () => {
    const r = run(saleAnswers({ deal: { dealType: "REFERRAL", salePrice: { amount: "100000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "5" } } }));
    expect(fields(r.softGaps)).not.toContain("payer");
  });
});

describe("validateDraft — MLS hard gap (arrakis requires it at submit)", () => {
  const noMls = (dealType: "SALE" | "REFERRAL"): DraftAnswers => ({
    address: { street: "9 Elm", city: "NYC", state: "NEW_YORK", zip: "10025" },
    deal: { dealType, salePrice: { amount: "100000", currency: "USD" }, representationType: "BUYER", saleCommission: { kind: "percent", value: "3" } },
    buyers: [{ firstName: "Jane", lastName: "Doe" }],
    owner: FAKE_OWNER,
    payer: { role: "TITLE", companyName: "Acme Title", firstName: "T", lastName: "C", email: "t@acme.com", phoneNumber: "5551234567" },
  });

  it("SALE with no MLS → HARD gap (blocks create) carrying an N/A option", () => {
    const r = run(noMls("SALE"));
    expect(r.ready).toBe(false);
    expect(fields(r.gaps)).toContain("address.mlsNumber");
    const g = r.gaps.find((x) => x.field === "address.mlsNumber");
    expect(g?.options?.some((o) => /N\/A/.test(o.label))).toBe(true);
  });

  it("REFERRAL with no MLS → NOT a hard gap (referrals carry no MLS)", () => {
    const r = run(noMls("REFERRAL"));
    expect(fields(r.gaps)).not.toContain("address.mlsNumber");
  });
});

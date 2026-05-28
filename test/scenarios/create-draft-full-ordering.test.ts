import { describe, expect, it } from "vitest";
import { createDraftFull } from "../../src/tools/convenience/create_draft_full.js";
import type { TransactionBuilderApi } from "../../src/services/TransactionBuilderApi.js";
import type { ToolContext } from "../../src/tools/Tool.js";

/**
 * Regression test for create_draft_full write ordering + concurrency safety.
 *
 * arrakis does not safely handle concurrent PUTs to the same draft: two
 * simultaneous section writes intermittently 400 with "Invalid request". The
 * original orchestrator fired sections in parallel (Promise.all); different
 * sections failed on different live runs. The fix serializes every section
 * write. This harness holds each write open briefly and tracks the max number
 * in flight at once — under the fix it must never exceed 1. Any reintroduced
 * parallel fan-out drives concurrency >1 and fails the test. It also asserts
 * the address-dependency order (location before price-date and owner).
 */
describe("create_draft_full: serialized section writes", () => {
  function buildHarness() {
    const events: string[] = [];
    let inFlight = 0;
    let maxConcurrency = 0;

    // Each section write holds open for a tick so any overlap is observable.
    const op = (tag: string) => async () => {
      inFlight += 1;
      maxConcurrency = Math.max(maxConcurrency, inFlight);
      events.push(tag);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };

    const arrakis = {
      async initializeDraft() {
        events.push("init");
        return "builder-1";
      },
      setTransactionOwner: op("setOwner"),
      updateLocationInfo: op("location"),
      updatePriceAndDateInfo: op("price-date"),
      updateBuyerAndSellerInfo: op("buyer-seller"),
      updateOwnerAgentInfo: op("owner"),
      addCoAgent: op("coAgent"),
      setOpcity: op("opcity"),
      updateCommissionSplits: op("splits"),
      updatePersonalDealInfo: op("personalDeal"),
      updateAdditionalFees: op("additionalFees"),
      updateTitleInfo: op("title"),
      updateFmlsInfo: op("fmls"),
    } as unknown as TransactionBuilderApi;

    const ctx = { arrakis } as unknown as ToolContext;
    return { events, ctx, getMaxConcurrency: () => maxConcurrency };
  }

  const args = {
    env: "team1",
    type: "TRANSACTION",
    transactionOwnerId: "8c69b3e3-12d9-47e2-a39a-0d969e9a8888",
    location: { street: "1 Main Street", city: "New York", state: "NEW_YORK", zip: "10025" },
    priceAndDates: {
      dealType: "SALE",
      representationType: "BUYER",
      salePrice: { amount: "100000", currency: "USD" },
      saleCommission: { percentEnabled: true, commissionPercent: "5" },
    },
    buyerSeller: {
      sellers: [{ firstName: "Unknown", lastName: "Seller" }],
      buyers: [{ firstName: "Unknown", lastName: "Buyer" }],
    },
    owner: {
      ownerAgent: { agentId: "8c69b3e3-12d9-47e2-a39a-0d969e9a8888", role: "BUYERS_AGENT" },
      officeId: "36cbf0fd-4131-4b5d-a556-268fcb42befc",
    },
    coAgents: [{ agentId: "11111111-1111-1111-1111-111111111111", role: "BUYERS_AGENT" }],
    opcity: false,
    commissionSplits: [{ participantId: "p1", commission: { percentEnabled: true, commissionPercent: "100" } }],
    finalize: {
      personalDeal: { personalDeal: false, representedByAgent: true },
      additionalFees: { hasAdditionalFees: false, additionalFeesParticipantInfos: [] },
      title: { useRealTitle: false },
    },
  };

  it("never runs two section writes concurrently", async () => {
    const { ctx, getMaxConcurrency } = buildHarness();

    const result = (await createDraftFull.handler(args as never, ctx)) as { ok: boolean };

    expect(result.ok).toBe(true);
    // The core invariant: arrakis sees at most one write at a time.
    expect(getMaxConcurrency()).toBe(1);
  });

  it("commits the address before price-date and owner, and the owner before co-agents", async () => {
    const { events, ctx } = buildHarness();

    await createDraftFull.handler(args as never, ctx);

    expect(events.indexOf("location")).toBeLessThan(events.indexOf("price-date"));
    expect(events.indexOf("location")).toBeLessThan(events.indexOf("owner"));
    expect(events.indexOf("owner")).toBeLessThan(events.indexOf("coAgent"));
  });

  // Root-cause fix (verified 2026-05-27 on team1): arrakis sets owner = caller
  // on create, so a redundant set_transaction_owner races the uncommitted
  // builder and 403s. Skip it when owner == caller; keep it for on-behalf-of.
  it("SKIPS set_transaction_owner when owner == authenticated caller", async () => {
    const { events, ctx } = buildHarness();

    const result = (await createDraftFull.handler(
      { ...args, callerYentaId: args.transactionOwnerId } as never,
      ctx,
    )) as { ok: boolean; data: { applied: string[]; skippedSections: string[] } };

    expect(result.ok).toBe(true);
    expect(events).not.toContain("setOwner");
    expect(result.data.applied).not.toContain("set_transaction_owner");
    expect(result.data.skippedSections.some((s) => s.startsWith("set_transaction_owner"))).toBe(true);
  });

  it("STILL calls set_transaction_owner for on-behalf-of (owner != caller)", async () => {
    const { events, ctx } = buildHarness();

    const result = (await createDraftFull.handler(
      { ...args, callerYentaId: "99999999-9999-9999-9999-999999999999" } as never,
      ctx,
    )) as { ok: boolean; data: { applied: string[] } };

    expect(result.ok).toBe(true);
    expect(events).toContain("setOwner");
    expect(result.data.applied).toContain("set_transaction_owner");
  });
});

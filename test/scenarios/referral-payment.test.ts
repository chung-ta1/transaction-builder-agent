import { describe, expect, it, vi } from "vitest";
import { createReferralPayment } from "../../src/tools/convenience/create_referral_payment.js";
import type { ToolContext } from "../../src/tools/Tool.js";

/**
 * Unit coverage for `create_referral_payment`. The scenarios we care about:
 *   1. Happy path: shapes match Bolt's observed request body.
 *   2. Zero / negative / NaN amount: fail fast, don't call arrakis.
 *   3. Optional fields (address, payment info) are omitted from the body
 *      when not provided — Bolt sends them, so we need to match.
 *   4. detailUrl is built from the returned transaction id, not the builder
 *      id (this flow has no builder).
 *
 * No real HTTP — `referralPayment.createAndDisburse` is mocked.
 */

type Ctx = Pick<ToolContext, "referralPayment">;

function ctx(stub: ReturnType<typeof vi.fn>): Ctx {
  return {
    referralPayment: { createAndDisburse: stub } as unknown as ToolContext["referralPayment"],
  };
}

describe("create_referral_payment", () => {
  const ownerYentaId = "b8745bec-9838-4c7f-bcbc-23e86ced3146";
  const txId = "6a3f2457-93a8-49cf-baf6-ec8d2ce77f94";

  const baseArgs = {
    env: "team1" as const,
    senderAgentYentaId: ownerYentaId,
    externalAgentName: "Jane Smith",
    externalAgentEmail: "jane@smith.example",
    externalAgentBrokerage: "Keller Williams Downtown",
    clientName: "Michael Brown",
    clientEmail: "michael@example.com",
    expectedReferralAmount: { amount: 2500, currency: "USD" as const },
    expectedCloseDate: "2026-05-30",
  };

  it("fires one arrakis POST with the expected body and returns a detail URL", async () => {
    const stub = vi.fn().mockResolvedValue({
      transaction: { id: txId, code: "1SR-243-Z3F-KH7" },
      referral: { id: "ref-1" },
    });

    const result = await createReferralPayment.handler(baseArgs, ctx(stub) as ToolContext);

    expect(stub).toHaveBeenCalledTimes(1);
    const [env, senderId, body] = stub.mock.calls[0];
    expect(env).toBe("team1");
    expect(senderId).toBe(ownerYentaId);
    expect(body).toMatchObject({
      externalAgentName: "Jane Smith",
      externalAgentEmail: "jane@smith.example",
      externalAgentBrokerage: "Keller Williams Downtown",
      clientName: "Michael Brown",
      clientEmail: "michael@example.com",
      expectedReferralAmount: { amount: 2500, currency: "USD" },
      expectedCloseDate: "2026-05-30",
    });
    // Absent optional fields should not appear in the body at all.
    expect(body).not.toHaveProperty("referredPropertyAddress");
    expect(body).not.toHaveProperty("externalPaymentMethod");

    expect(result).toMatchObject({
      ok: true,
      data: {
        transactionId: txId,
        referralId: "ref-1",
        transactionCode: "1SR-243-Z3F-KH7",
        detailUrl: `https://bolt.team1realbrokerage.com/transactions/${txId}/detail`,
      },
    });
  });

  it("rejects zero, negative, and NaN referral amounts before calling arrakis", async () => {
    const stub = vi.fn();
    for (const amount of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await createReferralPayment.handler(
        {
          ...baseArgs,
          expectedReferralAmount: { amount, currency: "USD" as const },
        },
        ctx(stub) as ToolContext,
      );
      expect(result).toMatchObject({ ok: false });
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("forwards classification=OTHER (Non-Referral Payment) when set", async () => {
    const stub = vi.fn().mockResolvedValue({
      transaction: { id: txId, code: "1SR-OTHER-KH7" },
      referral: { id: "ref-other" },
    });

    await createReferralPayment.handler(
      {
        ...baseArgs,
        classification: "OTHER",
        comments: "Termination fee — prior listing agent walked.",
      },
      ctx(stub) as ToolContext,
    );

    const [, , body] = stub.mock.calls[0];
    expect(body.classification).toBe("OTHER");
    expect(body.comments).toContain("Termination fee");
  });

  it("omits classification entirely when not provided (arrakis defaults to REFERRAL)", async () => {
    const stub = vi.fn().mockResolvedValue({
      transaction: { id: txId },
      referral: { id: "ref-default" },
    });
    await createReferralPayment.handler(baseArgs, ctx(stub) as ToolContext);
    const [, , body] = stub.mock.calls[0];
    expect(body).not.toHaveProperty("classification");
  });

  it("forwards optional fields (address + payment info) as-is when provided", async () => {
    const stub = vi.fn().mockResolvedValue({
      transaction: { id: txId, code: "1SR-999-Z3F-KH7" },
      referral: { id: "ref-2" },
    });

    await createReferralPayment.handler(
      {
        ...baseArgs,
        referredPropertyAddress: {
          street: "123 Main St",
          city: "New York",
          state: "NEW_YORK",
          zip: "10024",
          country: "UNITED_STATES",
        },
        externalPaymentDateSent: "2026-04-10",
        externalPaymentMethod: "WIRE",
        externalReferenceNumber: "WIRE-123",
        externalSenderName: "Jane Smith",
        comments: "Referral for closed deal at 123 Main St.",
      },
      ctx(stub) as ToolContext,
    );

    const [, , body] = stub.mock.calls[0];
    expect(body.referredPropertyAddress).toMatchObject({
      street: "123 Main St",
      state: "NEW_YORK",
      country: "UNITED_STATES",
    });
    expect(body.externalPaymentMethod).toBe("WIRE");
    expect(body.externalPaymentDateSent).toBe("2026-04-10");
  });
});

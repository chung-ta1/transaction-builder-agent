import { describe, expect, it } from "vitest";
import {
  commissionFractionalPercentSchema,
  commissionSplitsArraySchema,
} from "../../src/types/schemas.js";

/**
 * Boundary guards (added 2026-05-28): percents are bounded [0,100] with ≤2dp,
 * and a percent-based splits array must sum to exactly 100.00. These catch an
 * LLM that bypasses compute_commission_splits and sends malformed splits that
 * only arrakis would otherwise reject.
 */
describe("commissionFractionalPercentSchema percent bound", () => {
  const pct = (commissionPercent: string) =>
    commissionFractionalPercentSchema.safeParse({ percentEnabled: true, commissionPercent });

  it("accepts valid percents incl. 100 (sole agent) and 2dp", () => {
    expect(pct("0").success).toBe(true);
    expect(pct("3").success).toBe(true);
    expect(pct("42.5").success).toBe(true);
    expect(pct("100").success).toBe(true);
    expect(pct("100.00").success).toBe(true);
  });

  it("rejects >100, >2 decimals, and non-numeric", () => {
    expect(pct("250").success).toBe(false);
    expect(pct("100.0001").success).toBe(false);
    expect(pct("3.555").success).toBe(false);
    expect(pct("abc").success).toBe(false);
  });
});

describe("commissionSplitsArraySchema sum-to-100", () => {
  const split = (participantId: string, commissionPercent: string) => ({
    participantId,
    commission: { percentEnabled: true, commissionPercent },
  });

  it("accepts splits that sum to exactly 100.00", () => {
    expect(commissionSplitsArraySchema.safeParse([split("A", "100")]).success).toBe(true);
    expect(
      commissionSplitsArraySchema.safeParse([split("A", "60"), split("B", "40")]).success,
    ).toBe(true);
    expect(
      commissionSplitsArraySchema.safeParse([
        split("A", "42.00"),
        split("B", "28.00"),
        split("C", "30.00"),
      ]).success,
    ).toBe(true);
  });

  it("rejects percent-based splits that don't sum to 100 (under and over)", () => {
    expect(
      commissionSplitsArraySchema.safeParse([split("A", "60"), split("B", "30")]).success,
    ).toBe(false); // 90
    expect(
      commissionSplitsArraySchema.safeParse([split("A", "60"), split("B", "60")]).success,
    ).toBe(false); // 120
  });

  it("does NOT sum-check amount-based splits (percentEnabled:false) — left to arrakis", () => {
    const amountSplit = {
      participantId: "A",
      commission: {
        percentEnabled: false,
        commissionAmount: { amount: "3000.00", currency: "USD" as const },
      },
    };
    expect(commissionSplitsArraySchema.safeParse([amountSplit]).success).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { findCreatedParticipantId } from "../../src/tools/granular/commission.js";

/**
 * Regression for the submit-500 bug (2026-05-29): wire_commission_payer used
 * `addOtherParticipant(...).id` as the payer participantId, but that call
 * returns the whole DRAFT (top-level id == builderId), so the payer pointed at
 * the builder — a broken self-reference arrakis 500s on at submit. The payer's
 * participantId must be the newly-created participant's id, never the builderId.
 */

const BUILDER_ID = "c8a2ddee-7637-41af-9570-76c709c218ee";
const TITLE_PARTICIPANT_ID = "40741beb-1339-41c9-a23a-c21a6cd39bbc";

function draftWithPayer() {
  return {
    id: BUILDER_ID, // the trap: the draft's own id
    otherParticipants: [
      { id: "seller-1", role: "SELLER", email: null, createdAt: 1 },
      {
        id: TITLE_PARTICIPANT_ID,
        role: "TITLE",
        email: "idontknowyet@example.com",
        createdAt: 1780094216306,
      },
    ],
    allParticipants: [
      { id: TITLE_PARTICIPANT_ID, role: "TITLE", email: "idontknowyet@example.com", createdAt: 1780094216306 },
    ],
  };
}

const PAYER = { role: "TITLE", email: "idontknowyet@example.com" };

describe("findCreatedParticipantId", () => {
  it("returns the new participant's id, NOT the builderId", () => {
    const id = findCreatedParticipantId(draftWithPayer(), PAYER, BUILDER_ID);
    expect(id).toBe(TITLE_PARTICIPANT_ID);
    expect(id).not.toBe(BUILDER_ID);
  });

  it("never returns the builderId even if it sneaks into a participant pool", () => {
    const draft = {
      id: BUILDER_ID,
      otherParticipants: [
        { id: BUILDER_ID, role: "TITLE", email: "idontknowyet@example.com", createdAt: 9999 },
        { id: TITLE_PARTICIPANT_ID, role: "TITLE", email: "idontknowyet@example.com", createdAt: 1 },
      ],
    };
    expect(findCreatedParticipantId(draft, PAYER, BUILDER_ID)).toBe(TITLE_PARTICIPANT_ID);
  });

  it("prefers the most recently created match (the one we just added)", () => {
    const draft = {
      id: BUILDER_ID,
      otherParticipants: [
        { id: "old-title", role: "TITLE", email: "idontknowyet@example.com", createdAt: 1000 },
        { id: "new-title", role: "TITLE", email: "idontknowyet@example.com", createdAt: 2000 },
      ],
    };
    expect(findCreatedParticipantId(draft, PAYER, BUILDER_ID)).toBe("new-title");
  });

  it("matches on role AND email (doesn't grab a different-role participant)", () => {
    const draft = {
      id: BUILDER_ID,
      otherParticipants: [
        { id: "wrong-role", role: "SELLER", email: "idontknowyet@example.com", createdAt: 5000 },
        { id: TITLE_PARTICIPANT_ID, role: "TITLE", email: "idontknowyet@example.com", createdAt: 1 },
      ],
    };
    expect(findCreatedParticipantId(draft, PAYER, BUILDER_ID)).toBe(TITLE_PARTICIPANT_ID);
  });

  it("returns undefined when no participant matches (so the caller throws instead of mis-wiring)", () => {
    const draft = { id: BUILDER_ID, otherParticipants: [{ id: "x", role: "SELLER", email: null }] };
    expect(findCreatedParticipantId(draft, PAYER, BUILDER_ID)).toBeUndefined();
  });
});

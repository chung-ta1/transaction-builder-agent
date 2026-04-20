import type { Tool } from "../Tool.js";
import { createDraftWithEssentials } from "./create_draft_with_essentials.js";
import { createFullDraft } from "./create_full_draft.js";
import { createReferralPayment } from "./create_referral_payment.js";
import { finalizeDraft } from "./finalize_draft.js";
import { addReferral } from "./add_referral.js";
import { addPartnerAgent } from "./add_partner_agent.js";
import { computeCommissionSplitsTool } from "./compute_commission_splits.js";

export const convenienceTools: Tool[] = [
  // createFullDraft is listed first so the agent's tool-pick picks it by
  // default on the happy path. The other convenience tools stay registered
  // because update-draft, resume-draft, and mid-chain recovery need them.
  createFullDraft,
  createDraftWithEssentials,
  addPartnerAgent,
  addReferral,
  createReferralPayment,
  computeCommissionSplitsTool,
  finalizeDraft,
];

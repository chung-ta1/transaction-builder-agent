import type { Tool } from "../Tool.js";
import { createDraftFull } from "./create_draft_full.js";
import { createReferralPayment } from "./create_referral_payment.js";
import { computeCommissionSplitsTool } from "./compute_commission_splits.js";

/**
 * Convenience tools — kept only when they encode value-add logic the runbook
 * shouldn't carry on its own (math gates, distinct one-shot endpoints, or
 * latency-critical orchestration).
 *
 *   - create_draft_full         — one-call orchestrator with parallel writes;
 *                                 cuts happy-path wall-clock from ~3s to ~1s.
 *   - compute_commission_splits — server-side integer-cents math (G1 gate).
 *   - create_referral_payment   — distinct one-shot endpoint with its own G1
 *                                 + payer-wiring + immediate-disburse logic.
 */
export const convenienceTools: Tool[] = [
  createDraftFull,
  computeCommissionSplitsTool,
  createReferralPayment,
];

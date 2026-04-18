import type { Tool } from "./Tool.js";
import {
  startListingFlow,
  startReferralFlow,
  startResumeDraft,
  startSyncRules,
  startTransactionFlow,
} from "./entry.js";
import { granularTools } from "./granular/index.js";
import { convenienceTools } from "./convenience/index.js";

/**
 * Ordering matters for LLM tool discovery:
 *   1. Entry tools first — Claude's LLM picks these when the user types a
 *      natural-language transaction / listing / referral request. They return
 *      the runbook.
 *   2. Convenience tools next — batched happy-path tools the runbook calls.
 *   3. Granular tools last — one-per-arrakis-endpoint, for corrections.
 */
export const allTools: Tool[] = [
  startTransactionFlow,
  startListingFlow,
  startReferralFlow,
  startResumeDraft,
  startSyncRules,
  ...convenienceTools,
  ...granularTools,
];

import type { Tool } from "./Tool.js";
import {
  startListingFlow,
  startTransactionFlow,
} from "./entry.js";
import { granularTools } from "./granular/index.js";
import { convenienceTools } from "./convenience/index.js";

/**
 * Ordering matters for LLM tool discovery:
 *   1. Entry tools first — Claude's LLM picks these when the user types a
 *      natural-language transaction / listing / referral-payment request. They
 *      return the runbook.
 *   2. Convenience tools next — batched happy-path tools the runbook calls.
 *   3. Granular tools last — one-per-arrakis-endpoint, for corrections.
 *
 * Note: `start_resume_draft` was removed; the resume runbook merged into
 * `update_draft`. Resume intent is now an MCP prompt (no entry tool needed).
 */
export const allTools: Tool[] = [
  startTransactionFlow,
  startListingFlow,
  ...convenienceTools,
  ...granularTools,
];

import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "./init.js";

/**
 * Remove a specific buyer from a draft. Prefer this over rewriting the
 * whole `buyerSeller` array when you're deleting one entry and keeping
 * the rest. Requires the buyer's participant id from `get_draft` →
 * `buyers[].id`.
 *
 * NOTE: arrakis requires at least one buyer on a TRANSACTION-type draft
 * before submit. If this is the last buyer, the draft is left in an
 * incomplete state and will fail submission; tell the user.
 */
export const deleteBuyer = defineTool({
  name: "delete_buyer",
  description:
    "Remove a specific buyer from a draft by buyerId (DELETE /transaction-builder/{id}/buyer/{buyerId}). Use for 'remove the buyer {name}' or 'drop this buyer'. Requires the buyer's participant id (fetch via get_draft → buyers[].id). arrakis requires ≥1 buyer on TRANSACTION drafts at submit — warn the user if this leaves buyers empty.",
  input: z.object({
    env: envSchema,
    builderId: z.string(),
    buyerId: z.string().describe("Participant id of the buyer (from get_draft.buyers[].id)."),
  }),
  async handler({ env, builderId, buyerId }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      return ok(await arrakis.deleteBuyer(env, builderId, buyerId));
    } catch (err) {
      return fromError(err);
    }
  },
});

/** Remove a specific seller. `DELETE /transaction-builder/{id}/seller/{sellerId}`. */
export const deleteSeller = defineTool({
  name: "delete_seller",
  description:
    "Remove a specific seller from a draft by sellerId. arrakis requires ≥1 seller on every draft — warn if this leaves sellers empty.",
  input: z.object({
    env: envSchema,
    builderId: z.string(),
    sellerId: z.string().describe("Participant id of the seller (from get_draft.sellers[].id)."),
  }),
  async handler({ env, builderId, sellerId }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      return ok(await arrakis.deleteSeller(env, builderId, sellerId));
    } catch (err) {
      return fromError(err);
    }
  },
});

/** Remove a co-agent. `DELETE /transaction-builder/{id}/co-agent/{coAgentId}`. */
export const deleteCoAgent = defineTool({
  name: "delete_co_agent",
  description:
    "Remove a co-agent from a draft by coAgentId. Does NOT remove the owner agent. After deletion, commission splits must be recomputed — the runbook should call compute_commission_splits + set_commission_splits + verify_draft_splits.",
  input: z.object({
    env: envSchema,
    builderId: z.string(),
    coAgentId: z.string().describe("Participant id of the co-agent (from get_draft.agentsInfo.coAgents[].id)."),
  }),
  async handler({ env, builderId, coAgentId }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      return ok(await arrakis.deleteCoAgent(env, builderId, coAgentId));
    } catch (err) {
      return fromError(err);
    }
  },
});

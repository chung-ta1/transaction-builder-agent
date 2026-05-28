import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "./init.js";

export const submitDraft = defineTool({
  name: "submit_draft",
  description:
    "Submit a draft — turns the builder into a live Transaction (or active Listing). Runs arrakis's full validate() chain. Map errors via memory/error-messages.md.",
  input: z.object({ env: envSchema, builderId: z.string() }),
  async handler({ env, builderId }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      const result = await arrakis.submitDraft(env, builderId);
      return ok({ submitted: true, builderId, result });
    } catch (err) {
      return fromError(err);
    }
  },
});

/**
 * Convert a Listing toward a Transaction. Two paths:
 *   to: "in_contract" → PUT /listings/{id}/transition/LISTING_IN_CONTRACT
 *   to: "transaction" → POST /transaction-builder/{id}/transaction-to-builder
 *
 * Seller-side flow uses both in sequence: in_contract first (must be in
 * LISTING_ACTIVE), then transaction (must be in LISTING_IN_CONTRACT).
 */
export const convertListing = defineTool({
  name: "convert_listing",
  description:
    "Convert a Listing forward. to='in_contract' transitions ACTIVE → IN_CONTRACT (offer accepted). to='transaction' creates a new TransactionBuilder inheriting the listing's data (listing must already be IN_CONTRACT).",
  input: z.object({
    env: envSchema,
    listingId: z.string(),
    to: z.enum(["in_contract", "transaction"]),
  }),
  async handler({ env, listingId, to }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      if (to === "in_contract") {
        const result = await arrakis.transitionListing(env, listingId, "LISTING_IN_CONTRACT");
        return ok({ listingId, lifecycleState: "LISTING_IN_CONTRACT", result });
      }
      const builderId = await arrakis.buildTransactionFromListing(env, listingId);
      return ok({ builderId });
    } catch (err) {
      return fromError(err);
    }
  },
});

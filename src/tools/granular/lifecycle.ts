import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "./init.js";

/**
 * Lifecycle tools — submit a draft, transition an active listing, or build
 * a transaction builder from an in-contract listing. Together these enable
 * the end-to-end seller-side flow entirely through the MCP:
 *
 *   create_draft_with_essentials(type=LISTING) → (fill fields)
 *     → submit_draft (listing goes LISTING_ACTIVE)
 *     → transition_listing(LISTING_IN_CONTRACT)
 *     → build_transaction_from_listing (creates TX builder copying listing)
 *     → (fill buyer + remaining tx fields)
 *     → finalize_draft + submit_draft (transaction goes NEW → …)
 */

export const submitDraft = defineTool({
  name: "submit_draft",
  description:
    "Submit the builder to arrakis (POST /transaction-builder/{id}/submit) — turns a draft into a real Transaction (or active Listing if type=LISTING was used at creation). Runs the full server-side `validate()` chain. On failure, arrakis returns the specific rule violation; map via memory/error-messages.md.",
  input: z.object({
    env: envSchema,
    builderId: z.string(),
  }),
  async handler({ env, builderId }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      const result = await arrakis.submitDraft(env, builderId);
      return ok({ submitted: true, builderId, result });
    } catch (err) {
      return fromError(err);
    }
  },
});

export const transitionListing = defineTool({
  name: "transition_listing",
  description:
    "Transition a Listing to a new lifecycle state (PUT /listings/{id}/transition/{state}). Key states for the seller-side flow: `LISTING_ACTIVE` (after submit), `LISTING_IN_CONTRACT` (offer accepted — required before creating the seller-side transaction), `LISTING_CLOSED`. Only operates on submitted listings (not drafts).",
  input: z.object({
    env: envSchema,
    listingId: z.string(),
    lifecycleState: z.enum([
      "LISTING_ACTIVE",
      "LISTING_IN_CONTRACT",
      "LISTING_CLOSED",
      "TERMINATION_REQUESTED",
      "TERMINATED",
    ]),
  }),
  async handler({ env, listingId, lifecycleState }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      const result = await arrakis.transitionListing(env, listingId, lifecycleState);
      return ok({ transitioned: true, listingId, lifecycleState, result });
    } catch (err) {
      return fromError(err);
    }
  },
});

export const buildTransactionFromListing = defineTool({
  name: "build_transaction_from_listing",
  description:
    "Given a submitted Listing (LISTING_IN_CONTRACT state), create a new TransactionBuilder that inherits the listing's property/price/seller/commission data. Use when the seller-side agent now has an accepted offer and wants to convert the listing into a transaction. Returns the new builderId — the caller populates buyer info + finalizes.",
  input: z.object({
    env: envSchema,
    listingId: z.string().describe("The listing's id (same as its builderId). Must be in LISTING_IN_CONTRACT state."),
  }),
  async handler({ env, listingId }, { arrakis }): Promise<ToolResult<{ builderId: string }>> {
    try {
      const builderId = await arrakis.buildTransactionFromListing(env, listingId);
      return ok({ builderId });
    } catch (err) {
      return fromError(err);
    }
  },
});

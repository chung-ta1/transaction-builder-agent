import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import {
  agentParticipantInfoSchema,
  buyerSellerSchema,
  envSchema,
  locationInfoSchema,
  priceAndDatesSchema,
} from "../../types/schemas.js";
import { fromError } from "../granular/init.js";

/**
 * Stand up the draft skeleton in one tool call: empty builder → owner →
 * location → price-dates → buyer/seller → (single-rep) owner-info.
 * The agent prefers this to the six granular calls for the happy path.
 *
 * Supports both `type: TRANSACTION` (default) and `type: LISTING`. Listings
 * use the same transaction-builder under the hood — only difference is the
 * query param `?type=LISTING` on creation and that buyers are skipped. The
 * runbook collects `listingDate` + `listingExpirationDate` in `priceAndDates`
 * instead of `acceptanceDate` / `closingDate`.
 */
export const createDraftWithEssentials = defineTool({
  name: "create_draft_with_essentials",
  description:
    "Happy-path: create the draft (transaction OR listing), set owner/location/price/dates/buyers/sellers, and (for single-rep) attach the owner agent in one call. Returns builderId. Pass `type: 'LISTING'` to create a listing — buyers are skipped, listingDate+listingExpirationDate replace acceptance/closing dates. Prefer this over the 6 individual calls when all essentials are known up front.",
  input: z.object({
    env: envSchema,
    type: z
      .enum(["TRANSACTION", "LISTING"])
      .default("TRANSACTION")
      .describe("TRANSACTION (default) or LISTING. Listings use the same builder but skip buyer info and use listingDate/listingExpirationDate in priceAndDates."),
    transactionOwnerId: z.string().uuid(),
    location: locationInfoSchema,
    priceAndDates: priceAndDatesSchema,
    buyerSeller: buyerSellerSchema,
    ownerAgent: agentParticipantInfoSchema.optional(),
    officeId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
  }),
  async handler(args, { arrakis }): Promise<ToolResult<{ builderId: string }>> {
    const {
      env,
      type,
      transactionOwnerId,
      location,
      priceAndDates,
      buyerSeller,
      ownerAgent,
      officeId,
      teamId,
    } = args;
    try {
      const builderId = await arrakis.initializeDraft(env, type);
      // NOTE: arrakis auto-sets transactionOwnerId to the JWT subject on init.
      // PATCH /transaction-owner is TRANSACTION_COORDINATOR-only (regular
      // AGENT role gets 403 — see arrakis TransactionBuilderAuthTests
      // `whenCalledByNonOwnerAgent_thenForbidden`). Don't call it on the happy
      // path; reassignment is a separate TC workflow.
      void transactionOwnerId; // kept in the input schema for API stability
      await arrakis.updateLocationInfo(env, builderId, location);
      await arrakis.updatePriceAndDateInfo(env, builderId, priceAndDates);
      // Listings have no buyers by definition; skip buyers on buyer-seller
      // update regardless of what the caller sent. Sellers are always set.
      const listingSafeBuyerSeller =
        type === "LISTING" ? { ...buyerSeller, buyers: [] } : buyerSeller;
      await arrakis.updateBuyerAndSellerInfo(env, builderId, listingSafeBuyerSeller);

      const isDual = priceAndDates.representationType === "DUAL";
      if (!isDual && ownerAgent) {
        await arrakis.updateOwnerAgentInfo(env, builderId, {
          ownerAgent,
          ...(officeId ? { officeId } : {}),
          ...(teamId ? { teamId } : {}),
        });
      }
      return ok({ builderId, type });
    } catch (err) {
      return fromError(err);
    }
  },
});

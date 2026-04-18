import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "./init.js";

/**
 * Discovery tools — inspect existing state before creating new state.
 * These let a smart agent answer "does this already exist?" before adding
 * duplicates. Use them at the top of any create-flow when the user's intent
 * might overlap with prior work (e.g. they asked for a seller-side
 * transaction but already have a listing at that address).
 */

export const searchExistingListings = defineTool({
  name: "search_existing_listings",
  description:
    "Search the user's existing listings (submitted Listing objects, not drafts). Use BEFORE creating a new listing — if the user already has an active or in-contract listing for the property, resume it instead of duplicating. Filter by lifecycleState to narrow (e.g., LISTING_ACTIVE, LISTING_IN_CONTRACT).",
  input: z.object({
    env: envSchema,
    ownerYentaId: z.string().uuid(),
    lifecycleState: z
      .enum([
        "LISTING_ACTIVE",
        "LISTING_IN_CONTRACT",
        "LISTING_CLOSED",
        "TERMINATED",
      ])
      .optional(),
    pageSize: z.number().int().min(1).max(50).default(20),
  }),
  async handler({ env, ownerYentaId, lifecycleState, pageSize }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      const listings = await arrakis.searchListings(env, {
        ownerId: ownerYentaId,
        lifecycleState,
        pageSize,
      });
      return ok({ listings });
    } catch (err) {
      return fromError(err);
    }
  },
});

export const listMyBuilders = defineTool({
  name: "list_my_builders",
  description:
    "List the user's in-progress transaction-builder drafts. Use at the START of any create-flow to discover unfinished drafts from prior sessions — so the agent can resume instead of duplicating. Filter by type to get only LISTING or only TRANSACTION drafts.",
  input: z.object({
    env: envSchema,
    yentaId: z.string().uuid(),
    type: z.enum(["TRANSACTION", "LISTING"]).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async handler({ env, yentaId, type, limit }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      const builders = await arrakis.listBuilders(env, { yentaId, type, limit });
      return ok({ builders });
    } catch (err) {
      return fromError(err);
    }
  },
});

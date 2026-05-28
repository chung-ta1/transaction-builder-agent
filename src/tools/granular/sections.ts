import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import {
  buyerSellerSchema,
  envSchema,
  locationInfoSchema,
  ownerAgentInfoSchema,
  priceAndDatesSchema,
} from "../../types/schemas.js";
import { fromError } from "./init.js";

/**
 * Single tool replacing the four PUT-section writers. The `section`
 * discriminator picks which arrakis subsection to update; the matching
 * `data` shape comes from the existing per-section zod schemas.
 *
 *   location     → PUT /location-info
 *   price-date   → PUT /price-date-info
 *   buyer-seller → PUT /buyer-seller-info
 *   owner        → PUT /owner-info
 */
export const updateDraftSection = defineTool({
  name: "update_draft_section",
  description:
    "Update one subsection of a draft. The `section` discriminator picks which arrakis section gets PUT; data shape varies per section. Use 'location' for property address, 'price-date' for deal terms, 'buyer-seller' for parties, 'owner' for the owning agent + office/team.",
  input: z.discriminatedUnion("section", [
    z.object({ env: envSchema, builderId: z.string(), section: z.literal("location"), data: locationInfoSchema }),
    z.object({ env: envSchema, builderId: z.string(), section: z.literal("price-date"), data: priceAndDatesSchema }),
    z.object({ env: envSchema, builderId: z.string(), section: z.literal("buyer-seller"), data: buyerSellerSchema }),
    z.object({ env: envSchema, builderId: z.string(), section: z.literal("owner"), data: ownerAgentInfoSchema }),
  ]),
  async handler(args, { arrakis }): Promise<ToolResult<unknown>> {
    const { env, builderId, section, data } = args;
    try {
      switch (section) {
        case "location":
          return ok(await arrakis.updateLocationInfo(env, builderId, data));
        case "price-date":
          return ok(await arrakis.updatePriceAndDateInfo(env, builderId, data));
        case "buyer-seller":
          return ok(await arrakis.updateBuyerAndSellerInfo(env, builderId, data));
        case "owner":
          return ok(await arrakis.updateOwnerAgentInfo(env, builderId, data));
      }
    } catch (err) {
      return fromError(err);
    }
  },
});

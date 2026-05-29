import { defineTool, ok, type ToolResult } from "../Tool.js";
import { resolveLocationSchema } from "../../types/schemas.js";
import type { LocationCandidate } from "../../services/GeocoderApi.js";
import { fromError } from "./init.js";

export const resolveLocation = defineTool({
  name: "resolve_location",
  description:
    "Resolve a property's ZIP — and backfill its state/country/currency — from street + city (+ optional state) via the US Census Geocoder (free, no key, US-only). Call this BEFORE asking the user for a missing ZIP (or state). Returns { candidates, unambiguous }; each candidate carries { zip, state (enum, e.g. NEW_YORK), country, currency, city, matchedAddress }. When `unambiguous` is true, use candidates[0] silently (and show its matchedAddress so a wrong match is catchable); when false (zero matches or several distinct ZIPs) fall back to asking — surface multiple candidates as the question's options. Never fabricate a ZIP from this; an empty result means ask.",
  input: resolveLocationSchema,
  async handler(
    args,
    { geocoder },
  ): Promise<ToolResult<{ candidates: LocationCandidate[]; unambiguous: boolean }>> {
    try {
      const result = await geocoder.resolve(args);
      return ok(result);
    } catch (err) {
      return fromError(err);
    }
  },
});

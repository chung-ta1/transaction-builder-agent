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

export const getTransaction = defineTool({
  name: "get_transaction",
  description:
    "Read back a submitted Transaction or listing (a listing IS a Transaction with listing=true) by id OR by code. Use AFTER submit_draft, when get_draft 404s because the builder was consumed. Pass `id` (the submit response's id) and/or `code` (e.g. 'T9O-29P-KYU-BRU'); tries id first, then falls back to code. Returns the raw live entity so the seller-side chain can resolve the correct id for convert_listing.",
  input: z
    .object({
      env: envSchema,
      id: z.string().optional(),
      code: z.string().optional(),
    })
    .refine((v) => Boolean(v.id || v.code), {
      message: "Provide at least one of id or code",
    }),
  async handler({ env, id, code }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      if (id) {
        try {
          return ok({ transaction: await arrakis.getTransactionById(env, id), resolvedBy: "id" });
        } catch (err) {
          if (!code) return fromError(err);
        }
      }
      return ok({ transaction: await arrakis.getTransactionByCode(env, code!), resolvedBy: "code" });
    } catch (err) {
      return fromError(err);
    }
  },
});

export const listMyBuilders = defineTool({
  name: "list_my_builders",
  description:
    "List the user's in-progress transaction-builder drafts — SUMMARY SHAPE ONLY (builderId, type, address, dealType, representation, price, commission, yearBuilt, mlsNumber, createdAt/updatedAt). For the full draft body call `get_draft(env, builderId)` as a second step. Use this at the START of any create / resume / submit / update / delete flow to discover unfinished drafts; the summary is small enough to keep 10+ rows in context without blowing the response budget.",
  input: z.object({
    env: envSchema,
    yentaId: z.string().uuid(),
    type: z.enum(["TRANSACTION", "LISTING"]).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async handler({ env, yentaId, type, limit }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      const raw = await arrakis.listBuilders(env, { yentaId, type, limit });
      return ok({ builders: summarizeBuilderListing(raw) });
    } catch (err) {
      return fromError(err);
    }
  },
});

/**
 * Project an arrakis paged-builder response down to a compact summary. The
 * full response returns every participant, every commission split, every
 * ledger item — ~9 KB per draft. Callers that need the detail must use
 * `get_draft` on a specific builderId; this tool only surfaces what's
 * needed to pick one from a list.
 */
export function summarizeBuilderListing(raw: unknown): {
  pageNumber: number | null;
  pageSize: number | null;
  hasNext: boolean | null;
  totalCount: number | null;
  results: BuilderSummary[];
} {
  const paged = (raw ?? {}) as Record<string, unknown>;
  const results = Array.isArray(paged.results) ? paged.results : [];
  return {
    pageNumber: asNumberOrNull(paged.pageNumber),
    pageSize: asNumberOrNull(paged.pageSize),
    hasNext: typeof paged.hasNext === "boolean" ? paged.hasNext : null,
    totalCount: asNumberOrNull(paged.totalCount),
    results: results.map(summarizeBuilder),
  };
}

interface BuilderSummary {
  id: string;
  builderType: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  address: {
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    oneLine: string;
  } | null;
  dealType: string | null;
  propertyType: string | null;
  representationType: string | null;
  salePrice: { amount: number; currency: string } | null;
  grossCommission: { amount: number; currency: string } | null;
  yearBuilt: number | null;
  mlsNumber: string | null;
  teamId: string | null;
  builtFromTransactionId: string | null;
}

function summarizeBuilder(raw: unknown): BuilderSummary {
  const b = (raw ?? {}) as Record<string, unknown>;
  const addr = (b.address ?? {}) as Record<string, unknown>;
  const agents = (b.agentsInfo ?? {}) as Record<string, unknown>;
  const street = asStringOrNull(addr.street);
  const city = asStringOrNull(addr.city);
  const state = asStringOrNull(addr.state);
  const zip = asStringOrNull(addr.zip);
  return {
    id: asStringOrNull(b.id) ?? "",
    builderType: asStringOrNull(b.builderType),
    createdAt: asNumberOrNull(b.createdAt),
    updatedAt: asNumberOrNull(b.updatedAt),
    address: street || city
      ? {
          street,
          city,
          state,
          zip,
          oneLine: [street, city, state, zip].filter(Boolean).join(", "),
        }
      : null,
    dealType: asStringOrNull(b.dealType),
    propertyType: asStringOrNull(b.propertyType),
    representationType: asStringOrNull(agents.representationType),
    salePrice: asMoneyOrNull(b.salePrice),
    grossCommission: asMoneyOrNull(
      (b.grossCommission as Record<string, unknown> | undefined)?.commissionAmount ?? b.grossCommission,
    ),
    yearBuilt: asNumberOrNull(b.yearBuilt),
    mlsNumber: asStringOrNull(b.mlsNumber),
    teamId: asStringOrNull(agents.teamId),
    builtFromTransactionId: asStringOrNull(b.builtFromTransactionId),
  };
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asMoneyOrNull(v: unknown): { amount: number; currency: string } | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const amount = m.amount;
  const currency = m.currency;
  if (typeof amount !== "number" || typeof currency !== "string") return null;
  return { amount, currency };
}

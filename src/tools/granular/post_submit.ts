import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "./init.js";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const upsertInstallments = defineTool({
  name: "upsert_installments",
  description:
    "Modify installment schedule on a SUBMITTED transaction (not a draft). Pass newInstallments[] or updatedInstallments[] with percent-string amounts (must sum to 100). Feature-flagged; 404 if app.flags.installments.enabled is off.",
  input: z.object({
    env: envSchema,
    transactionId: z.string().describe("Submitted transaction id (not a builder id)."),
    newInstallments: z.array(z.object({
      amount: z.string().regex(/^\d+(\.\d+)?$/),
      estimatedClosingDate: z.string().regex(isoDate),
    })).optional(),
    updatedInstallments: z.array(z.object({
      transactionId: z.string(),
      amount: z.string().regex(/^\d+(\.\d+)?$/),
      estimatedClosingDate: z.string().regex(isoDate),
    })).optional(),
  }),
  async handler({ env, transactionId, newInstallments, updatedInstallments }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      return ok(await arrakis.upsertInstallments(env, transactionId, { newInstallments, updatedInstallments }));
    } catch (err) {
      return fromError(err);
    }
  },
});

/**
 * Request termination of a SUBMITTED transaction OR undo a prior request.
 *   state: "request" → PUT /transactions/{id}/termination-requested
 *   state: "undo"    → PUT /transactions/{id}/undo-termination-request
 *
 * For DRAFT cancellation use delete_draft instead. Once the broker has
 * advanced past TERMINATION_REQUESTED, undo no longer reverts the state.
 */
export const setTermination = defineTool({
  name: "set_termination",
  description:
    "Request or undo termination on a SUBMITTED transaction. state='request' → TERMINATION_REQUESTED (broker completes the final move). state='undo' reverses; only valid while still in TERMINATION_REQUESTED. For DRAFT cancellation use delete_draft.",
  input: z.object({
    env: envSchema,
    transactionId: z.string(),
    state: z.enum(["request", "undo"]),
  }),
  async handler({ env, transactionId, state }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      const result = state === "request"
        ? await arrakis.requestTermination(env, transactionId)
        : await arrakis.undoTerminationRequest(env, transactionId);
      return ok({ state, transactionId, result });
    } catch (err) {
      return fromError(err);
    }
  },
});

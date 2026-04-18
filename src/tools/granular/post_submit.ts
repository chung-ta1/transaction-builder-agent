import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "./init.js";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Define or update the installment schedule on a SUBMITTED transaction.
 * Maps to `PUT /api/v1/transactions/{id}/installments`. Requires the
 * transaction to have been submitted with `requiresInstallments: true`
 * on the builder, AND arrakis's `app.flags.installments.enabled` feature
 * flag to be on for the env.
 *
 * Each installment has:
 *  - `amount`: a percent string (e.g. "50.00") — portion of the parent
 *    transaction's total commission that goes to this installment. All
 *    installment amounts in the final state must sum to 100.00.
 *  - `estimatedClosingDate`: ISO yyyy-MM-dd.
 *
 * `updatedInstallments[]` carries an additional `transactionId` pointing
 * at the sub-transaction being edited (get via `/installments` GET).
 */
export const upsertInstallments = defineTool({
  name: "upsert_installments",
  description:
    "Define or modify the installment schedule on a SUBMITTED transaction (PUT /transactions/{id}/installments). Feature-flagged; 404 on envs without app.flags.installments.enabled. Each installment = percent-string amount + estimatedClosingDate. Pass `newInstallments[]` for fresh entries or `updatedInstallments[]` with sub-transaction ids to edit existing. Sum of amounts in the final state must be 100.00.",
  input: z.object({
    env: envSchema,
    transactionId: z.string().describe("Submitted transaction id (not a builder id)."),
    newInstallments: z
      .array(
        z.object({
          amount: z.string().regex(/^\d+(\.\d+)?$/).describe("Percent-of-total as a decimal string, e.g. '50.00'."),
          estimatedClosingDate: z.string().regex(isoDate),
        }),
      )
      .optional(),
    updatedInstallments: z
      .array(
        z.object({
          transactionId: z.string(),
          amount: z.string().regex(/^\d+(\.\d+)?$/),
          estimatedClosingDate: z.string().regex(isoDate),
        }),
      )
      .optional(),
  }),
  async handler({ env, transactionId, newInstallments, updatedInstallments }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      return ok(await arrakis.upsertInstallments(env, transactionId, {
        newInstallments,
        updatedInstallments,
      }));
    } catch (err) {
      return fromError(err);
    }
  },
});

/**
 * Request termination of a SUBMITTED transaction. The agent can only move
 * the transaction to TERMINATION_REQUESTED; the broker/admin then
 * completes the transition to TERMINATED via a separate endpoint.
 *
 * For DRAFT cancellation (unsubmitted builder), use `delete_draft` instead
 * — termination is a post-submit concept.
 */
export const requestTermination = defineTool({
  name: "request_termination",
  description:
    "Request termination of a submitted transaction (PUT /transactions/{id}/termination-requested). Moves the transaction to TERMINATION_REQUESTED state. Broker/admin completes the final transition to TERMINATED. For DRAFT cancellation, use delete_draft instead.",
  input: z.object({
    env: envSchema,
    transactionId: z.string().describe("Submitted transaction id (not a builder id)."),
  }),
  async handler({ env, transactionId }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      return ok(await arrakis.requestTermination(env, transactionId));
    } catch (err) {
      return fromError(err);
    }
  },
});

/** Undo a prior termination request. `PUT /transactions/{id}/undo-termination-request`. */
export const undoTerminationRequest = defineTool({
  name: "undo_termination_request",
  description:
    "Undo a prior termination request on a submitted transaction (PUT /transactions/{id}/undo-termination-request). Only valid while in TERMINATION_REQUESTED state — once the broker has moved it to TERMINATED this won't revert.",
  input: z.object({
    env: envSchema,
    transactionId: z.string().describe("Submitted transaction id."),
  }),
  async handler({ env, transactionId }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      return ok(await arrakis.undoTerminationRequest(env, transactionId));
    } catch (err) {
      return fromError(err);
    }
  },
});

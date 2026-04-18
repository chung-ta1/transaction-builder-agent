import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "./init.js";

/**
 * Permanently delete a draft (transaction-builder) from arrakis. Maps to
 * `DELETE /api/v1/transaction-builder/{id}`. Use when the user says
 * "delete draft X", "cancel that draft", "throw away the draft" on an
 * unsubmitted builder.
 *
 * For a submitted Transaction, use the termination flow instead
 * (`transition_listing` with TERMINATION_REQUESTED / TERMINATED, or the
 * transaction-level termination endpoint). The skill runbook covers this
 * branching so callers of this tool can assume they're on a draft.
 */
export const deleteDraft = defineTool({
  name: "delete_draft",
  description:
    "Permanently delete a draft transaction-builder. DELETE /api/v1/transaction-builder/{id}. Irreversible — the runbook should preview the draft being deleted before firing this. For a submitted Transaction (not a draft), do NOT use this tool — use termination instead.",
  input: z.object({
    env: envSchema,
    builderId: z.string().describe("The builder/draft id to delete."),
  }),
  async handler({ env, builderId }, { arrakis }): Promise<ToolResult<{ deleted: true; builderId: string }>> {
    try {
      await arrakis.deleteDraft(env, builderId);
      return ok({ deleted: true, builderId });
    } catch (err) {
      return fromError(err);
    }
  },
});

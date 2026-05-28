import { fail, type ToolResult } from "../Tool.js";
import { ApiError } from "../../services/BaseApi.js";

/**
 * Shared error coercion. Used by every granular tool that calls the arrakis
 * API directly. Centralizing here means each tool's catch block stays one
 * line.
 *
 * Note: the granular `create_draft` tool was removed once `create_draft_full`
 * (in `convenience/`) became capable of handling the skeleton case (just env
 * + type + transactionOwnerId — no subsection data). Use `create_draft_full`
 * for any draft creation.
 */
export function fromError(err: unknown): ToolResult<never> {
  if (err instanceof ApiError) return fail(err.message, { status: err.status, body: err.body });
  if (err instanceof Error) return fail(err.message);
  return fail(String(err));
}

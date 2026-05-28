import { z } from "zod";
import { defineTool, fail, ok, type ToolResult } from "./Tool.js";
import { readPromptContent } from "../prompts/index.js";

/**
 * Entry-point tools. These return the authoritative runbook so natural-language
 * triggers ("create a transaction…") auto-load the full flow without the user
 * having to click an MCP prompt from a menu or type a slash command.
 *
 * Claude's LLM sees the tool description, matches it against the user's intent,
 * calls the tool, reads the returned runbook, and follows it step-by-step.
 */

export const startTransactionFlow = defineTool({
  name: "start_transaction_flow",
  description:
    "CALL THIS FIRST whenever the user describes ANY real-estate transaction or draft — phrases like 'create a transaction', 'new draft', 'build a transaction', 'start a deal', 'draft a sale', or any natural-language message that mentions commission, property address, sale/lease, agents, or referral. Returns the mandatory runbook you MUST follow to draft the transaction correctly (parallel pre-flight, parse summary, completeness check, 7-guard commission-math accuracy stack with integer-cents math, renormalization ACK gate, preview + confirm, post-write verification, audit log). Do NOT call any transaction-builder write tools before invoking this. The runbook tells you when and in what order to call them.",
  input: z.object({
    userPrompt: z
      .string()
      .min(1)
      .describe("The user's original request, verbatim. Used for the parse step inside the runbook."),
  }),
  async handler({ userPrompt }): Promise<
    ToolResult<{ runbook: string; userPrompt: string; next: string }>
  > {
    try {
      const runbook = await readPromptContent("create_transaction");
      return ok({
        runbook,
        userPrompt,
        next: "Follow the runbook exactly, starting at step 0 (parallel pre-flight). The runbook is authoritative — do not improvise.",
      });
    } catch (err) {
      return fail(
        `Failed to load runbook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export const startListingFlow = defineTool({
  name: "start_listing_flow",
  description:
    "CALL THIS FIRST when the user asks to CREATE a listing — 'create a listing', 'new listing', 'list this property', 'add listing for …', or any phrasing that describes putting a property on the market from the seller/landlord side. Returns the listing runbook: same smart-parse + validator pattern as transactions, but 5 steps instead of 11, type=LISTING, no buyers, uses listingDate + listingExpirationDate. Do NOT use this when the user is closing a deal they already have — that's /create-transaction.",
  input: z.object({
    userPrompt: z.string().min(1),
  }),
  async handler({ userPrompt }): Promise<
    ToolResult<{ runbook: string; userPrompt: string; next: string }>
  > {
    try {
      const runbook = await readPromptContent("create_listing");
      return ok({
        runbook,
        userPrompt,
        next: "Follow the listing runbook. type=LISTING, no buyers, listingDate + listingExpirationDate, both commissions required.",
      });
    } catch (err) {
      return fail(
        `Failed to load create-listing runbook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});


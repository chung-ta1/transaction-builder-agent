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
    "CALL THIS FIRST whenever the user describes ANY real-estate transaction or draft — phrases like 'create a transaction', 'new draft', 'build a transaction', 'start a deal', 'draft a sale', or any natural-language message that mentions commission, property address, sale/lease, agents, or referral. Returns the mandatory runbook you MUST follow to draft the transaction correctly (parallel pre-flight, parse summary, completeness check, 7-guard commission-math accuracy stack with integer-cents math, renormalization ACK gate, preview + confirm, post-write verification, audit log). Do NOT call any other transaction-builder write tools (create_draft_with_essentials, add_partner_agent, set_commission_splits, etc.) before invoking this. The runbook tells you when and in what order to call them.",
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

export const startSyncRules = defineTool({
  name: "start_sync_rules",
  description:
    "Call when the user asks to 'sync the rules', 'update the rules', 'refresh the logic', 'check for updates', or suspects this tool is behind a recent change to Real's source. Returns the rules-refresh runbook you should follow to rebuild memory/transaction-rules.md from Real's live source. Call this before offering the user a fresh draft if they flagged the tool felt stale.",
  input: z.object({}),
  async handler(): Promise<ToolResult<{ runbook: string; next: string }>> {
    try {
      const runbook = await readPromptContent("sync_rules");
      return ok({
        runbook,
        next: "Follow the rules-refresh runbook. After it completes, summarize what changed for the user in one or two sentences.",
      });
    } catch (err) {
      return fail(
        `Failed to load sync-rules runbook: ${err instanceof Error ? err.message : String(err)}`,
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

export const startReferralFlow = defineTool({
  name: "start_referral_flow",
  description:
    "CALL THIS FIRST when the user wants to POST a marketplace referral — 'post a referral', 'find an agent for my client', 'refer out a buyer', 'I have a client looking for …', 'marketplace referral'. Returns the referral runbook. This is DIFFERENT from paying a referral fee on a transaction (that's the regular /create-transaction flow with `add_referral`). Only use this for the marketplace posting flow.",
  input: z.object({
    userPrompt: z.string().min(1),
  }),
  async handler({ userPrompt }): Promise<
    ToolResult<{ runbook: string; userPrompt: string; next: string }>
  > {
    try {
      const runbook = await readPromptContent("create_referral");
      return ok({
        runbook,
        userPrompt,
        next: "Follow the referral runbook. Parse client-type, budget, location, fee, timeline. Call create_marketplace_referral.",
      });
    } catch (err) {
      return fail(
        `Failed to load create-referral runbook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export const startResumeDraft = defineTool({
  name: "start_resume_draft",
  description:
    "CALL THIS FIRST when the user asks to resume or continue a prior draft — 'resume the draft', 'pick up where I left off', 'continue the last transaction', 'finish that draft from earlier', or when the user references a specific builderId. Returns the resume-draft runbook that walks you through fetching the existing draft, identifying what's missing, filling in only the gaps, and finalizing without overwriting correct fields. Do NOT call `create_draft_with_essentials` for a resume — that creates a new builderId.",
  input: z.object({
    builderId: z
      .string()
      .optional()
      .describe("Optional: the builderId the user mentioned. If omitted, the runbook checks memory/active-drafts.md for the most recent unfinished draft."),
  }),
  async handler({ builderId }): Promise<
    ToolResult<{ runbook: string; builderId?: string; next: string }>
  > {
    try {
      const runbook = await readPromptContent("resume_draft");
      return ok({
        runbook,
        builderId,
        next: "Follow the resume-draft runbook. Identify the target draft, show a status summary, fill only the missing pieces, verify, finalize.",
      });
    } catch (err) {
      return fail(
        `Failed to load resume-draft runbook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

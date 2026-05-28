import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * MCP prompts exposed by the transaction-builder-agent server. Each one points at a
 * markdown file under this directory which is the single source of truth for
 * the runbook it contains. The CLI skill + subagent files are generated from
 * the same sources (see scripts/gen-cli-wrappers.sh).
 */
export interface PromptDef {
  name: string;
  description: string;
  file: string; // absolute path
}

export const prompts: PromptDef[] = [
  {
    name: "create_transaction",
    description:
      "Guide Claude through creating a Real Brokerage draft transaction from a plain-English prompt. Includes the full 7-guard commission-math accuracy stack.",
    file: join(__dirname, "create_transaction.md"),
  },
  {
    name: "create_listing",
    description:
      "Create a Real Brokerage listing (type=LISTING transaction-builder). 5-step flow: Property → Price/Commission/Dates → Seller → Transaction Owner → Finalize. Same smart-parse + validator pattern as transactions.",
    file: join(__dirname, "create_listing.md"),
  },
  {
    name: "create_from_document",
    description:
      "Create a Real Brokerage transaction or listing from a PDF or image of a real-estate document (listing agreement, purchase/sale contract, buyer-rep agreement). Reads the document with the multimodal Read tool, extracts only filled-in terms (never fabricating from blank fields or form annotations), confirms the extraction, then hands off to create_listing or create_transaction.",
    file: join(__dirname, "create_from_document.md"),
  },
  {
    name: "create_referral_payment",
    description:
      "Create a referral-payment transaction (the 'Create Referral / Payment' button in Bolt). One-shot arrakis `POST /agent/{id}/referral-and-disburse`; no draft stage, so the runbook enforces an in-chat preview + explicit confirm before firing.",
    file: join(__dirname, "create_referral_payment.md"),
  },
  {
    name: "update_draft",
    description:
      "Modify or resume an existing draft. Two intents share this skill: explicit mutation ('change price to X', 'add partner Y', 'flip to installments') OR resume-toward-submittable ('resume the draft', 'pick up where I left off', 'finish that draft'). Auto-picks the most-recent in-flight draft when no target is named in resume intent. Single or batched changes in one turn.",
    file: join(__dirname, "update_draft.md"),
  },
  {
    name: "submit_draft",
    description:
      "Submit a draft transaction or listing to arrakis (promote the builder to a live Transaction/Listing). Runs pre-submit sanity first, then POSTs /transaction-builder/{id}/submit and scans for post-submit warnings.",
    file: join(__dirname, "submit_draft.md"),
  },
  {
    name: "delete_draft",
    description:
      "Permanently delete an unsubmitted draft from arrakis. Irreversible — preview the draft being deleted, then fire DELETE /transaction-builder/{id}. For submitted transactions use termination instead.",
    file: join(__dirname, "delete_draft.md"),
  },
  {
    name: "list_drafts",
    description:
      "List the user's in-flight (unsubmitted) drafts. Shows builderIds, type, property, amount, and status with shortcuts for follow-up actions.",
    file: join(__dirname, "list_drafts.md"),
  },
];

export async function readPromptContent(name: string): Promise<string> {
  const def = prompts.find((p) => p.name === name);
  if (!def) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  return readFile(def.file, "utf-8");
}

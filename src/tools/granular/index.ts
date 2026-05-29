import type { Tool } from "../Tool.js";
import { setCommissionSplits, setOpcity, wireCommissionPayer } from "./commission.js";
import { deleteDraft } from "./delete_draft.js";
import { getTransaction, listMyBuilders, searchExistingListings } from "./discover.js";
import { setFinalizeFlags } from "./finalize.js";
import { lookupError } from "./lookup_error.js";
import { convertListing, submitDraft } from "./lifecycle.js";
import { addParticipant, removeParticipant } from "./participants.js";
import { setTermination, upsertInstallments } from "./post_submit.js";
import { preFlight } from "./pre_flight.js";
import { preSubmitCheck } from "./pre_submit_check.js";
import { resolveLocation } from "./resolve_location.js";
import { getDraft } from "./read.js";
import { addReferral } from "./referral.js";
import { searchAgentByName } from "./search.js";
import { updateDraftSection } from "./sections.js";
import { validateAgents } from "./validate_agents.js";
import { validateDraftCompleteness } from "./validate_draft_completeness.js";

export const granularTools: Tool[] = [
  // pre-flight
  preFlight,
  validateDraftCompleteness,
  preSubmitCheck,
  validateAgents,
  lookupError,
  // search / discovery
  searchAgentByName,
  resolveLocation,
  searchExistingListings,
  listMyBuilders,
  getDraft,
  getTransaction,
  // section writers (one tool, four sections — for resume/update only;
  // create_draft_full is the path for fresh drafts)
  updateDraftSection,
  // participants
  addParticipant,
  removeParticipant,
  // referral
  addReferral,
  // commission
  setOpcity,
  setCommissionSplits,
  wireCommissionPayer,
  // finalize-flag subsections
  setFinalizeFlags,
  // lifecycle
  submitDraft,
  convertListing,
  deleteDraft,
  // post-submit
  upsertInstallments,
  setTermination,
];

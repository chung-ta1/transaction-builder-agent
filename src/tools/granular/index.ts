import type { Tool } from "../Tool.js";
import { initializeDraft, setTransactionOwner } from "./init.js";
import { updateLocation, updatePriceAndDates } from "./location.js";
import {
  addCoAgent,
  addOtherSideAgent,
  addTransactionCoordinator,
  setOwnerAgentInfo,
  updateBuyerSeller,
} from "./participants.js";
import { addExternalReferral, addInternalReferral, uploadReferralW9 } from "./referral.js";
import {
  addCommissionPayerParticipant,
  setCommissionPayer,
  setCommissionSplits,
  setOpcity,
} from "./commission.js";
import {
  updateAdditionalFeesInfo,
  updateFmlsInfo,
  updatePersonalDealInfo,
  updateTitleInfo,
} from "./finalize.js";
import { getDraft } from "./read.js";
import { searchAgentByName } from "./search.js";
import { listMyBuilders, searchExistingListings } from "./discover.js";
import {
  buildTransactionFromListing,
  submitDraft,
  transitionListing,
} from "./lifecycle.js";
import { preFlight } from "./pre_flight.js";
import { validateDraftCompleteness } from "./validate_draft_completeness.js";
import { verifyAuth } from "./verify_auth.js";
import { signOut } from "./sign_out.js";
import { deleteDraft } from "./delete_draft.js";
import { deleteBuyer, deleteSeller, deleteCoAgent } from "./delete_participants.js";
import { upsertInstallments, requestTermination, undoTerminationRequest } from "./post_submit.js";
import { verifyDraftSplits } from "./verify_draft_splits.js";

export const granularTools: Tool[] = [
  // pre-flight
  preFlight,
  validateDraftCompleteness,
  verifyAuth,
  signOut,
  // search
  searchAgentByName,
  // create / owner
  initializeDraft,
  setTransactionOwner,
  // location + price
  updateLocation,
  updatePriceAndDates,
  // participants
  updateBuyerSeller,
  setOwnerAgentInfo,
  addCoAgent,
  addOtherSideAgent,
  addTransactionCoordinator,
  // participants — individual deletes (prefer these over rewriting whole arrays)
  deleteBuyer,
  deleteSeller,
  deleteCoAgent,
  // referral
  addInternalReferral,
  addExternalReferral,
  uploadReferralW9,
  // commission
  setOpcity,
  setCommissionSplits,
  verifyDraftSplits,
  addCommissionPayerParticipant,
  setCommissionPayer,
  // finalize
  updatePersonalDealInfo,
  updateAdditionalFeesInfo,
  updateTitleInfo,
  updateFmlsInfo,
  // lifecycle — submit/transition/build-from-listing/delete
  submitDraft,
  transitionListing,
  buildTransactionFromListing,
  deleteDraft,
  // post-submit operations (submitted transactions, not drafts)
  upsertInstallments,
  requestTermination,
  undoTerminationRequest,
  // discovery — inspect existing state before creating new
  searchExistingListings,
  listMyBuilders,
  // read
  getDraft,
];

import FormData from "form-data";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { BaseApi } from "./BaseApi.js";
import type { AuthService } from "../auth/AuthService.js";
import { urlsFor, type Env } from "../config.js";
import type {
  AddParticipantRequest,
  AdditionalFees,
  AgentParticipantInfo,
  BuyerSeller,
  CommissionPayerInfo,
  CommissionSplit,
  FmlsInfo,
  LocationInfo,
  OwnerAgentInfo,
  PersonalDealInfo,
  PriceAndDates,
  TitleInfo,
} from "../types/schemas.js";

const BASE_PATH = "/api/v1/transaction-builder";

/**
 * Thin client over arrakis's TransactionBuilder REST surface. One method per
 * endpoint in the canonical 22-call sequence (see memory/transaction-rules.md
 * and plan). No business logic — tools call these.
 */
export class TransactionBuilderApi extends BaseApi {
  constructor(auth: AuthService) {
    super(auth, (env) => urlsFor(env).arrakis);
  }

  // ---------- create / fetch ----------
  initializeDraft(env: Env, type: "TRANSACTION" | "LISTING" = "TRANSACTION"): Promise<string> {
    return this.request<string>(env, {
      method: "POST",
      url: BASE_PATH,
      params: { type },
    });
  }

  getDraft(env: Env, id: string): Promise<unknown> {
    return this.request(env, { method: "GET", url: `${BASE_PATH}/${id}` });
  }

  /**
   * Delete a transaction-builder (soft-cancel the draft). The underlying
   * endpoint is `DELETE /api/v1/transaction-builder/{id}` and maps to
   * `TransactionBuilderController.deleteTransactionBuilder`. Works while the
   * builder is in draft state; on submitted transactions use the
   * transition-to-TERMINATED flow instead.
   */
  deleteDraft(env: Env, id: string): Promise<void> {
    return this.request<void>(env, {
      method: "DELETE",
      url: `${BASE_PATH}/${id}`,
    });
  }

  /**
   * Remove a specific buyer from the builder. Maps to
   * `DELETE /transaction-builder/{id}/buyer/{buyerId}`. Use when the user
   * wants to drop an individual buyer without wiping the whole array.
   */
  deleteBuyer(env: Env, id: string, buyerId: string): Promise<unknown> {
    return this.request(env, {
      method: "DELETE",
      url: `${BASE_PATH}/${id}/buyer/${buyerId}`,
    });
  }

  /** Remove a specific seller. `DELETE /transaction-builder/{id}/seller/{sellerId}`. */
  deleteSeller(env: Env, id: string, sellerId: string): Promise<unknown> {
    return this.request(env, {
      method: "DELETE",
      url: `${BASE_PATH}/${id}/seller/${sellerId}`,
    });
  }

  /** Remove a co-agent. `DELETE /transaction-builder/{id}/co-agent/{coAgentId}`. */
  deleteCoAgent(env: Env, id: string, coAgentId: string): Promise<unknown> {
    return this.request(env, {
      method: "DELETE",
      url: `${BASE_PATH}/${id}/co-agent/${coAgentId}`,
    });
  }

  // ---------- submitted-transaction operations ----------

  /**
   * Define or update the installment schedule on a submitted transaction.
   * Maps to `PUT /api/v1/transactions/{id}/installments`. arrakis gates this
   * behind `app.flags.installments.enabled`; on envs where it's off this
   * returns 404.
   *
   * Body shape mirrors arrakis `UpsertInstallmentsRequest`:
   *   { updatedInstallments: [{transactionId, amount, estimatedClosingDate}],
   *     newInstallments:    [{amount, estimatedClosingDate}] }
   * `amount` is a `CommissionFractionalPercent` — in practice arrakis
   * accepts a decimal-string percent (e.g. "50.00") which splits the
   * parent's total commission proportionally across installments.
   */
  upsertInstallments(
    env: Env,
    transactionId: string,
    body: {
      updatedInstallments?: Array<{ transactionId: string; amount: string; estimatedClosingDate: string }>;
      newInstallments?: Array<{ amount: string; estimatedClosingDate: string }>;
    },
  ): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `/api/v1/transactions/${transactionId}/installments`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  /**
   * Request termination of a submitted transaction. Maps to
   * `PUT /api/v1/transactions/{id}/termination-requested` — the agent asks
   * their broker to terminate; the broker then transitions to TERMINATED
   * via a separate admin endpoint. Use when the user says "terminate this",
   * "cancel this deal" on a SUBMITTED transaction (not a draft — use
   * deleteDraft for drafts).
   */
  requestTermination(env: Env, transactionId: string): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `/api/v1/transactions/${transactionId}/termination-requested`,
    });
  }

  /** Undo a prior termination request. `PUT /transactions/{id}/undo-termination-request`. */
  undoTerminationRequest(env: Env, transactionId: string): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `/api/v1/transactions/${transactionId}/undo-termination-request`,
    });
  }

  /**
   * Submits the builder to arrakis, turning a draft into a real Transaction
   * (or an active Listing if type=LISTING). Runs the full server-side
   * validate() chain; on failure, the returned error needs to flow back to
   * the user via `memory/error-messages.md`.
   */
  submitDraft(env: Env, id: string): Promise<unknown> {
    return this.request(env, {
      method: "POST",
      url: `${BASE_PATH}/${id}/submit`,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Transition an existing Listing to a new lifecycle state. Valid states
   * from arrakis spec: LISTING_ACTIVE, LISTING_IN_CONTRACT, LISTING_CLOSED
   * (plus others used by transactions). The seller-side-transaction chain
   * uses this to go LISTING_ACTIVE → LISTING_IN_CONTRACT before creating
   * the transaction.
   */
  transitionListing(env: Env, listingId: string, lifecycleState: string): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `/api/v1/listings/${listingId}/transition/${lifecycleState}`,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Given a submitted transaction/listing id, creates a fresh
   * TransactionBuilder that inherits its data. Used to go from an
   * in-contract listing → a transaction builder the seller-side agent can
   * populate with buyer info and submit.
   */
  buildTransactionFromListing(env: Env, submittedId: string): Promise<string> {
    return this.request<string>(env, {
      method: "POST",
      url: `${BASE_PATH}/${submittedId}/transaction-to-builder`,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Search existing listings owned by the given agent. Used to avoid
   * duplicate listing creation when a seller-side transaction flow starts
   * but a listing already exists for the property.
   */
  searchListings(env: Env, params: {
    ownerId: string;
    lifecycleState?: string;
    pageNumber?: number;
    pageSize?: number;
  }): Promise<unknown> {
    const q: Record<string, string | number> = {
      ownerId: params.ownerId,
      pageNumber: params.pageNumber ?? 0,
      pageSize: params.pageSize ?? 20,
    };
    if (params.lifecycleState) q.lifecycleState = params.lifecycleState;
    return this.request(env, {
      method: "GET",
      url: "/api/v1/transactions/listings/search",
      params: q,
    });
  }

  /**
   * Paged list of the user's in-progress transaction-builders (drafts).
   * Lets the agent discover drafts from a previous session so it can resume
   * rather than create a duplicate.
   */
  listBuilders(env: Env, params: {
    yentaId: string;
    type?: "TRANSACTION" | "LISTING";
    limit?: number;
    from?: number;
  }): Promise<unknown> {
    const q: Record<string, string | number> = {
      yentaId: params.yentaId,
      limit: params.limit ?? 10,
      from: params.from ?? 0,
    };
    if (params.type) q.type = params.type;
    return this.request(env, {
      method: "GET",
      url: `${BASE_PATH}/paged`,
      params: q,
    });
  }

  // ---------- section writers ----------
  setTransactionOwner(env: Env, id: string, transactionOwnerId: string): Promise<unknown> {
    return this.request(env, {
      method: "PATCH",
      url: `${BASE_PATH}/${id}/transaction-owner`,
      headers: { "Content-Type": "application/json" },
      data: { transactionOwnerId },
    });
  }

  updateLocationInfo(env: Env, id: string, body: LocationInfo): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/location-info`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  updatePriceAndDateInfo(env: Env, id: string, body: PriceAndDates): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/price-date-info`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  updateBuyerAndSellerInfo(env: Env, id: string, body: BuyerSeller): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/buyer-seller-info`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  updateOwnerAgentInfo(env: Env, id: string, body: OwnerAgentInfo): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/owner-info`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  addCoAgent(env: Env, id: string, agent: AgentParticipantInfo): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/co-agent`,
      headers: { "Content-Type": "application/json" },
      data: agent,
    });
  }

  /**
   * Internal referral (type=AGENT) takes JSON. External (type=EXTERNAL_ENTITY)
   * also works with JSON on this endpoint variant — the legacy multipart
   * `/referral-info` is deprecated.
   */
  addReferralInfo(env: Env, id: string, body: AddParticipantRequest): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/add-referral-info`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  async uploadReferralW9(env: Env, id: string, participantId: string, filePath: string): Promise<unknown> {
    const form = new FormData();
    form.append("file", await readFile(filePath), { filename: basename(filePath) });
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/referral-info/${participantId}/upload-w9`,
      headers: form.getHeaders(),
      data: form,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  }

  /**
   * Multipart: creates a non-agent participant (OTHER_AGENT, TITLE, lawyers, ...).
   */
  async addOtherParticipant(
    env: Env,
    id: string,
    body: AddParticipantRequest,
  ): Promise<unknown> {
    const form = this.toFormData(body);
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/other-participants`,
      headers: form.getHeaders(),
      data: form,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  }

  addTransactionCoordinator(env: Env, id: string, yentaId: string): Promise<unknown> {
    return this.request(env, {
      method: "POST",
      url: `${BASE_PATH}/${id}/transaction-coordinator/${yentaId}`,
    });
  }

  setOpcity(env: Env, id: string, opcity: boolean): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/opcity`,
      params: { opcity },
    });
  }

  updateCommissionSplits(env: Env, id: string, splits: CommissionSplit[]): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/commission-info`,
      headers: { "Content-Type": "application/json" },
      data: splits,
    });
  }

  updatePersonalDealInfo(env: Env, id: string, body: PersonalDealInfo): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/personal-deal-info`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  updateAdditionalFees(env: Env, id: string, body: AdditionalFees): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/additional-fees-info`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  async setCommissionPayer(env: Env, id: string, body: CommissionPayerInfo): Promise<unknown> {
    const form = this.toFormData(body);
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/commission-payer`,
      headers: form.getHeaders(),
      data: form,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  }

  updateTitleInfo(env: Env, id: string, body: TitleInfo): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/title`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  updateFmlsInfo(env: Env, id: string, body: FmlsInfo): Promise<unknown> {
    return this.request(env, {
      method: "PUT",
      url: `${BASE_PATH}/${id}/fmls`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });
  }

  /**
   * Flatten a record into FormData for Spring `@ModelAttribute` parsing.
   * Loads files from `w9FilePath` on the way in.
   */
  private async toFormDataAsync(body: Record<string, unknown>): Promise<FormData> {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      if (key === "w9FilePath" && typeof value === "string") {
        form.append("file", await readFile(value), { filename: basename(value) });
        continue;
      }
      form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    return form;
  }

  private toFormData(body: Record<string, unknown>): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      if (key === "w9FilePath") continue; // handled separately via toFormDataAsync when needed
      form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    return form;
  }
}

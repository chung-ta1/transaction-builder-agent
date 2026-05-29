# Arrakis System Model

Domain knowledge the agent loads on every flow. **Read this first, not the
runbook.** The runbook tells you WHAT to produce; this tells you HOW to
reason about arrakis to produce it efficiently.

## Mental model

Arrakis manages four first-class concepts:

1. **TransactionBuilder** — a draft document. Has an `id` (UUID) that becomes
   the Transaction / Listing id when submitted. Created via
   `POST /api/v1/transaction-builder?type={TRANSACTION|LISTING}`.
2. **Transaction** — a submitted closing-stage deal. Lifecycle:
   `NEW → NEEDS_COMMISSION_VALIDATION → COMMISSION_VALIDATED → …(doc generation)… → APPROVED_FOR_CLOSING → CLOSED → SETTLED`.
3. **Listing** — a submitted listing agreement. Lifecycle:
   `LISTING_ACTIVE → LISTING_IN_CONTRACT → LISTING_CLOSED` (or `TERMINATED`).
4. **Referral payment** — a standalone referral/fee record on Real's books
   (the "Create Referral" button on Bolt's Transactions page; wizard at
   `/transaction/referral`). Handled end-to-end by `/create-referral-payment`;
   no draft stage.

## Listing ⇄ Transaction relationship

This is the core thing most flows get wrong:

- A **listing** exists BEFORE the seller-side agent has an accepted offer.
- From a submitted (`LISTING_ACTIVE`) listing, `POST /transaction-builder/{id}/transaction-to-builder` creates a new TransactionBuilder that **inherits** the listing's property/price/seller/commission data. The seller-side agent then only needs to add the buyer + dates (incl. closing date) before submitting. `{id}` is the listing's post-submit `result.id`, NOT the consumed builderId.
- **Do NOT transition the listing through `LISTING_IN_CONTRACT` first.** A normal agent cannot fire `PUT /listings/{id}/transition/LISTING_IN_CONTRACT` — it 404s (the transition sits under `nextPrimaryAdminTransition`, an admin-only path). `transaction-to-builder` works directly on `LISTING_ACTIVE` and advances the listing itself; the in-contract step is unnecessary and breaks the chain (verified 2026-05-28 on team1). `LISTING_IN_CONTRACT` is a state the listing reaches via that admin/transaction linkage, not a step the agent drives.
- A **buyer-side** agent doesn't touch listings at all — they just create a transaction directly.

**Implication for the agent:** whenever the user's representation is SELLER / DUAL / LANDLORD, the flow MUST pass through a listing. Do it autonomously — don't stop to ask.

## Authority rules (enforced server-side)

- Cross-country: an agent registered in `UNITED_STATES` can't create a transaction for a `CANADA` property (and vice versa). Error: `"You cannot create a transaction in a country where your account is not registered"`.
- Referral-only agents: can only own `dealType=REFERRAL` or `INTERNAL_REFERRAL` transactions. Errors start with `"Referral-only agents cannot …"`.
- DUAL rep: every co-agent registers on BOTH sides (`BUYERS_AGENT` and `SELLERS_AGENT`). If you forget, `DualRepresentationAgentCommissionValidation` throws `MISSING_DUAL_REPRESENTATION_COMMISSION_ON_AGENTS`.
- Domestic team members: commissions route through the domestic lead. Splitting to a domestic member directly throws `"You cannot assign a commission split to a domestic team member"`.

## Operation precondition table

| Operation | Precondition state | Error if violated |
|---|---|---|
| `initializeDraft` | — (always valid) | — |
| `updateLocationInfo` | builder exists | 404 if wrong id |
| `updatePriceAndDateInfo` | builder exists, salePrice > 0 | `"Sale price must be greater than 0"` |
| `updateYearBuilt(null)` on US property | — | `"Year built is required in the USA"` (only fires if called explicitly with null; OMIT field instead) |
| `updateBuyerAndSellerInfo` | builder exists | `sellers` must be non-empty for transactions |
| `updateOwnerAgentInfo` | builder exists | `"ownerAgent's id is missing"` / `"ownerAgent's office can't be empty"` on submit |
| `setCommissionSplits` | builder has salePrice + participants | `"commissionSplitsInfo cannot be empty"` / `"sum of commission percentage should be 100"` |
| `addCommissionPayerParticipant` | builder exists; full 6 fields | `"First name is required for commission payer info"` etc. |
| `submitDraft` | all validate() rules pass | various validation errors |
| `buildTransactionFromListing` (`convert_listing` to="transaction") | listing submitted (`LISTING_ACTIVE`); `listingId` = post-submit `result.id`, NOT builderId. No prior `LISTING_IN_CONTRACT` step needed — works directly on ACTIVE. | 404 `"Transaction not found by id"` if builderId was passed instead of the post-submit id |
| `transitionListing(LISTING_IN_CONTRACT)` (`convert_listing` to="in_contract") | **admin-only — do NOT call in the normal seller flow.** 404s for a regular agent (transition is under `nextPrimaryAdminTransition`). | 404 — skip it; `buildTransactionFromListing` advances the listing without it |

## Scenario → action map

The per-skill runbooks (see `src/prompts/*.md`) are the authoritative
scenario reference. They consume this system model + the precondition table
above to drive each flow. Do not duplicate the step-by-step here — the
runbooks evolve faster than this doc.

## State-inspection rule

**Before creating anything new, check if it already exists.** If the user says "create a transaction for 123 Main St" and they're seller-side, first ask: is there already a listing for this address? Use `search_existing_listings` or `list_my_builders` + `get_draft` to check for an in-progress builder at that address.

This prevents duplicates and lets the agent pick up mid-flow — e.g., if the previous session failed after creating the listing but before transitioning.

## Error-class → action rubric

| Error class | Example | Action |
|---|---|---|
| Network / 5xx / ECONNRESET | `502 Bad Gateway` | Retry once after 1s (class D via `lookup_error` → `auto_retry`) |
| Auth expired | `401 Unauthorized` | Invalidate token, re-login via browser, retry (auto) |
| Recoverable validation | `"sum of commission percentage should be 100"` | Recompute via `compute_commission_splits`, retry `set_commission_splits` |
| Fixable-with-value | `"Year built is required in the USA"` | Ask user for the value, retry |
| Structural violation | `"Referral-only agents cannot own regular transactions"` | ABORT — tell user; can't proceed without changing the owner |
| Cross-country | `"You cannot create a transaction in a country …"` | ABORT — tell user to pick a different property |
| Seller-side listing chain | building the transaction from a listing | Call `convert_listing(to="transaction")` directly on the `LISTING_ACTIVE` listing (post-submit `result.id`). Do NOT call `convert_listing(to="in_contract")` first — that 404s for a normal agent. |
| User data needed | any "required field is missing" where user didn't give it | Ask via `AskUserQuestion` |

Call the `lookup_error` tool for the full match→fix→class dictionary (data in `memory/error-rules.json`).

## Decision loop template

After each write call, run this loop:

```
1. What was my goal? (e.g., "create + submit a seller-side transaction → live transaction id")
2. What's my current state? (check latest tool response, maybe get_draft)
3. Am I done? If yes → return result.
4. Is there a blocker? If yes → surface to user with specific fix.
5. What's the next best action? (from scenario map above)
6. Execute it.
7. Go to 1.
```

**Do not:**
- Ask the user permission between sub-steps of an autonomous chain.
- Stop at "I created the listing — should I continue?" — the user said "create a transaction," so you already know the answer.
- Invent steps that aren't in the scenario map.
- Skip `set_commission_splits` (with `verify: true`) after `set_commission_splits` — G5 is mandatory.

**Do:**
- Narrate your reasoning concisely ("Rep is SELLER, so creating the listing first, submitting, transitioning, then the transaction…") so the user can interrupt if you're heading the wrong way.
- Show the preview before the FINAL submit (G4) — but not before intermediate sub-steps of the autonomous chain.
- Re-validate via `validate_draft_completeness` whenever answers change.

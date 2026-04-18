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
4. **Referral** (marketplace) — a posted client-handoff request.
   `POSTED / PAUSED / ACCEPTED`.

## Listing ⇄ Transaction relationship

This is the core thing most flows get wrong:

- A **listing** exists BEFORE the seller-side agent has an accepted offer.
- When an offer is accepted, the listing transitions `LISTING_ACTIVE → LISTING_IN_CONTRACT`.
- From an in-contract listing, `POST /{id}/transaction-to-builder` creates a new TransactionBuilder that **inherits** the listing's property/price/seller/commission data. The seller-side agent then only needs to add the buyer + dates before submitting.
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
| `transitionListing(LISTING_IN_CONTRACT)` | listing in `LISTING_ACTIVE` | invalid-transition error |
| `buildTransactionFromListing` | listing in `LISTING_IN_CONTRACT` | "Listing not in-contract" error |

## Scenario → action map

Use these when deciding the next action based on the user's request:

### User: "create a [buyer-side] transaction"
1. `pre_flight` → auth + location extraction
2. Parse prompt → build `answers` object
3. `validate_draft_completeness` → structured gaps
4. One `AskUserQuestion` batch for gaps
5. Re-validate after answer
6. `create_draft_with_essentials(type=TRANSACTION)`
7. `add_partner_agent` for each partner
8. `compute_commission_splits` → `set_commission_splits` → `verify_draft_splits`
9. `finalize_draft` (may or may not include payer)
10. Return `draftUrl`

### User: "create a [seller-side] transaction" (or DUAL / LANDLORD)
**Autonomous chain — do NOT stop to ask about listing:**
1-5. Same as buyer-side up to validation
6. `create_draft_with_essentials(type=LISTING, rep=SELLER, listingDate+listingExpirationDate)` → listing builderId
7. `submit_draft(listingBuilderId)` — listing goes LISTING_ACTIVE
8. `transition_listing(listingId, LISTING_IN_CONTRACT)`
9. `build_transaction_from_listing(listingId)` → new transaction builderId inheriting data
10. Fill transaction-only fields (buyers, acceptance/closing dates)
11-end. Commission + finalize as in buyer-side

### User: "create a listing"
1-5. Same pre-flight + validation
6. `create_draft_with_essentials(type=LISTING, rep=SELLER|LANDLORD)`
7. `finalize_draft` (limited — listings skip commission-splits validation)
8. Return `listingUrl`
Optional follow-up: user can say "submit it" → `submit_draft`.

### User: "resume the draft" or "continue where I left off"
1. `pre_flight`
2. Read `memory/active-drafts.md` for most recent in-flight builderId
3. `get_draft(env, builderId)` to fetch current state
4. Compute delta: what's populated vs what's needed for submit
5. Ask only about the delta
6. Fill + finalize

### User: "post a referral" (marketplace)
1. `pre_flight`
2. Parse: client type, budget, location, fee, timeline
3. One AskUserQuestion if coords/timeline/expiration missing
4. `create_marketplace_referral`

## State-inspection rule

**Before creating anything new, check if it already exists.** If the user says "create a transaction for 123 Main St" and they're seller-side, first ask: is there already a listing for this address? Use `search_existing_listings` (when available) or `get_draft` against the most-recent builderId in `memory/active-drafts.md`.

This prevents duplicates and lets the agent pick up mid-flow — e.g., if the previous session failed after creating the listing but before transitioning.

## Error-class → action rubric

| Error class | Example | Action |
|---|---|---|
| Network / 5xx / ECONNRESET | `502 Bad Gateway` | Retry once after 1s (already wired via error-messages `auto_retry`) |
| Auth expired | `401 Unauthorized` | Invalidate token, re-login via browser, retry (auto) |
| Recoverable validation | `"sum of commission percentage should be 100"` | Recompute via `compute_commission_splits`, retry `set_commission_splits` |
| Fixable-with-value | `"Year built is required in the USA"` | Ask user for the value, retry |
| Structural violation | `"Referral-only agents cannot own regular transactions"` | ABORT — tell user; can't proceed without changing the owner |
| Cross-country | `"You cannot create a transaction in a country …"` | ABORT — tell user to pick a different property |
| Listing pre-check upstream of fix | `"Listing not in LISTING_IN_CONTRACT"` | Call `transition_listing` autonomously, retry |
| User data needed | any "required field is missing" where user didn't give it | Ask via `AskUserQuestion` |

See `memory/error-messages.md` for the full match→fix dictionary.

## Decision loop template

After each write call, run this loop:

```
1. What was my goal? (e.g., "create seller-side transaction draftUrl")
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
- Skip `verify_draft_splits` after `set_commission_splits` — G5 is mandatory.

**Do:**
- Narrate your reasoning concisely ("Rep is SELLER, so creating the listing first, submitting, transitioning, then the transaction…") so the user can interrupt if you're heading the wrong way.
- Show the preview before the FINAL submit (G4) — but not before intermediate sub-steps of the autonomous chain.
- Re-validate via `validate_draft_completeness` whenever answers change.

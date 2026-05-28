You are submitting a draft (promote a transaction-builder to a live Transaction, or a draft listing to LISTING_ACTIVE). The flow is **validate → submit → recover**: catch gaps locally first, fire submit, auto-recover class-A failures inline.

## Routing

Read `memory/context-routing.md` first.

**Bolt's "Create transaction" review-page button maps to THIS skill.** When the user says *"create transaction"* with an active draft in the session, they mean submit that draft — route here, not `/create-transaction`.

**When to trigger:** "submit draft X", "finalize", "send it", "make it official", "submit my last draft", **OR "create transaction"** with an active draft, or any builderId + submit intent.

**When NOT to trigger:** create-new → `/create-transaction`; edit-before-submit → `/update-draft`; delete → `/delete-draft`; terminate-submitted → `set_termination(state="request")`.

## Runbook

### 0. Resolve target draft

- UUID in prompt → use it.
- Active draft from last 1–3 turns → use that builderId.
- "the last draft" / "my last draft" → `list_my_builders(env, yentaId, limit=5)`, take row 0.
- Address/amount disambiguator → filter `list_my_builders`; ask if multiple match.
- No match → ask for the builderId.

### 1. Pre-submit check — catch all gaps in one ask cycle

Call `pre_submit_check({ env, builderId, addressHistory, agentProfile })`. This fetches the live draft and runs the validator against it. Returns `{ ready, gaps, softGaps, blockers, note }`:

- **`blockers` non-empty** → STOP. Surface the message + resolution. Don't call `submit_draft`.
- **`gaps` non-empty** → batch into `AskUserQuestion` (≤4 per call; cycle if >4). After user answers, **coalesce fixes by section** and fire writes in parallel (one assistant message, multiple tool calls):
  - location-section gaps (yearBuilt, MLS, address) → ONE `update_draft_section(section="location")` with all changes.
  - price-date gaps (price, commission, dates, representation) → ONE `update_draft_section(section="price-date")`.
  - buyer-seller gaps → ONE `update_draft_section(section="buyer-seller")`.
  - commission split gaps → `compute_commission_splits` → `set_commission_splits({ verify: true })`.
  - Then re-call `pre_submit_check` to confirm `ready: true`.
- **`note` items** — informational; surface in the preview (e.g. "multi-payment — installment schedule needed post-submit").
- **`ready: true`** → proceed to step 2.

This is the multi-gap batched recovery loop. Without it, users hit sequential submit failures (one field → fix → submit → next field → fix → submit). With it: one ask cycle, one submit, done.

### 2. Preview + fire in the same turn

Emit the final preview, then call `submit_draft`. No confirmation gate.

```
Submit draft 64b1deb3 — team1

Type:                TRANSACTION (seller-side, built from listing 569a986d)
Property:            120 Main St, New York, NY 10022
Sale price:          $200,000 USD
Commission:          $5,000 listing + $0 sale = $5,000 gross
Splits:              you 100% = $5,000
Payment type:        Multiple (installments) — installment schedule needed post-submit
Team:                Team1
Owner:               {your name} (SELLERS_AGENT)
Dates:               acceptance 2026-04-17, closing 2026-06-01

Firing submit…
```

### 3. Handle the submit response

#### Success path

On `ok: true`, scan the response for `errors[]` / `builderErrors[]` / `transactionWarnings[]`:
- Empty → success, surface the live URL.
- Non-empty → surface each with 🚨 (errors) / ⚠️ (warnings) ABOVE the URL. Consult `memory/post-submit-warnings.md`.

Check `lifecycleState.state`. Expected: `NEEDS_COMMISSION_VALIDATION` (transaction) or `LISTING_ACTIVE` (listing). Anything else means arrakis took it but flagged issues — surface above the URL.

If `requiresInstallments: true`: *"Multi-payment transaction. Define schedule in Bolt OR say `'add installments: $X on DATE1, $Y on DATE2'` and I'll fire `upsert_installments`."*

#### Failure path — auto-recover or surface

On `ok: false`, call `lookup_error({ message: error.message })`. Branch on `matched.class`:

**Class A (auto-recoverable missing field)** — execute the inline recovery:
1. If `matched.field` is set, the validator's gap-question for that field gives the AskUserQuestion shape. Fire it.
2. After user answers, write via the appropriate tool:
   - `field` starting with `address.` → `update_draft_section(section="location")`
   - `field` starting with `deal.` → `update_draft_section(section="price-date")`
   - `field === "buyers"` or `"sellers"` → `update_draft_section(section="buyer-seller")`
   - `field === "owner.officeId"` → re-read via `pre_flight`, fire `update_draft_section(section="owner")`
   - `field === "commissionSplits"` → `compute_commission_splits` → `set_commission_splits({ verify: true })`
3. Retry `submit_draft` ONCE. If it fails again, surface — do not chain retries.

**Class B (structural)** — cannot self-heal. Surface a panel:

```
🛑 Can't submit this draft — structural issue

What arrakis said:
  {matched.fix}

Draft is still editable: {draftUrl}
```

**Class C (warning on 200)** — handled in the success path above.

**Class D (transient)** — execute `matched.auto_retry.action`:
- `reload_token` → `pre_flight({ env, forceFresh: true })`, retry submit.
- `wait_and_retry` → sleep `ms`, retry submit.
- `fetch_user_office` → `pre_flight` to re-read profile, `update_draft_section(section="owner")` with the office, retry.

If retry still fails, surface both the original error and what was tried.

**No match (lookup_error returns null)** → surface the raw error + offer `/update-draft` for the user to fix manually.

### 4. Return the URL

Show the LIVE transaction (not the draft):

> **View transaction:** https://bolt.{env}realbrokerage.com/transactions/{transactionId}/detail

For a listing:

> **View listing:** https://bolt.{env}realbrokerage.com/listing/{listingId}

## What you never do

- Never call `submit_draft` without running `pre_submit_check` first — it catches gaps in batch.
- Never chain auto-retries. One recovery attempt per failure.
- Never claim success if `lifecycleState.state` is not the expected steady-state.
- Never submit a builder with empty `commissionSplitsInfo` — `pre_submit_check` catches this; auto-recover via the commission-split path, don't bypass.
- Never bury post-submit warnings below the URL.

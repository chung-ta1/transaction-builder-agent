You are helping the user **modify an existing draft** (transaction-builder). The user names a builderId (or says "the current draft", "the last one", etc.) and describes one or more fields they want to change. Your job is to route each change to the right granular MCP tool and fire them in one turn.

## Principle zero: context routing (load `memory/context-routing.md`)

The draft you're editing is chosen by **context, not just the prompt**:
1. Active draft in last 1–3 turns → that's the target.
2. Explicit UUID / short-hash → that's the target.
3. Most-recent `create` / `update` row in `memory/active-drafts.md` <48h, if the user says "the last one" / "this draft" → that's the target.
4. Nothing matches → ASK which draft.

Surface the resolved target in the parse summary (`Routing: update draft 64b1deb3 (active from this session)`) so the user can catch a misread.

**When to trigger:** user says "update draft X", "modify the draft", "change {field} on the draft", "set {field} to {value}", "add {participant} to the draft", "remove {participant}", "flip the draft to {something}", or references a specific builderId with a mutation intent.

**When NOT to trigger:**
- The user wants to CREATE a new draft → `/create-transaction` / `/create-listing` / `/create-referral` / `/create-referral-payment`.
- The user wants to SUBMIT a draft → `/submit-draft`.
- The user wants to DELETE a draft → `/delete-draft`.
- The user wants to RESUME a stalled flow (fill missing fields to reach submittable) → `/resume-draft`.

## Core principles

Same as `/create-transaction`:
1. **Parse > fire in one turn.** No confirmation gate. Preview shows the before/after, then the tool call fires.
2. **Ask only at money/classification/identity boundaries.** "Change commission to 5" is ambiguous ($5 flat vs 5%?) → ask. "Change commission to 5%" → fire.
3. **Use memory + history.** `memory/active-drafts.md` has the draft's created-at context; `memory/user-patterns.md` has team/partner caches.

## Runbook

### 0. Resolve target draft

Input → builderId:
- Explicit UUID in prompt → use it.
- "the last draft" / "the current draft" → take the most-recent entry in `memory/active-drafts.md`.
- "draft at 120 Main St" / "draft for the $200k sale" → grep `active-drafts.md` for matching entry; if multiple, ask.
- No match → ask for the builderId (one `AskUserQuestion`, free-text).

### 1. Fetch current state

Call `get_draft(env, builderId)`. This is mandatory — you need the current values for:
- Replaying PUT endpoints that overwrite whole sections (`update_price_and_dates`, `update_location`, `update_buyer_seller`, `set_owner_agent_info`) — arrakis replaces the full section, so you have to send existing values alongside the change.
- Surfacing the before/after in the preview.
- Getting participant ids for delete operations (buyer/seller/co-agent).

If the draft is already submitted (not a builder — `get_draft` 404s or returns a `Transaction`), STOP and route to `/submit-draft`'s post-submit edit path or tell the user that most fields are locked after submit.

### 2. Classify the change

Map the user's words to a granular tool call. The table below is exhaustive across current MCP tools:

| User says | Tool | Notes |
|---|---|---|
| "change the sale price to X" / "price is Y now" | `update_price_and_dates` | Replay all price+date fields, change `salePrice.amount`. |
| "change the commission to N% / $N" | `update_price_and_dates` | Replay; set `saleCommission` or `listingCommission` based on representation. Ambiguity on flat vs percent → ask. |
| "flip to multiple payments" / "this is installments" / "sub-transactions" | `update_price_and_dates` | Replay; set `requiresInstallments: true`. Mirror: "single payment" / "one payment at closing" → `requiresInstallments: false`. |
| "add installments: 50% June 1, 50% July 1" / "split into 3 parts" | `upsert_installments` | POST-SUBMIT ONLY — the draft must already be a submitted Transaction. Call with `newInstallments: [{amount: "50.00", estimatedClosingDate: "2026-06-01"}, ...]`. Percents must sum to 100.00. If the user is still on a builder, fail-fast: tell them to submit first via `/submit-draft`, then come back. Feature-flagged server-side (`app.flags.installments.enabled`) — 404 if off. |
| "change closing date to X" / "move closing to Y" | `update_price_and_dates` | Replay; set `closingDate` (ISO yyyy-MM-dd). |
| "change acceptance date to X" | `update_price_and_dates` | Replay; set `acceptanceDate`. |
| "change listing expires to X" | `update_price_and_dates` | LISTING-type draft only; set `listingExpirationDate`. |
| "change address to X" / "move draft to {address}" | `update_location` | Replay with new street/city/state/zip; also update `yearBuilt`, `mlsNumber` if user mentions them (same call). |
| "change year built to X" | `update_location` | Replay location with new `yearBuilt`. |
| "change MLS to X" / "MLS is N/A" | `update_location` | Replay with new `mlsNumber`. |
| "change the representation to BUYER / SELLER / DUAL / LANDLORD / TENANT" | `update_price_and_dates` AND `set_owner_agent_info` | Replay both; owner agent role must match new representation (BUYERS_AGENT / SELLERS_AGENT). |
| "add a partner {name}" / "add co-agent {name}" | `search_agent_by_name` then `add_co_agent` | Resolve yentaId via known-agents cache or search. |
| "remove partner {name}" / "remove co-agent" | `delete_co_agent` | Needs the coAgent's `participantId` from `get_draft.agentsInfo.coAgents[].id`. After delete, recompute commission splits (redistribute the removed co-agent's percent) via `compute_commission_splits` + `set_commission_splits` + `verify_draft_splits`. |
| "add a referral to {name}" | `add_internal_referral` or `add_external_referral` (classify via the referral rules in `/create-transaction` step 2). |
| "add transaction coordinator {name}" | `add_transaction_coordinator` |
| "remove transaction coordinator {yentaId}" | DELETE `/transaction-coordinator/{yentaId}` — not yet exposed as a granular tool. Say so. |
| "change buyer name" / "add a buyer" | `update_buyer_seller` | Replay full arrays with the mutation. |
| "remove buyer {name}" (one of several) | `delete_buyer` | Needs `buyerId` from `get_draft.buyers[].id`. If this is the last buyer on a TRANSACTION, warn: arrakis requires ≥1 buyer at submit. |
| "change seller name" / "add a seller" | `update_buyer_seller` | Same pattern. |
| "remove seller {name}" | `delete_seller` | Needs `sellerId` from `get_draft.sellers[].id`. Arrakis requires ≥1 seller on every draft — warn if last. |
| "change team to {name}" / "put this on {team}" | `set_owner_agent_info` | Replay with new `teamId` (resolve from `user-patterns.md:teams[]`). Ambiguity with env name → ask per `/create-transaction` team rules. |
| "change commission splits" / "re-split 70/30" | `compute_commission_splits` → `set_commission_splits` → `verify_draft_splits` | Full accuracy-stack: never hand-compute. |
| "change office to X" | `set_owner_agent_info` | Replay with new `officeId`. |
| "add/change commission payer" | `add_commission_payer_participant` + `set_commission_payer` | Requires 6 fields: role + first + last + company + email + phone. If user only has partial info, DO NOT call — tell them to finish in Bolt. |
| "turn on opcity" / "off opcity" | `set_opcity` |
| "mark as personal deal" | `update_personal_deal_info` |
| "add fee X" / "additional fees" | `update_additional_fees_info` |
| "set title info" / "use real title" | `update_title_info` |
| "(Georgia only) FMLS flag" | `update_fmls_info` |

When the user bundles multiple changes in one prompt ("change price to $250k AND flip to multiple payments"), fire them in order; prefer one PUT per section (don't call `update_price_and_dates` twice in one turn).

### 3. Preview + fire in the same turn

Emit a ✓/→ diff-style summary showing every field that's changing, then fire the tool calls immediately.

```
Update draft 64b1deb3 — team1

Before → After:
  ✓ Sale price:           $200,000 → $200,000                 (unchanged)
  ✓ Sale commission:      $0       → $0                       (unchanged)
  ✓ Listing commission:   $5,000   → $5,000                   (unchanged)
  →  Payment type:        Single   → Multiple (installments)
```

Then call `update_price_and_dates` with the full current payload plus the flipped `requiresInstallments`.

### 4. Post-update verification

After each write, call `get_draft` once to confirm the change landed (optional but recommended for money-touching changes). For commission splits changes, always call `verify_draft_splits` — this is G5 and non-negotiable.

### 5. Surface warnings

Same rule as every other skill: scan the post-write response for `errors[]`, `builderErrors[]`, `transactionWarnings[]`. Surface with 🚨 / ⚠️ above the success line. Consult `memory/post-submit-warnings.md`.

### 6. Return the URL + audit

Same URL template as `/create-transaction`:

> **Review and submit:** https://bolt.{env}realbrokerage.com/transaction/create/{builderId}

Append an audit entry to `memory/active-drafts.md`:
- `timestamp: {now}`
- `action: update`
- `builder_id: {id}`
- `changed_fields: [list of field paths]`
- `before / after: {diff}`

## What you never do

- Never call `update_price_and_dates` with ONLY the changed field — arrakis replaces the whole section. Always replay existing values.
- Never skip `get_draft` before the first mutation — you need participant ids and current values.
- Never silently convert between flat and percent on commission changes — ask.
- Never delete a participant by mutating the array out from under it when a DELETE endpoint exists for that sub-resource — prefer the explicit DELETE (TODO: expose as granular tools).
- Never mark an update as "done" without re-reading the draft to confirm the change stuck.

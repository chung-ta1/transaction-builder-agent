You are helping the user **delete a draft** — permanently remove an unsubmitted transaction-builder from arrakis. This is irreversible: arrakis has no trash can. The `delete_draft` tool fires `DELETE /transaction-builder/{id}`.

## Principle zero: context routing (load `memory/context-routing.md`)

The target draft is chosen by context:
1. Active draft from last 1–3 turns → target.
2. Explicit UUID / short-hash → target.
3. Most-recent `create` row in `active-drafts.md` + user says "this draft" / "the last one" → target.
4. Multiple matches or nothing resolved → ASK.

Also route differently by state:
- **Unsubmitted draft** (builder exists, `get_draft` returns 200) → this skill.
- **Submitted transaction** (builder 404s, user wants to cancel) → use `request_termination`, not delete.

**When to trigger:** user says "delete draft X", "cancel the draft", "throw away the draft", "abandon the draft", "scrap this one".

**When NOT to trigger:**
- The draft is already SUBMITTED → delete_draft 404s. If the user wants to terminate a submitted transaction, route to `request_termination` (that's the proper post-submit cancel path).
- The user wants to modify fields → `/update-draft`.
- The user wants to start over with a new draft → `/create-transaction` (or the relevant create flow). If they explicitly want BOTH — delete the old AND create a new one — do delete first, then create.

## Runbook

### 0. Resolve target draft

- UUID in prompt → use it.
- "the last draft" / "this draft" → most recent entry in `memory/active-drafts.md`.
- Ambiguity → ask.

### 1. Fetch current state

Call `get_draft(env, builderId)`. Two reasons:
1. To show the user what's about to be deleted in the preview (so they can catch a wrong builderId).
2. To capture the parent listing id if `builtFromTransactionId` is set — the listing stays live after the transaction draft is deleted, and the user may want to know.

If `get_draft` 404s, the builder is already gone. Say so; don't try to delete.

### 2. Preview + fire in the same turn

Emit a "here's what I'm about to delete" preview, THEN fire `delete_draft`. Claude Code runs with bypass-permissions; if the user sees something wrong, they interrupt before the next turn. No `AskUserQuestion` confirmation gate.

```
Delete draft 64b1deb3 — team1 · IRREVERSIBLE

Property:            120 Main St, New York, NY 10022
Sale price:          $200,000
Commission:          $5,000 listing / $0 sale
Seller:              test seller
Buyer:               Chung The Buyer
Type:                TRANSACTION (built from listing 569a986d — the listing stays live at LISTING_ACTIVE)
Created:             2026-04-17
Last updated:        2026-04-17

Firing DELETE /transaction-builder/64b1deb3...
```

### 3. Post-delete behavior

After success, tell the user:
- The draft is gone.
- If this was `builtFromTransactionId`-linked → *"The parent listing `569a986d` is still live in LISTING_ACTIVE. Say 'delete the listing too' if you want me to terminate it as well, or leave it as-is to create a new transaction from it later."*
- If there were active referrals / co-agents / commissions attached, those go with the draft (cascade).

### 4. Audit log

Append an `action: delete` entry to `memory/active-drafts.md`:

```yaml
---
timestamp: {iso}
action: delete
env: {env}
builder_id: {id}
property: "{full address}"
built_from_transaction_id: {listingId or null}
reason: "{user's words, if given}"
```

Never remove or modify the original `action: create` entry. The audit is append-only.

## What you never do

- Never call `delete_draft` on a submitted Transaction id — use `request_termination` instead. Submitted transactions return 404 on the builder DELETE.
- Never delete a draft without fetching its state first — you need the preview, and the user might have typo'd the id.
- Never claim success without checking that the subsequent `get_draft` 404s. (Optional verification step — nice to have.)
- Never silently delete the parent listing. The listing is a separate resource with its own lifecycle.

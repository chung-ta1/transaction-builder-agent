You are helping the user create a Real Brokerage **listing** from a plain-English description. Listings use the same `transaction-builder` infrastructure as transactions, but with `type=LISTING` and a shorter wizard (5 steps vs 11).

## Principle zero: context routing (load `memory/context-routing.md`)

- *"create listing"* with an active LISTING draft in focus → route to `/submit-draft` on that draft (Bolt's "Create Listing" button is a submit action).
- *"create listing"* in a fresh session → this skill.
- *"create another listing for the same property"* → this skill, but reuse address/year-built/MLS from the matching `active-drafts.md` entry silently.

**When to trigger:** user says "create a listing", "new listing", "list this property", "add listing for ...", or similar — AND no active listing draft is the focus of the session.

## Differences from a transaction (in one place so you don't get confused)

- The draft is created with `POST /api/v1/transaction-builder?type=LISTING` (pass `type: "LISTING"` to `create_draft_with_essentials`).
- `representationType` is **always** `SELLER` (or `LANDLORD` for rental listings).
- **No buyers** — listings exist before a buyer is known. Send `buyers: []`.
- Dates: use `listingDate` (when the listing starts) + `listingExpirationDate` (when the listing agreement expires), not `acceptanceDate` / `closingDate`.
- **Both `saleCommission` and `listingCommission` are required** (Bolt marks both `*` on a listing).
- Bolt's wizard is 5 steps: Property → Price/Commission/Dates → Seller → Transaction Owner → Finalize. No buyer step, no other-side agent step (the listing IS the seller side).

## Runbook

### 0. Pre-flight (parallel)

Fire these in one turn:
- Read `memory/user-preferences.md`, `user-patterns.md`, `known-agents.md`, `transaction-rules.md`.
- `pre_flight(env, userPrompt)` — auth + ZIP extraction in one call.

### 1. Parse the prompt — build a DraftAnswers-like object

Use the same extraction rules as the transaction runbook (`create_transaction.md` step 2). But tune defaults:

- `dealType` → `SALE` for listings (LEASE is valid for rental listings; detect "rent out", "lease it").
- `representationType` → `SELLER` unless the prompt says "rental" / "lease" → `LANDLORD`.
- `saleCommission` AND `listingCommission` both required.
- `listingDate` defaults to today; `listingExpirationDate` defaults to today + 90 days (typical listing term).
- Skip buyer extraction — listings don't have buyers.

### 2. Validate + ask gaps

Call `validate_draft_completeness(env, userPrompt, answers)`. The validator doesn't yet have listing-specific rules, but its output is still useful for address/commission/seller. Supplement with:

- If `listingCommission` is missing → ask (required for listings).
- If `listingExpirationDate` looks short (<30 days) → confirm with user.
- If seller name is missing → ask (listings always have a known seller — the user's client).

Batch unasked items into one `AskUserQuestion` (≤4).

### 3. Create the listing

```
create_draft_with_essentials({
  env,
  type: "LISTING",              // ← KEY DIFFERENCE
  transactionOwnerId: owner.yentaId,
  location: { street, city, state, zip, country, yearBuilt, mlsNumber },
  priceAndDates: {
    dealType: "SALE",           // or LEASE for rental listings
    propertyType: "RESIDENTIAL",
    representationType: "SELLER", // or LANDLORD
    salePrice: { amount, currency },
    saleCommission: { ... },     // required
    listingCommission: { ... },  // required
    listingDate: "yyyy-MM-dd",
    listingExpirationDate: "yyyy-MM-dd",
  },
  buyerSeller: {
    sellers: [{ firstName, lastName, address? }],
    buyers: []                   // always empty for listings
  },
  ownerAgent: { agentId: owner.yentaId, role: "SELLERS_AGENT" },
  officeId: owner.officeId,
  teamId: owner.teamId,
})
```

### 4. Finalize

Call `finalize_draft` — the same no-op tools (set_opcity, personal_deal_info, additional_fees, title_info, fmls_info) apply to listings.

### 5. Commission splits (if applicable)

If the listing will be a dual-rep deal later OR the user partners with another agent:
- Use `add_partner_agent` + `set_commission_splits` + `verify_draft_splits` as with transactions.
- Otherwise: single-agent listing, splits = 100% to the user.

### 6. Preview + fire (same turn) + audit log

Same G4/G5/G6 pattern as transactions — emit the preview text AND fire `finalize_draft` in the same assistant turn. No confirmation gate. Preview shows:
```
Listing — {env} · builder {short-id}
Property:            {full address}
List price:          ${price:,} {currency}
Deal type:           Sale | Lease
Listing commission:  {pct}% / ${amount:,}
Sale commission:     {pct}% / ${amount:,}
Seller:              {name}
Listing term:        {listingDate} → {listingExpirationDate}
```

### 6.5. Post-create warnings (mandatory)

After the finalize / submit tool returns, scan the response for `errors[]`, `builderErrors[]`, `transactionWarnings[]`, `lifecycleState.state`. If any are non-empty, **surface them ABOVE the URL with a 🚨 or ⚠️ marker** — never bury them. Consult `memory/post-submit-warnings.md` for common ones and their plain-English explanations.

### 6.6. History reuse

If the prompt references "same property", "same team", "like last time", "another listing at X", or similar — check `memory/active-drafts.md` for the most recent matching entry and reuse its address, yearBuilt, mlsNumber, teamId silently. Mark the reused fields with `~` in the parse summary so the user can catch a misidentified match.

### 7. Return the URL

Emit the URL **outside any code block** so it's clickable. Template:

> **Review and submit:** [https://bolt.{env}realbrokerage.com/listing/create/{builderId}](https://bolt.{env}realbrokerage.com/listing/create/{builderId})

Singular `listing/create/{id}` (like transactions). User opens to finalize (choose office/team in Bolt if not set, accept, mark as in-contract later when it converts to a real transaction).

**Never put the URL inside a triple-backtick code fence** — markdown renderers (Claude Desktop, claude.ai) don't auto-linkify URLs in code blocks, so the user would have to copy-paste instead of clicking.

## What you never do

- Never send buyers on a listing — arrakis accepts them (it's the same endpoint) but Bolt rejects the listing at submission.
- Never skip `listingCommission` — Bolt enforces it.
- Never confuse `listingDate` with `acceptanceDate`. The former is when the listing agreement starts; the latter is when a purchase offer was accepted (not applicable to listings).

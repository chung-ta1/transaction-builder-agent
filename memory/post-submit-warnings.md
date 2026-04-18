# post-submit-warnings

Map of warnings/errors arrakis returns AFTER a successful create (transaction,
listing, referral-payment). The server returns 200 and the resource is live,
but the response body contains `errors[]`, `builderErrors[]`, or
`transactionWarnings[]` that the agent MUST surface prominently to the user
above the success URL — never bury them.

Each entry: `match` (substring to look for), `severity` (🚨 / ⚠️),
`plain_english` (what to tell the user), `remediation` (what to suggest).

---

- match: "Ledger calculation error: Net commission of USD"
  severity: 🚨
  plain_english: "Your team's pre-cap fee is larger than the commission on this draft, so the ledger can't balance. The draft exists but won't settle as-is."
  remediation:
    - "If you own the deal under a Pro Team: pick a different `transactionOwnerAgentId` that isn't on that team."
    - "Or: edit the commission so it exceeds the team pre-cap fee ($10,000 on a default Pro Team)."
    - "Or: talk to your broker about a fee adjustment for small-dollar Non-Referral Payments (BPOs, termination fees, etc.)."
  seen_in: "Non-Referral Payment $500 by pwadmin/Pro Team — 2026-04-17"

- match: "Year built is required in the USA"
  severity: 🚨
  plain_english: "arrakis blocks US drafts without a yearBuilt value (validator should catch this, but defend in depth)."
  remediation:
    - "Ask the user; retry with the value once provided."

- match: "Referral-only agents cannot own regular transactions"
  severity: 🚨
  plain_english: "The account you're signed in as is a referral-only agent; they can only own REFERRAL / INTERNAL_REFERRAL transactions, not regular SALE or LEASE."
  remediation:
    - "Route to `/create-referral-payment` (classification REFERRAL) or the internal-referral flow."
    - "Or: sign in as a non-referral-only agent."

- match: "You cannot create a transaction in a country where your account is not registered"
  severity: 🚨
  plain_english: "Property is in a country (US vs Canada) that doesn't match the agent's registration country."
  remediation:
    - "ABORT — pick a different property OR a different owner agent."

- match: "sum of commission percentage should be 100"
  severity: 🚨
  plain_english: "Commission splits don't sum to 100%. Renormalization failed somewhere upstream."
  remediation:
    - "Recompute via `compute_commission_splits` and retry `set_commission_splits`."

- match: "NEEDS_COMMISSION_VALIDATION"
  severity: ✓
  plain_english: "This is the expected state after a successful create. Not a problem."
  remediation: null

- match: "LISTING_ACTIVE"
  severity: ✓
  plain_english: "Expected state for a freshly-submitted listing. Not a problem — when the user submits the derived transaction, Bolt will auto-transition the listing to LISTING_IN_CONTRACT."
  remediation: null

- match: "No open transaction found for in contract listing"
  severity: ⚠️
  plain_english: "The `transition_listing → LISTING_IN_CONTRACT` endpoint needs a pre-existing transaction; it's a chicken-and-egg with the Bolt-first flow."
  remediation:
    - "Ignore this error — `build_transaction_from_listing` works directly from LISTING_ACTIVE, no transition needed."
    - "The listing will auto-transition when the derived transaction is submitted in Bolt."
  seen_in: "Multiple seller-side runs 2026-04-17"

---

**How the agent should surface these** (output template):

```
🚨 {plain_english}
   Fix: {remediation[0]}
        {remediation[1]?}

Transaction — team1 · builder {id}
... (normal summary) ...

> Review: {url}
```

OR for multiple:

```
⚠️ 2 issues to note:
  1) {plain_english_1}
  2) {plain_english_2}

Transaction — team1 · builder {id}
...
```

Place ALL warnings/errors above the code-block summary, NEVER below the URL.

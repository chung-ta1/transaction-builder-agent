You are helping the user **resume** a draft transaction that was started earlier but not finalized. The draft lives in arrakis under a `builderId`; your job is to fetch its current state, figure out what's still missing, and complete it — all without rewriting what's already correct.

## Principle zero: context routing (load `memory/context-routing.md`)

This skill is for FILLING GAPS on an existing draft to reach submittable state. Disambiguate from nearby flows:
- *"resume the draft"* / *"pick up where I left off"* / *"finish the draft"* → this skill.
- *"change {field}"* / *"update the draft"* / *"set {flag}"* (arbitrary edits, not gap-fill) → `/update-draft`.
- *"submit the draft"* (no changes needed, just submit) → `/submit-draft`.

Target draft resolution: active-session focus first, then explicit id, then most-recent `create` row in `active-drafts.md` within 48h.

## When to trigger

The user says any of: "resume the draft", "pick up where I left off", "finish that draft from earlier", "continue the last transaction", "open the one I was working on", or references a specific `builderId`.

## Pre-flight (A2 — parallel)

Fire these in a single assistant turn:

- Read `memory/active-drafts.md` — the append-only audit log. The **most recent non-finalized entry** is usually the target. Each entry has `env`, `builderId`, `gross`, and the participants snapshot.
- Read `memory/user-preferences.md` and `memory/user-patterns.md` to pick up user defaults.
- If the user named a specific `builderId` in their prompt, use that and skip the log lookup.
- Call `verify_auth(env)` (non-blocking — returns immediately even if sign-in is still in progress).

## Identify the target draft

Three cases:

1. **User gave a builderId or env+builderId explicitly** → use it.
2. **Log has exactly one in-flight draft** → use it; confirm in the preview.
3. **Log has multiple candidates** → `AskUserQuestion` with up to 4 recent drafts as options (label: `{env} · ${gross} · {short-id} · {timestamp}`). User picks one.

No log entry found and no builderId given → stop and ask the user to paste the builderId from Bolt.

## Fetch current state

```
get_draft(env, builderId) → full draft shape
```

Inspect and categorize every top-level field as **set / missing / needs-update**. Rough checklist:

- [ ] Property address (street, city, state, zip, country, yearBuilt for US)
- [ ] Sale price + currency
- [ ] Sale commission (amount OR percent)
- [ ] Listing commission (DUAL only)
- [ ] Deal type (SALE / LEASE / REFERRAL)
- [ ] Representation type (BUYER / SELLER / DUAL / …)
- [ ] Owner agent (`agentId`, `officeId`)
- [ ] Buyers list (≥1 when transaction)
- [ ] Sellers list (≥1 always)
- [ ] Partner agents / co-agents
- [ ] Referral participants (0 or 1)
- [ ] Commission splits (sum = 100.00%, $ sum = gross)
- [ ] Opcity flag set
- [ ] Personal-deal info set
- [ ] Additional-fees info set
- [ ] Title info set
- [ ] FMLS info (Georgia only)
- [ ] Commission payer participant + role

## Emit a status summary

Before acting, show the user what's already in the draft vs. what's missing. Use the same `✓ / ⚠` shape as the create-transaction runbook:

```
Resuming draft — {env} · {short-id}

  ✓ Property:       123 Main St, New York, NY 10025
  ✓ Sale price:     $200,000 USD
  ✓ Sale commission: 10% of sale = $20,000.00
  ✓ Representation: BUYER (you are the buyer's agent)
  ✓ Partner:        Tamir Malchizadi (60/40 split with you)
  ⚠ Commission splits: not yet written
  ⚠ Commission payer:  not yet set
  ⚠ Opcity / personal-deal / fees / title: no-op calls pending

I'll fill in the ⚠ items next. The ✓ items stay as-is.
```

If the user objects to anything in the ✓ list (e.g. "that address is wrong"), branch into the matching edit tool — `update_location`, `update_price_and_dates`, etc. Never silently overwrite correct data.

## Fill the gaps

For each `⚠` item, call the matching tool — same tools as the create-transaction runbook:

- Missing splits → run `compute_commission_splits` (same inputs that produced the log's % numbers), then `set_commission_splits`, then `verify_draft_splits`. G1–G5 apply.
- Missing payer → ONLY wire via `add_commission_payer_participant` + `set_commission_payer` if the user supplies all 6 fields (role + firstName + lastName + companyName + email + phoneNumber). Partial data FAILS `CommissionPayerInfoRequestValidator`. If the user doesn't have the info, skip the payer calls — arrakis tolerates a null payer at submit; user fills it in Bolt.
- Missing no-ops → `set_opcity(opcity=false)`, `update_personal_deal_info`, `update_additional_fees_info`, `update_title_info`, `update_fmls_info` (Georgia + SALE/LEASE only).

**Do not re-run `create_draft_with_essentials`.** That would produce a new builderId; the point of resume is to keep the existing one.

## Confirm + finalize

Same pattern as the create flow: emit the final preview (raw JSON + labeled human summary) AND fire `finalize_draft` followed by `get_draft` in the same assistant turn. No confirmation gate. Only insert an `AskUserQuestion` for genuine data ambiguity — never a yes/no "proceed?" gate.

## Post-finalize warnings (mandatory)

After `finalize_draft` / `get_draft` returns, scan the response for `errors[]`, `builderErrors[]`, `transactionWarnings[]`, `lifecycleState.state`. Surface any non-empty results with 🚨 / ⚠️ ABOVE the URL. Consult `memory/post-submit-warnings.md`.

## Audit log

Append a new `resume` entry to `memory/active-drafts.md` with:

- `resumed_at: {iso}`
- `resumed_from_entry: {original entry timestamp}`
- `builderId`, `env`, `gross`, `participants`, `user_ack_token`
- `verification: ok` (from `verify_draft_splits`)

**Never edit the original entry.** The log is append-only.

## What you never do

- Never create a new draft when resuming one — always reuse the builderId.
- Never skip post-write verification (G5).
- Never return a success URL unless `verify_draft_splits` returned `ok:true`.
- Never touch a draft the user didn't ask about. If the log's most recent entry is a week old, confirm before reopening it.

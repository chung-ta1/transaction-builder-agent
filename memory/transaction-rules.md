# transaction-rules

Rulebook the `/create-transaction` runbook loads on every run. Hand-written and
kept in sync with the arrakis backend by a maintainer (see CLAUDE.md → "When
arrakis changes").

---

## Tool surface (post-consolidation)

The MCP tool layer was simplified: 42 tools → 21. References to old tool
names in older runbook prose map to the current surface as follows. **When a
runbook says an old name, call the new tool instead.**

| Old name (deleted) | New tool to call instead |
|---|---|
| `create_draft_with_essentials`, `create_full_draft`, granular `create_draft` | `create_draft_full` — happy-path one-shot for new drafts (handles skeleton case too: just env + type + transactionOwnerId). For resume/update, use `update_draft_section` directly on an existing builderId. |
| `finalize_draft` | `set_opcity` (always required) + `set_finalize_flags` ({ personalDeal, additionalFees, title, fmls? }) |
| `add_partner_agent` | `add_participant` (role="co_agent"). For DUAL representation: call **twice** — once with side BUYERS_AGENT, once with SELLERS_AGENT. |
| `verify_draft_splits` | `set_commission_splits({ verify: true })` — the verify pass folds into the write. The runbook always paired them; one tool removes drift risk. |
| `auth_action` | `pre_flight` covers the verify case. To sign out, call `pre_flight({ forceFresh: true })` — invalidates the cached token before probing. |

The discriminator-based tools (`update_draft_section`, `add_participant`,
`remove_participant`, `add_referral`, `wire_commission_payer`,
`set_finalize_flags`, `convert_listing`, `set_termination`) each take an
explicit kind/role/section/state field — supply that field in every call.

---

## Auth & environment

- **Production is permanently blocked.** Any env resolving to `therealbrokerage.com` is rejected before the MCP makes any HTTP call. Supported: `team1`, `team2`, `team3`, `team4`, `team5`, `play`, `stage`.
- **JWT cached per-env.** Browser login runs lazily (first tool call that needs it), caches in memory + optional macOS Keychain. On 401 the MCP evicts and reopens the browser exactly once.
- **Never log secrets.** `Authorization` headers are redacted in any structured logs.

## Representation & deal type

- **Representation inference from the prompt:**
  - "buyer's agent" / "representing the buyer" → `BUYER`
  - "listing agent" / "seller's agent" / "representing the seller" → `SELLER`
  - "both sides" / "dual rep" → `DUAL`
  - "tenant side" / "for the tenant" → `TENANT`
  - "landlord side" / "for the landlord" → `LANDLORD`
- **Never finalize representation silently** — always confirm in the preview.
- **Deal type default**: `SALE`. Flip to `LEASE` on words like lease/rental/tenant/landlord, to `REFERRAL` only when explicitly stated.
- **Property type default**: `RESIDENTIAL` (matches arrakis's backward-compat default). Change only if the prompt names commercial/land/condo/townhouse.

## Location & country

- **Agent-country must match property-state country.** `TransactionBuilder.updateAddress` throws if the agent is registered in the USA and the property is in Canada (or vice versa). Surface this as a translated error *before* writing.
- **Year built is required in the USA.** Optional in Canada.
- **Year built must NEVER be inferred or defaulted.** User rule (2026-04-21): when `yearBuilt` is missing from the prompt, ask via `AskUserQuestion` as a plain free-text input (no pre-populated options like 2020/2000/1970, no cached `typical_year_built` default). The user must actively type the year on every run. Strip any default options the validator returns for this field.
- **Currency by state.** US → `USD`. Canadian provinces (`ALBERTA`, `BRITISH_COLUMBIA`, `MANITOBA`, `NEW_BRUNSWICK`, `NEWFOUNDLAND_AND_LABRADOR`, `NOVA_SCOTIA`, `NORTHWEST_TERRITORIES`, `NUNAVUT`, `ONTARIO`, `PRINCE_EDWARD_ISLAND`, `QUEBEC`, `SASKATCHEWAN`, `YUKON`) → `CAD`. Derived from `state`; only confirm if the prompt's dollar symbol contradicts.
- **FMLS** is only offered/required when `state == GEORGIA` and deal is SALE/LEASE. Skip `set_finalize_flags` (fmls field) elsewhere.

## Buyers & sellers

- `sellers` list is `@NotEmpty` — at least one seller every time. Buyers are also required for transactions (`For transactions, you must specify a list of buyers.`). Ask for names if the prompt omits them.
- Each person needs **companyName** OR (**firstName** AND **lastName**).

## Commission — the core math

The rule that trips users up. Read this section carefully on every run.

**arrakis rule**: the percentages inside `set_commission_splits` must sum to **exactly 100%** (verified at `TestTransactionBuilder.setCommissionSplitsForSingleRep:656` — `remainingForUndefined = 100 - percentCommissionsTotal`). Referral participants are in the same list as agent participants — their percent counts toward the 100% too.

**Interpretation of a prompt like "me 60% / Tamir 40% / 30% referral" ($20k gross)**:

1. Referral comes off the top of gross:
   - `referral_pct_of_gross = 30%` → `$6,000`
   - `agent_pool_pct = 100 − 30 = 70%` → `$14,000`
2. The user's `60 / 40` is the **ratio between the agents**, not %-of-gross:
   - `me_share_of_pool = 60 / (60 + 40) = 0.60`
   - `tamir_share_of_pool = 40 / (60 + 40) = 0.40`
3. Effective %-of-gross (what goes to arrakis):
   - `me_pct = me_share_of_pool × agent_pool_pct = 0.60 × 70 = 42%` → `$8,400`
   - `tamir_pct = 0.40 × 70 = 28%` → `$5,600`
4. **Sanity check**: `30 + 42 + 28 = 100%`. Dollars: `$6,000 + $8,400 + $5,600 = $20,000`.

**Shortcut**: when the user's agent ratios already sum to 100 (as in 60+40), each agent's arrakis-pct is just `user_ratio × (1 − referral_pct_of_gross)`. 60 × 0.7 = 42; 40 × 0.7 = 28.

### ⚠️ Financial-grade accuracy stack

Seven independent guards. **This is a financial document — every guard is mandatory; they compose.**

**G1. Integer-cents arithmetic — code-enforced.** All commission math runs through `compute_commission_splits`, which is a pure TypeScript module (`src/math/commissionSplits.ts`) using integer cents and basis-points throughout. The agent **must** call this tool — it never computes splits in the LLM. The tool throws `CommissionMathError` on any contradictory input; treat that as a stop.

**G2. Two-stage inconsistent-sum gate — INTERPRETATION first, then TYPE-TO-CONFIRM.**

When the user's raw percentages don't already sum to `100.00`, run two separate gates in order. Never collapse them into one "here's the renormalization, type confirm" prompt — that pattern primes the user to accept a guessed interpretation.

**G2a — Interpretation gate (runs before the parse summary, in step 3a of the runbook).** Fire an `AskUserQuestion` with ≥2 plausible interpretations as explicit options, plus "let me restate the percentages" as an escape. Each option must show its full dollar math. Example for "me 60 / Tamir 40 / Jason 30 referral" on $20,000 gross:

- **Option A — Referral off the top, agents share remainder 60/40.** Jason 30% = $6,000 · You 42% = $8,400 · Tamir 28% = $5,600 · sums to 100%.
- **Option B — Agents share gross 60/40, referral not on this draft.** You 60% = $12,000 · Tamir 40% = $8,000 · Jason dropped.
- **Option C — Let me restate the percentages.** (User supplies corrected numbers.)

The agent must not present one of these as "what I'll send" — they are peers. If only one is plausible (rare), state that explicitly and still surface the alternative. Do NOT proceed to the parse summary or any downstream step until the user has picked one.

**G2b — Type-to-confirm gate (runs after the user picks an interpretation, before the final preview).** Once the user chose an interpretation (e.g. Option A), fire a second `AskUserQuestion` with a bold callout showing exactly the chosen math:

> 🛑 **COMMISSION RENORMALIZED TO SUM TO 100% — REVIEW CAREFULLY**
>
> **Your raw intent:** `60 / 40 / 30 referral` (sum 130%, arrakis rejects)
> **Your choice:** Option A — referral off the top, agents 60/40 of remainder.
>
> **I will send to arrakis:**
> - Jason (referring agent): `30.00%` → `$6,000.00`
> - You (buyer's agent):     `42.00%` → `$8,400.00`
> - Tamir (buyer's agent):   `28.00%` → `$5,600.00`
> - **Normalized sum: `100.00%`** · **Dollar sum: `$20,000.00`** · Gross: `$20,000.00` · ✓ reconciled

The user must **type a literal "confirm" word** (not just pick a button) to advance. The agent uses `AskUserQuestion` with an `Other` free-text path and a required exact token — no "Yes, proceed" button. Deliberate friction so the user can't absent-mindedly approve a wrong number.

Accepted tokens: `confirm`, `I confirm`, `yes confirm`. Anything else (including plain "yes") loops back to G2b with the callout. A user answer of "restate" or an obvious percentage reply sends the agent back to G2a.

**Why two stages:** if G2 were a single "here's the renormalization, type confirm" prompt, the agent has already decided the interpretation for the user — and the user may accept it because it looks authoritative. G2a forces the decision to happen with all plausible readings visible side-by-side. Verified bug: draft 3f0a2b1c (2026-04-17) — agent presented renormalized 42/28/30 as parsed fact; user actually meant 50/25/25 and had to push back.

**G3. Dollar-and-percent dual reconciliation — code-enforced inside `compute_commission_splits`.** The tool asserts both invariants before returning; if either fails it throws. Two invariants:

- `Σ dollars == gross` to the exact cent
- `Σ percentages == 100.00` to two decimals

A successful return means both held. The agent gets `reconciled: true` deterministically — no LLM arithmetic involved.

**G4. Raw JSON preview.** In the final preview (after the ACK gate), the agent shows the exact JSON payload that will be sent to `set_commission_splits`, alongside the human-readable summary. The user can eyeball the wire format — no hiding.

**G4a. Human-readable preview — every line labeled.** Non-technical readers need explicit labels, not symbol-only lines. At minimum the preview must show, on their own lines:
- `Property:` — full address
- `Deal type:` — Sale / Lease / Referral
- `Sale price:` — dollar amount + currency (what the property sold for)
- `Sale commission:` — percent of sale **and** the dollar amount it produces (e.g. `4.00% of sale = $20,000.00`)
- (DUAL only) `Listing commission:` — same dual form
- `Who gets what:` — per-participant rows with dollar amount + effective % of the pot
- `Total:` — reconciled totals row with `✓ adds up`
- `Commission paid by:` — the payer participant

Never compress these into a single line like `Sale · $20k · USD`. A user who doesn't already know the tool can't parse that.

**G5. Post-write verification — dedicated tool.** Immediately after `set_commission_splits` succeeds, the agent **must** call `set_commission_splits` (with `verify: true`) (which fetches the draft and diffs committed vs. sent using `src/math/verifySplits.ts`). Any drift — missing participant, extra participant, or mismatched percent — returns `ok:false` with the specific diff. The agent stops the flow, translates the error, and does **not** return a "success" URL. The verification is code, not LLM judgment.

**G6. (RETIRED) Audit log.** Previously required appending each confirmed draft to `memory/active-drafts.md`. Retired: arrakis is the system of record; local mirroring added complexity without informational value. Use `list_my_builders` + `get_draft` when historical context is needed.

**G7. Sanity rail — no silent rounding.** If the computed split cannot sum to exactly 100.00 (e.g. the prompt's numbers are internally contradictory, or the ratios produce a repeating decimal beyond 2dp), the agent stops and asks via `AskUserQuestion`. It must **not** silently round to force a fit. Acceptable remedies: ask the user to adjust one percentage, or explicitly ask whether to round up vs. down (with explicit options showing which participant absorbs the cent).

**Clean-sum short-circuit**: if the raw percentages already sum to exactly `100.00` (e.g. "me 50 / him 30 / referral 20" = 100), skip the ACK gate (G2) — go straight to the final preview. The dual reconciliation (G3), raw JSON preview (G4), and post-write verification (G5) still apply.

**Other commission rules worth knowing**:

- `saleCommission` and `listingCommission` (on `PriceAndDateInfoRequest`) are expressed as **amount OR percent** via `CommissionFractionalPercent{commissionAmount?, commissionPercent?, percentEnabled}`. Exactly one of the two is populated based on `percentEnabled`.
- Amount-based commissions are subtracted from gross **first**; percent commissions then apply to the remainder (`DualRepresentationAgentCommissionValidation.getAgentParticipantsForValidation`).
- **Single-rep**: if some agents have explicit percents and others don't, arrakis's convention is that the undefined agents share `(100 − sum_of_defined)` equally. The MCP writes every participant explicitly, so we always define.
- **Dual-rep**: splits are computed per-side (BUYERS_AGENT + SELLERS_AGENT separately); at least one agent must have a positive commission on both sides; per-side amount sum ≤ that side's commission (tolerance 0.10 money units); `listingCommission` becomes mandatory.

## Referrals

- **Max one non-opcity referral** per draft. arrakis throws `ONE_REF_AGENT_ERROR` on a second.
- **Internal referral**: `type=AGENT`, `role=REFERRING_AGENT`, needs `agentId` (resolved via `search_agent_by_name`). No EIN/W9.
- **External referral**: `type=EXTERNAL_ENTITY`, `role=REFERRING_AGENT`, needs `companyName` (outside brokerage), `firstName/lastName`, `email`, `phoneNumber`, `address`, `ein`; optional `vendorDirectoryId`; W9 file via `add_referral` (with w9Path) (separate multipart call).
- When `search_agent_by_name` returns zero candidates for a referral, ask "Is {name} at an outside brokerage?" before switching to the external flow.

## Co-agents & the "other-side" agent

- **Single-rep, other side is represented**: create an `OTHER_AGENT` participant via `add_participant` (role="other_side_agent") — needs brokerage name (as `companyName`), first/last, email, phone, address, EIN (US), W9 file.
- **Single-rep, other side unrepresented**: skip entirely.
- **Dual-rep**: every co-agent is registered **twice** via `add_participant` (role="co_agent") — once as `BUYERS_AGENT`, once as `SELLERS_AGENT`. This is what keeps `DualRepresentationAgentCommissionValidation` happy. On the happy path, pass each DUAL co-agent twice in `create_draft_full`'s `coAgents` (once per side) — the tool does not synthesize the second side for you.

## Commission payer

**OPTIONAL at create — but submit without it parks the transaction in NEW.** A draft with a null payer submits successfully (no hard block), BUT the resulting transaction stays in `NEW` with a CRITICAL "Commission Payer information is missing" until a payer is added — it is NOT fully live until then. So a null payer is not "fine"; it's a known, expected post-submit step. Surface that CRITICAL above the URL (don't bury it), and tell the user the payer must be added in Bolt ("I Don't Have The Information Yet" → fill later) or via `wire_commission_payer`. Don't fabricate a payer to dodge the NEW state — a bogus title company is worse than a clean "add this in Bolt."

**When you DO wire a payer**, `CommissionPayerInfoRequestValidator` REQUIRES all six fields simultaneously:

- role, firstName, lastName, companyName, email, phoneNumber

A partial payload (e.g. only `companyName`) fails bean validation with messages like "First name is required for commission payer info". So:

- **Have all 6 fields** → wire the payer via `wire_commission_payer` (it both creates the payer participant and sets the role in one call).
- **Don't have all 6 fields** → omit the call. The payer is optional at create; the user adds it in Bolt (transaction lands in NEW until they do — see above).

### Typical default roles (when the user does provide full info)

| Country | Deal | Role |
|---|---|---|
| US | SALE | `TITLE` |
| Canada | SALE | `SELLERS_LAWYER` (also create `BUYERS_LAWYER`) |
| Any | LEASE | `LANDLORD` / `TENANT` / `MANAGEMENT_COMPANY` — ask |
| Other | — | Ask from `CommissionPayerDisplay` enum |

`VALID_CD_PAYER_ROLES` = `{TITLE, SELLERS_LAWYER, OTHER_AGENT}`.

## Mandatory "no-op" calls

These must be invoked even when nothing changes, or the draft won't be submittable. `create_draft_full` fires them in order for the happy path; on the granular path, `set_opcity` + `set_finalize_flags` cover them:

- `set_opcity(opcity=false)` — finalizes the participant list before commission splits. Without this call, the splits call can silently drop participants.
- `set_finalize_flags({ personalDeal: {personalDeal: false, representedByAgent: true} })` — both fields `@NotNull`.
- `set_finalize_flags({ additionalFees: {hasAdditionalFees: false, additionalFeesParticipantInfos: []} })` — when there are no extra fees.
- `set_finalize_flags({ title: {useRealTitle: false} })` — when the user isn't using Real Title (setting `true` requires full `titleContactInfo` + `manualOrderPlaced`).

(`set_finalize_flags` accepts any subset of `{ personalDeal, additionalFees, title, fmls }` in one call — the three above are typically passed together.)

## Submit preconditions (mirrored client-side before returning the URL)

From `TransactionBuilder.validate()` (arrakis-core, line 639):

- `salePrice > 0`
- `ownerAgent.agentId` present
- owner agent list non-empty
- owner agent `officeId` present

The MCP checks these client-side before returning the bolt URL so the user doesn't open a broken draft.

## Post-submit entity ids — builderId vs. submitted-entity id

**After any `submit_draft`, use `result.id` (not the original builderId) for subsequent domain operations on the submitted entity.** arrakis creates a separate `Listing` or `Transaction` row at submit with a fresh UUID; the builder's id stops being the authoritative handle. So `convert_listing(listingId=…, to="transaction")` takes the post-submit `result.id`, NOT the builderId that was submitted (passing the consumed builderId 404s "Transaction not found by id").

Builder-scoped reads (`get_draft(builderId)`) still resolve to the builder row post-submit, which is why it's easy to reach for the wrong id. Whenever the next step is a lifecycle operation, consult the submit response and grab `result.id` before proceeding (use `get_transaction(env, id)` to read the live entity back).

**Seller-side ordering — one step, NOT a separate in-contract transition.** The correct order for team1/play:

1. Create listing → submit → `LISTING_ACTIVE`
2. `convert_listing(listingId=result.id, to="transaction")` — works DIRECTLY on `LISTING_ACTIVE`; it advances the listing and returns a new transaction builderId inheriting the listing's data
3. Fill transaction (buyers, dates incl. closingDate) → splits → verify → finalize
4. Submit the transaction → live

**Do NOT call `convert_listing(to="in_contract")` in this flow.** A normal agent cannot fire the `LISTING_ACTIVE → LISTING_IN_CONTRACT` transition — it 404s (the transition is admin-only, under `nextPrimaryAdminTransition`). The listing reaches `LISTING_IN_CONTRACT` as a downstream effect of the linked transaction, not as a step the agent drives. (Verified 2026-05-28 on team1.)

## Draft URL

`https://bolt.{env}realbrokerage.com/transaction/create/{builderId}` — singular `transaction`, not plural. Using the plural form makes Bolt's router interpret "create" as a transactionId and throw `could not be converted to type 'UUID'`. Verified 2026-04-17 against team1.

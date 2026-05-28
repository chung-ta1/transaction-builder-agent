# PLAN — create-transaction fast path

**Goal.** Reduce `/create-transaction` round-trips to **zero in the happy path**. Today's flow runs `validate_draft_completeness` → `AskUserQuestion` cycles until `ready: true` (typically 1–2 batches: yearBuilt, MLS#, sale price, commission, buyer/seller name). New flow: parse → create with whatever we have → report missing fields as a post-create gap list. User finishes in chat by reply, or in Bolt's wizard. Never block on a non-financial-correctness field.

**Non-goal.** Removing the financial-correctness gates (commission interpretation ambiguity, listing pre-check for SELLER/DUAL, classification ambiguity, identity disambiguation). Those stay as `AskUserQuestion`.

---

## Evidence (why this is feasible without arrakis changes)

Static analysis of the existing client:

| Layer | Says about yearBuilt / mlsNumber / dates |
|---|---|
| `src/types/schemas.ts` `locationInfoSchema` | yearBuilt, mlsNumber, escrowNumber, propertySlug all `.optional()` |
| `src/types/schemas.ts` `priceAndDatesSchema` | acceptanceDate, closingDate, all condition dates `.optional()` |
| `src/services/TransactionBuilderApi.ts` `initializeDraft` | returns just a `builderId` for an empty shell — proves arrakis accepts a draft with zero subsections populated |
| `src/util/draftRequirements.ts` `requireYearBuilt`, `requireMlsNumber` | hard gaps, **not aligned with zod** — the runbook is stricter than the wire format |

The mismatch IS the opportunity: our own validator demands fields the wire protocol marks optional. Removing those demands is a one-file change.

**Server-side unknown** (only one): does arrakis itself reject `yearBuilt: null` even when our zod allows omitting it? Static analysis can't answer this — every Spring controller could have its own `@NotNull`. Verify on first run against team1; mitigation if it fails is per-field fallback to "ask once."

---

## Phase 1 — Validator: stop blocking on optional-by-zod fields

**File:** `src/util/draftRequirements.ts`

Delete or downgrade these requirements from the gap engine (around lines 151–152, 159–160):
- `requireYearBuilt` → **delete the `gaps.push`**, keep the sanity check (`sanityCheckYearBuilt` at line 190 stays — if user *does* supply a value, still reject `20011`).
- `requireMlsNumber` → **delete**.

Keep these — they're real wire requirements:
- `requireAddressFields`, `requireSeller` (zod `min(1)`), `requireSalePrice`, `requireSaleCommission`, `requireRepresentationType`.

Add a new return field:
```ts
type RequirementResult = {
  ready: boolean;
  gaps: Gap[];          // hard gaps — block create
  softGaps: Gap[];      // missing-but-omittable — surface AFTER create
  defaults: Default[];
  blockers: Blocker[];
};
```

The yearBuilt / MLS / acceptance-date items move from `gaps` to `softGaps`. The runbook treats softGaps differently (see Phase 3).

**Test addition:** `test/util/draftRequirements.test.ts` — assert that a fully-specified draft minus yearBuilt+MLS yields `ready: true, softGaps: ["yearBuilt", "mlsNumber"]`.

---

## Phase 2 — API: skip subsection PUTs when no data exists for them

**Files:** `src/tools/convenience/create_full_draft.ts`, `src/tools/convenience/create_draft_with_essentials.ts`

Today both of these unconditionally call every subsection PUT. Change to:
- Always call `initializeDraft`, `setTransactionOwner`, `updateOwnerAgentInfo` (these have no useful "skip" semantics).
- Call `updateLocationInfo` only if street is present.
- Call `updatePriceAndDateInfo` only if `salePrice && saleCommission` are both present (zod requires both for that PUT).
- Call `updateBuyerAndSellerInfo` only if at least one seller is present (the only field zod marks `min(1)`).

When a subsection is skipped, return its name in `result.skippedSections: string[]` so the runbook can report it.

**Test addition:** `test/scenarios/skip-subsections.test.ts` — given a prompt with only address + owner, assert `create_full_draft` makes exactly 3 HTTP calls (init, owner, location) and returns `skippedSections: ["price-date", "buyer-seller"]`.

---

## Phase 3 — Runbook: parse → create → report

**File:** `src/prompts/create_transaction.md` (the source; `.claude/skills/create-transaction/SKILL.md` is auto-generated — do not edit directly).

Replace the validator-cycle section (currently steps 5–6, ~150 lines) with:

> **5. Validate once.** Call `validate_draft_completeness`. Look at `gaps` (hard) and `blockers`.
>
> - If `blockers` non-empty → STOP, surface the blocker, do not proceed.
> - If `gaps` contains a **financial-correctness** entry (commission ambiguity, identity collision, classification) → fire ONE `AskUserQuestion` with those, re-validate, repeat until those are clear.
> - All other `gaps` are now in `softGaps` and **do not block create**.
>
> **6. Fire create_full_draft. In the same turn, emit:**
> ```
> ✓ Draft created — builderId: abc123 — open: <bolt-link>
>
> ⚠ Still required before submit (N):
>   • Year built — reply "yearBuilt 1948" or fill in Bolt
>   • MLS number — reply "mls 123456" or "mls N/A" for non-MLS
>
> Reply with values to fill in chat, or finish in Bolt + run /submit-draft.
> ```

Add a parallel reply-handler step:

> **7. Handling fill-in replies.** When the user replies with a soft-gap value:
> - Map `yearBuilt N` → `update_draft({yearBuilt: N})`
> - Map `mls X` → `update_draft({mlsNumber: X})` (or `"N/A"`)
> - Map `acceptance YYYY-MM-DD` → `update_draft({acceptanceDate: ...})`
> Re-validate; if all soft gaps cleared, suggest `/submit-draft`.

**Existing skill that handles this:** `/update-draft` already routes natural-language mutations to the right granular MCP tools. Reuse — don't reinvent.

---

## Phase 4 — Verification probe (FIRST plan execution step, before code changes ship)

A team1 round-trip to confirm arrakis accepts an empty-subsection draft. **This is the only thing that requires a real network call.**

**File:** `test/contract/empty-draft.contract.test.ts` (new)

```ts
// pseudocode
test("arrakis accepts a draft with location-info missing yearBuilt+MLS", async () => {
  const builderId = await api.initializeDraft("team1", "TRANSACTION");
  await api.setTransactionOwner("team1", builderId, currentYentaId);
  await api.updateLocationInfo("team1", builderId, {
    street: "123 Main St", city: "NYC", state: "NEW_YORK", zip: "10025",
    // omit yearBuilt, mlsNumber
  });
  const draft = await api.getDraft("team1", builderId);
  expect(draft.address.yearBuilt).toBeUndefined();
  expect(draft.address.mlsNumber).toBeUndefined();
  await api.deleteDraft("team1", builderId);   // cleanup
});
```

Run with `npm run test:contract`. Requires VPN + interactive browser auth on first run.

**Decision tree on probe result:**
- ✅ Both PUTs succeed, getDraft returns nulls → ship Phase 1–3 as-is.
- ⚠ Location PUT 400s on `yearBuilt: undefined` → narrow Phase 1 (keep `requireYearBuilt` as hard gap, only liberalize MLS).
- ⚠ Location PUT 400s on both → revert to placeholder strategy (`yearBuilt: 2000, mlsNumber: "N/A"` with `~placeholder` markers in the parse summary).

---

## What stays unchanged (do not touch)

- **Financial-grade accuracy stack** (G1–G7 in `memory/transaction-rules.md`). All commission math gates remain `AskUserQuestion`.
- **Listing pre-check** for SELLER/DUAL representation. Bolt's UI gate, not arrakis's — agents can't submit a seller-side draft without an in-contract listing.
- **Identity disambiguation** when `search_agent_by_name` returns >1.
- **`memory/error-messages.md`** flow for arrakis errors at submit time.

---

## Sequencing

1. Probe (Phase 4) — confirm or refute the server-side assumption. ~30 min once auth is fresh.
2. Phase 1 — validator change. ~1h. Tests pass locally before any wire change.
3. Phase 2 — convenience-tool changes. ~2h.
4. Phase 3 — runbook rewrite. ~2h. Most of the diff is *deletion*.
5. Run the existing scenario tests + a new "minimum-prompt" scenario asserting zero `AskUserQuestion` calls in the happy path. Ship behind no flag — runbook change is reversible.

**Total estimate:** half a day to a full day depending on probe outcome.

---

## Compounds with (separate plan)

The May Challenge contract-ingestion skill (`/contract-to-transaction`) becomes much sweeter on top of this. Contract supplies price/commission/dates/parties; this plan ensures yearBuilt+MLS don't block; combined result = drop-the-PDF, draft created, one summary line, done. That plan is separate; do not couple them in the same PR.

---

## Open questions / things to confirm with user before starting

1. **Soft-gap reply syntax.** Plan above uses `"yearBuilt 1948"` — alternative is a single-question `AskUserQuestion` follow-up. Open question: does the user prefer the chat-as-form pattern or a structured follow-up? Either works; chat-as-form has fewer round-trips, structured has clearer affordance.
2. **Parse-summary verbosity.** When zero hard gaps but 3 soft gaps, do we still show the full ✓/⚠ parse summary, or skip straight to the create + post-create list? Recommendation: skip the parse summary when there are no hard gaps — the post-create list is the new review step.

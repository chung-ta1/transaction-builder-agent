# PLAN — aggressive simplification

**Goal.** Cut ~40–50% of the repo (4,000–5,500 LOC out of 10,857) with zero feature loss. Eliminate the dual-orchestration smell (tool + runbook), the validator-cycle pattern, and the 1:1 endpoint→tool mapping that bloats the MCP surface.

**Non-goals.** Removing the financial-correctness guards (G1–G7), the listing pre-check, identity disambiguation, the auth flow, or the math module.

**Sequencing principle.** Each phase is independently shippable. The plan can be paused after any phase. Phase 0 always first; Phase 8 (radical passthrough) is opt-in after evaluating Phase 3's results.

---

## Phase summary

| # | Phase | LOC saved | Risk | Independent? |
|---|---|---|---|---|
| 0 | Arrakis empty-field probe | 0 (probe) | Low | — |
| 1 | Fast-path validator + runbook | -800 | Low | Yes |
| 2 | Delete convenience layer (5 of 7) | -891 | Low (after #1) | Depends on #1 |
| 3 | Granular MCP consolidation 35→18 | -1,500 | Medium | Yes |
| 4 | Memory + prompt dedup | -550 | Low | Yes |
| 5 | Skill consolidation 9→6 | -300 | Medium | Yes |
| 6 | Test + script trimming | -250 | Low | Yes |
| **Subtotal — phases 0–6** | | **~4,300 LOC (40%)** | | |
| 8 (opt) | Radical passthrough (1 mega-tool) | -1,500 more | High | After #3 |
| **Total with radical** | | **~5,800 LOC (53%)** | | |

---

## Phase 0 — Arrakis empty-field probe (~30 min)

Already specified in `PLAN-create-transaction-fast-path.md`. Confirm arrakis accepts `/location-info` PUT without `yearBuilt`/`mlsNumber` and `/price-date-info` PUT without optional dates. Required before any code change ships.

**File created:** `test/contract/empty-draft.contract.test.ts` (one file, deletable after run).
**Run:** `npm run test:contract`.
**Decision tree:** see fast-path plan.

---

## Phase 1 — Fast-path validator + runbook (-800 LOC, ~half day)

See `PLAN-create-transaction-fast-path.md`. Summary:
- `src/util/draftRequirements.ts` 578 → ~150 (sanity checks + financial-correctness gaps + listing pre-check only).
- `test/scenarios/validate-draft-all-paths.test.ts` 596 → ~150.
- `src/prompts/create_transaction.md` rewrite §5–6 (replace validator-cycle with single-pass "validate hard gaps + fire").

Auto-generated `.claude/skills/create-transaction/SKILL.md` shrinks proportionally via `npm run build`.

---

## Phase 2 — Delete convenience layer (-891 LOC, ~1 day)

Move all orchestration to the runbook. The runbook ALREADY has the granular chain documented as the "fallback path" — promote it to the only path.

**Delete:**
- `src/tools/convenience/create_full_draft.ts` (-568) — `createFullDraft`. The 568 LOC inside duplicate-encodes the runbook's chain; arrakis isn't atomic across the chain anyway, so no atomicity benefit.
- `src/tools/convenience/create_draft_with_essentials.ts` (-82) — `createDraftWithEssentials`. The runbook calls `initialize_draft` + `set_transaction_owner` + `update_location` + `update_price_and_dates` + `update_buyer_seller` directly. After Phase 3 these collapse anyway.
- `src/tools/convenience/finalize_draft.ts` (-102) — wraps four no-op flag setters; replaced by Phase 3's `set_finalize_flags` single tool.
- `src/tools/convenience/add_referral.ts` (-82) — wraps `add_internal_referral`/`add_external_referral` + W9; replaced by Phase 3's unified `add_referral` tool.
- `src/tools/convenience/add_partner_agent.ts` (-57) — encodes DUAL twice-registration. Move into the runbook with explicit two `add_participant` calls; the comment explaining why DUAL needs both registrations moves to `memory/transaction-rules.md`.

**Keep:**
- `src/tools/convenience/compute_commission_splits.ts` — wraps the integer-cents math gate (G1). Cannot move to runbook.
- `src/tools/convenience/create_referral_payment.ts` (-239) — distinct one-shot endpoint with its own G1 + payer-wiring + immediate-disburse logic. Keep as-is.

**Update:**
- `src/tools/convenience/index.ts` registers 2 tools instead of 7.
- `src/prompts/create_transaction.md` §"Failure path" / §"Fallback — granular chain" merge into a single "How to create" section. Drops the `NOT_IMPLEMENTED_DUAL` branching entirely (since there's no convenience tool to fail).
- `src/prompts/resume_draft.md` references to `finalize_draft` → expand to the four explicit calls (or to `set_finalize_flags` after Phase 3).

**Validation:**
- `test/scenarios/referral-payment.test.ts` and `test/scenarios/referral-split.test.ts` still pass (they test the kept tools).
- Add `test/scenarios/granular-chain.test.ts` — given a complete answer set, asserts the 10–12 expected granular tool calls fire in order. Use `nock` or the existing axios mock harness.

---

## Phase 3 — Granular MCP consolidation 35→18 (-1,500 LOC, ~2 days)

The biggest structural change. Each merge replaces N tool files + N zod schemas with one file + one discriminated-union schema.

### Section writers (4 → 1)

**Before:** `update_location`, `update_price_and_dates`, `update_buyer_seller`, `set_owner_agent_info`.
**After:** `update_draft_section({ env, builderId, section: "location" | "price-date" | "buyer-seller" | "owner", data })`. The handler dispatches to the existing `TransactionBuilderApi.update*` methods based on `section`.

**Files:**
- Delete: `src/tools/granular/location.ts` (40), `src/tools/granular/participants.ts:setOwnerAgentInfo`+`updateBuyerSeller` (~50 LOC of 101).
- New: `src/tools/granular/sections.ts` (~120 LOC).
- Schema: discriminated union over the 4 existing zod schemas (`locationInfoSchema`, `priceAndDatesSchema`, `buyerSellerSchema`, `ownerAgentInfoSchema`). No schema changes — the union is just `z.discriminatedUnion("section", [...])`.

### Participants (6 → 2)

**Before:** `add_co_agent`, `add_other_side_agent`, `add_transaction_coordinator`, `delete_buyer`, `delete_seller`, `delete_co_agent`.
**After:**
- `add_participant({ env, builderId, role: "co_agent" | "other_side_agent" | "transaction_coordinator", data })`.
- `remove_participant({ env, builderId, role: "buyer" | "seller" | "co_agent", participantId })`.

**Files:**
- Delete: most of `src/tools/granular/participants.ts` (101→~30) and `src/tools/granular/delete_participants.ts` (70→0).
- New: `src/tools/granular/participants.ts` rewritten (~80 LOC).

### Referral (3 → 1)

**Before:** `add_internal_referral`, `add_external_referral`, `upload_referral_w9`.
**After:** `add_referral({ env, builderId, kind: "internal" | "external", data, w9Path? })`. When `w9Path` is present, the handler does the existing `addReferralInfo` + `uploadReferralW9` chain server-side; this is the same composition the deleted convenience tool did, but now lives at the granular layer.

**Files:**
- Replace: `src/tools/granular/referral.ts` (82→~70 LOC).

### Finalize no-ops (4 → 1)

**Before:** `update_personal_deal_info`, `update_additional_fees_info`, `update_title_info`, `update_fmls_info`.
**After:** `set_finalize_flags({ env, builderId, personalDeal?, additionalFees?, titleInfo?, fmls? })`. Handler PUTs each subsection if present. Optional fields → only the populated ones go to arrakis.

**Files:**
- Replace: `src/tools/granular/finalize.ts` (82→~60 LOC).

### Commission payer (2 → 1)

**Before:** `add_commission_payer_participant`, `set_commission_payer`.
**After:** `wire_commission_payer({ env, builderId, ...6 fields })`. The runbook ALWAYS calls these two together; merging removes the chance of calling one without the other.

**Files:**
- Update: `src/tools/granular/commission.ts` (81→~70 LOC).

### Termination (2 → 1)

**Before:** `request_termination`, `undo_termination_request`.
**After:** `set_termination({ env, transactionId, state: "request" | "undo" })`.

**Files:**
- Update: `src/tools/granular/post_submit.ts` (102→~85 LOC).

### Init (2 → 1)

**Before:** `initialize_draft`, `set_transaction_owner`.
**After:** `create_draft({ env, type, transactionOwnerId })`. Handler does both server-side (no parallel benefit; `set_transaction_owner` requires the builderId from `initialize_draft`).

**Files:**
- Update: `src/tools/granular/init.ts` (51→~40 LOC).

### Lifecycle (2 → 1)

**Before:** `transition_listing`, `build_transaction_from_listing`.
**After:** `convert_listing({ env, listingId, to: "in_contract" | "transaction" })`. The two paths share the same precondition (LISTING_ACTIVE → LISTING_IN_CONTRACT, then LISTING_IN_CONTRACT → builder).

**Files:**
- Update: `src/tools/granular/lifecycle.ts` (78→~50 LOC). Keep `submit_draft` as its own tool (distinct semantic).

### Auth (3 → 2)

**Before:** `pre_flight`, `verify_auth`, `sign_out`.
**After:** `pre_flight` (kept, does the full auth + zip lookup), `auth_action({ action: "verify" | "sign_out" })`. `verify_auth` was largely redundant with `pre_flight` since the agent always runs pre_flight first.

**Files:**
- Delete: `src/tools/granular/verify_auth.ts` (61), `src/tools/granular/sign_out.ts` (41).
- New: `src/tools/granular/auth_action.ts` (~50 LOC).

### Untouched (12 tools)

Each is a distinct, well-scoped operation: `validate_agents`, `validate_draft_completeness`, `verify_draft_splits`, `set_commission_splits`, `set_opcity`, `submit_draft`, `delete_draft`, `upsert_installments`, `search_agent_by_name`, `list_my_builders`, `search_existing_listings`, `get_draft`.

### Index update

`src/tools/granular/index.ts` registers 18 tools (down from 35). Reordering reflects the new structure.

### Migration / compat

The runbook references tool names by string. Updating the runbook is mechanical:
- `update_location(...)` → `update_draft_section({ section: "location", data })`
- `add_co_agent(...)` → `add_participant({ role: "co_agent", data })`
- ...etc.

**Validation per merge:**
- One unit test per merged tool: assert each discriminator value routes to the correct underlying API method, with the same payload shape as before.
- Re-run all scenario tests; they should pass with no behavioral change.

---

## Phase 4 — Memory + prompt dedup (-550 LOC, ~half day)

### Memory consolidation

**Merge `bolt-field-matrix.md` (284) + `arrakis-system-model.md` (147) → `arrakis-reference.md` (~280)**. Both describe the field/state surface from different angles; one canonical reference is enough. Cut ~150 LOC of overlap.

### Prompt dedup

Hoist these into memory files (write once, reference from prompts):

- **"Principle zero: context routing" preamble** — appears verbatim in 5+ prompts. Already lives in `memory/context-routing.md`. Replace each prompt's full preamble with a 2-line "Read `memory/context-routing.md`" pointer. Save ~20 LOC × 5 prompts = ~100 LOC.
- **Banned-words list ("plain English only — banned: yenta_id, participantId, arrakis, bolt, ...")** — appears in 3 prompts. Hoist into `memory/transaction-rules.md` as a section. Save ~15 LOC × 3 = ~45 LOC.
- **Commission-math accuracy stack (G1–G7) explanation** — duplicated between `create_transaction.md` and `resume_draft.md`. Already lives in `memory/transaction-rules.md`. Drop the duplication; prompt says "see G1–G7 in `transaction-rules.md`." Save ~50 LOC × 2 = ~100 LOC.
- **`AskUserQuestion` doctrine ("MANDATORY — call the tool, not markdown")** — appears in 4 prompts. Hoist into a new `memory/ask-user-doctrine.md` (~30 LOC), reference from each. Save ~40 LOC × 4 minus 30 = ~130 LOC.

Auto-generated `.claude/skills/*/SKILL.md` files inherit all the cuts via `npm run build`. Effective LOC saved is ~2× (source + generated).

**Total source cut:** ~375 LOC + ~150 from memory merge = ~525 LOC. Generated mirror cut: another ~375 LOC. Combined ~900 LOC if counting auto-gen mirrors, ~525 if not.

---

## Phase 5 — Skill consolidation 9 → 6 (-300 LOC, ~half day)

Skills today: `create-transaction`, `create-listing`, `create-referral-payment`, `update-draft`, `resume-draft`, `submit-draft`, `delete-draft`, `list-drafts`, `sync-rules`.

### Merge `/create-listing` into `/create-transaction`

**Why.** `create_transaction.md` already documents the LISTING flow as a §"Seller-side with no listing yet" subsection. The two skills share infrastructure; the only real differences are step count (5 vs 11) and `type=LISTING` parameter. The runbook decides which branch by parsing intent.

**How.** `src/prompts/create_transaction.md` adds a §"LISTING flow" subsection (~40 LOC). Delete `src/prompts/create_listing.md` (122 LOC) and `.claude/skills/create-listing/SKILL.md` (auto-regenerated as needed by removing from `prompts/index.ts`).

The skill description keeps both trigger phrasings: "create transaction OR listing" → routes inside.

**Net:** -82 LOC source.

### Merge `/list-drafts` + `/delete-draft` + `/sync-rules` → `/drafts` admin skill

**Why.** All three are short administrative operations:
- `list-drafts` (68 LOC): runs `list_my_builders`, formats output.
- `delete-draft` (73 LOC): preview + DELETE.
- `sync-rules` (22 LOC): drift-check refresh.

A single `/drafts` skill with verbs (`list`, `delete <id>`, `sync-rules`) covers all three. Less surface, less routing ambiguity since the verb disambiguates.

**How.** New `src/prompts/drafts.md` (~80 LOC) replaces three files (163 LOC).
**Net:** -83 LOC source. Plus auto-gen mirror.

### Total Phase 5

~165 LOC source + ~165 LOC auto-gen = ~330 LOC, but the BIG win is reducing the slash-command surface from 9 to 6.

**Risk.** Existing user muscle memory (`/list-drafts`) breaks. Mitigation: in the new `/drafts` skill description, list the old phrasings as triggers ("when user types /list-drafts, /delete-draft, /sync-rules — those resolve to this skill").

---

## Phase 6 — Test + script trimming (-250 LOC, ~2h)

**Tests:**
- Delete `test/types/schemas.test.ts` (164 LOC). Tests zod's own behavior, which is upstream-tested.
- After Phase 3, drop tests for tools that were merged (the discriminator tests replace them). Net ~50 LOC.

**Scripts:**
- Merge `scripts/diagnose.sh` + `scripts/install-config.sh` + `scripts/smoke-mcp.sh` into a single `setup.sh` with verbs: `setup.sh install`, `setup.sh diagnose`, `setup.sh smoke`. Aligns with the existing memory rule "Setup must be one-shot." ~50 LOC saved + DX consolidation.

---

## Phase 7 — `src/services/` shrink (folded into Phase 3, listed for completeness)

`TransactionBuilderApi.ts` (433 LOC) shrinks to ~300 after Phase 3 merges adjacent endpoints into shared methods. `YentaAgentApi`, `ReferralPaymentApi`, `BaseApi` untouched.

**Net:** -130 LOC, no separate work.

---

## Phase 8 (OPTIONAL) — Radical: passthrough mega-tool (-1,500 more LOC, ~3 days)

**Pre-condition.** Phase 3 must have shipped and run for at least a week of real use, so we have telemetry on which tools actually get called.

### The collapse

Replace 18 tools (post-Phase 3) with 1 passthrough + 6 value-add tools:

**Passthrough (new):**
- `arrakis({ env, method, path, body?, multipart? })` — handles auth, axios call, status branching. ~60 LOC.

**Value-add (kept because they do something other than HTTP):**
- `compute_commission_splits` — server-side integer-cents math (G1).
- `verify_draft_splits` — server-side commission verification (G3).
- `validate_draft_completeness` — local deterministic validator (post-Phase 1, ~150 LOC).
- `validate_agents` — yenta lookup + status check.
- `pre_flight` — auth + zip lookup + identity caching.
- `search_agent_by_name` — yenta search with disambiguation.

**Total: 7 tools.** From 42 today → 7 = 83% surface cut.

### What goes away

- `src/tools/granular/init.ts`, `location.ts`, `participants.ts`, `referral.ts`, `commission.ts` (partial), `finalize.ts`, `read.ts`, `lifecycle.ts`, `delete_draft.ts`, `delete_participants.ts`, `post_submit.ts`, `discover.ts`, `auth_action.ts` — all collapse into one passthrough handler. ~1,200 LOC deleted.
- `src/services/TransactionBuilderApi.ts` shrinks to ~80 LOC (just typed helpers wrapping the passthrough; could be deleted entirely if we don't mind inline construction). ~300 LOC saved.

### What the runbook gains

A canonical "arrakis endpoint reference" section listing each path + method + body shape + response shape. ~80 LOC of reference docs.

### Honest costs

1. **No per-tool zod validation.** Today, malformed LLM input fails locally with a structured error. Tomorrow, it hits arrakis and we get a 400 with a prose error. Mitigation: arrakis errors are already mapped to plain-English in `memory/error-messages.md`; adding a "wrong shape at endpoint X" entry pattern is small.
2. **No MCP self-documentation.** `claude mcp list` becomes uninformative. Cosmetic — the runbook is the docs.
3. **Slightly higher cognitive load on the LLM** to construct the right `path` from the runbook reference. Modern LLMs do this well, but it's measurable.

### When to commit to it

Run Phase 3 for a real week. If the discriminator pattern is working smoothly and we don't see "tool-pick errors," Phase 8 is the natural next step. If we see frequent confusion between discriminator values, stop at Phase 3 — passthrough would be worse, not better.

---

## Final state

| Layer | Before | After phases 0–6 | After phase 8 |
|---|---|---|---|
| Granular MCP tools | 35 | 18 | 6 + passthrough |
| Convenience MCP tools | 7 | 2 | 2 |
| Skills | 9 | 6 | 6 |
| Memory files | 10 | 9 | 9 |
| Repo LOC | 10,857 | ~6,500 | ~5,000 |
| Cut % | 0 | 40% | 53% |

---

## Validation strategy across all phases

**Per phase:**
1. Run `npm test` (existing scenarios + new ones added per phase).
2. Run `npm run test:contract` (after Phase 0; any phase that changes the wire layer re-runs).
3. Manual: drive a happy-path `/create-transaction` end-to-end against team1 with a complete prompt; assert zero `AskUserQuestion` calls + draft created.

**Post all phases:**
- 5 representative prompts (BUYER simple, SELLER with listing, DUAL, referral payment, listing-only) drive end-to-end. Round-trip count must be ≤ today's count.

---

## Sequencing rules

- **0 always first.** Without the empty-field probe we don't know if Phase 1 ships as-planned or with placeholders.
- **1 before 2.** Phase 2 deletes the convenience layer; the runbook needs to be the orchestrator first (Phase 1 changes runbook structure to support this).
- **3 before 8.** Phase 8 is opt-in based on Phase 3 telemetry.
- **4, 5, 6 are independent** of each other and of 1–3. Could be done in parallel or paused without affecting the others.

## Estimated effort

- Phases 0–6: ~5–7 working days total (one engineer).
- Phase 8: ~3 working days, but only after a week of Phase 3 real-use observation.

## Open decisions

1. **Discriminator naming convention.** `section` vs `kind` vs `type` — pick one and use across all merged tools. Recommend `kind` (`type` collides with TS `type` keyword in some IDEs; `section` is too literal).
2. **Skill rename for the merged admin skill.** `/drafts` is short but ambiguous with `/list-drafts` muscle memory. Alternative: `/draft-admin`.
3. **Whether to ship Phase 4 prompt-dedup AS PART of Phase 1** (since Phase 1 rewrites parts of `create_transaction.md` anyway) or separately. Bundling means one big runbook PR; separating means two smaller, easier-to-review PRs. Recommend separate.

## Compounds with

`PLAN-create-transaction-fast-path.md` IS Phase 1. The contract-ingestion idea (May Challenge) sits on top of all this; it becomes much easier to add when there's a passthrough or even just consolidated section writers.

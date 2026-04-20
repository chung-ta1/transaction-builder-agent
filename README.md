# transaction-agent

**Create transactions, listings, and referrals in Real by describing them in plain English.** Instead of clicking through Bolt's multi-step wizards, you type what the deal looks like and Claude builds the draft. You review in Bolt and submit — you're always in control of the final click.

## What's supported

| Flow | What it does | Bolt equivalent |
|---|---|---|
| `/create-transaction` | Draft a sale or lease — buyer-side, seller-side, or DUAL. Seller-side auto-chains listing → submit → transition → transaction. | "Add Transaction" |
| `/create-listing` | Draft a standalone listing (no buyer yet). | "Add Listing" |
| `/create-referral-payment` | Record a referral fee or Non-Referral Payment (termination fee, BPO, spiff, …) as its own transaction on Real's books. | "Create Referral / Payment" |
| `/list-drafts` | Show every in-flight draft (transactions + listings you haven't submitted yet). | "Drafts" tab |
| `/resume-draft` | Pick up a half-finished draft and fill what's missing without clobbering what's already right. | — |
| `/update-draft` | Edit a specific field on an existing draft (price, commission, team, participants, dates, …). | Editing inside the draft |
| `/submit-draft` | Promote a draft to a live Transaction (or a Listing to `LISTING_ACTIVE`). Always preceded by a preview. | "Create Transaction" / "Create Listing" button |
| `/delete-draft` | Permanently delete an unsubmitted draft from arrakis. | Delete from drafts list |
| `/sync-rules` | Force a fresh rebuild of the arrakis rulebook from source (usually automatic — you rarely need this). | — |

In practice you don't type any slash — Claude recognizes natural phrasing ("create a transaction for…", "new listing at…", "record a $500 termination fee…") and picks the right flow.

## Claude Desktop vs Claude CLI

Both work. **Claude CLI is what we recommend** for the smoothest experience:

- Slash commands and skills are first-class in CLI (`/create-transaction`, `/resume-draft`, etc.).
- **Bypass-permissions mode in CLI collapses the usual "Create this?" gate into a single-turn preview-then-fire** — the preview is the review step; if anything looks wrong you interrupt with `Esc` before the tool call lands.
- Memory files under `~/.claude/projects/.../memory/` persist across sessions so the agent learns your defaults (typical env, typical team, typical year built, `learned_agents` cache for partners / referrals, recent MLS numbers) and stops re-asking.

Claude Desktop works too — flows and previews render the same way; the only differences are (a) slash commands come from the `+` menu rather than typing `/`, and (b) confirmation gates appear as clickable buttons instead of being skipped via bypass-permissions.

## First-time setup (once, ~1 minute)

> **Need Claude?** Get the [Claude CLI](https://docs.claude.com/en/docs/claude-code/overview) (recommended) or [Claude Desktop](https://claude.ai/download).
>
> **Need Node.js?** Install the LTS version from [nodejs.org](https://nodejs.org).

### With git

```bash
git clone https://github.com/chung-ta1/transaction-agent.git
cd transaction-agent
./setup.sh
```

### Without git

1. Open [github.com/chung-ta1/transaction-agent](https://github.com/chung-ta1/transaction-agent).
2. **Code ▾** → **Download ZIP**.
3. Unzip. **Move the folder out of `Downloads`** — e.g., `~/Documents`, `~/projects` — before running setup. If you leave it in Downloads and clean that up later, Claude loses the MCP registration.
4. Terminal:
   ```bash
   cd ~/Documents/transaction-agent-main && ./setup.sh
   ```

`setup.sh` installs deps, builds the MCP, registers it with Claude, and verifies the schema shape. **Restart Claude** once it finishes.

If you ever move the folder, re-run `./setup.sh` from the new path.

## The happy path (one turn, if you give enough detail)

**You type:**

> *"$200k sale at 120 Main St NYC 10022, $5,000 commission, I'm the listing agent, NY Pro Team."*

**Claude emits one response:**

```
Here's what I read — confirm anything wrong:

  ✓ Env:                 team1
  ✓ Sale price:          $200,000 USD
  ✓ Sale commission:     $5,000 FLAT (not 2.5% of $200k) — tell me if I should treat this as a percent
  ✓ Property:            120 Main St, New York, NY 10022
  ✓ Representation:      Seller's agent
  ✓ Team:                NY Pro Team → b3682e33 (cached)
  ✓ Year built:          2020 (from typical_year_built cache)
  ~ Seller:              Unknown Seller (default — edit in Bolt if you know the name)
  ~ Buyer:               Unknown Buyer (default for seller-side)
  ~ Listing → transaction chain: create listing → submit → build transaction → finalize (autonomous)
```

…followed immediately by the tool calls, then:

```
Transaction — team1 · builder 64b1deb3
Property:            120 Main St, New York, NY 10022
Sale price:          $200,000 USD
Listing commission:  $5,000 (flat)
Split:               you 100% = $5,000
```

> **Review and submit:** https://bolt.team1realbrokerage.com/transaction/create/64b1deb3…

No intermediate "Create this?" click, no separate preview turn. The preview IS the review; you interrupt with `Esc` if something looks wrong.

When arrakis returns warnings (team pre-cap fees, ledger errors, unusual lifecycle states), they surface with 🚨 or ⚠️ **above** the URL so you don't discover them after opening Bolt.

## When the agent asks questions

Only three kinds of questions — everything else gets defaulted with a `~` marker in the summary:

1. **Money interpretation at the boundary.** *"Commission of 5% — did you mean $5,000 total all yours, or $10,000 (listing 5% + sale 5%)?"* — because financial misreads are expensive to fix later.
2. **Classification when the prompt is silent.** *"Is this a traditional External Referral or a Non-Referral Payment (termination fee, BPO, spiff)?"*
3. **Identity when ambiguous.** *"Your prompt says 'Team1' — did you mean the team named `Team1`, or the env `team1`?"*

For seller/buyer names, dates, property type, other-side agent, commission payer — Claude defaults and marks with `~`. If the default is wrong, correct it in Bolt or tell Claude to re-do.

## Examples by flow

Everything below works as plain natural language in Claude. No slash required.

### Sale — buyer-side

> *"Create a transaction: I'm the buyer's agent, $500k sale at 123 Main St NYC 10025, 3% commission, my partner Tamir splits 60/40 with me."*

Partner "Tamir" resolves from the `learned_agents` cache (in `user-patterns.md`) on second use — no name search round-trip.

### Sale — seller-side

> *"Sold a property at 120 Main St NYC 10022 for $200k. My commission is $5,000. I'm on NY Pro Team."*

Seller-side auto-chains: listing → submit → build-transaction-from-listing → finalize. About 8 arrakis calls, narrated as progress.

### Dual rep

> *"Build a transaction: $750k DUAL rep sale at 500 Oak Ave Dallas TX 75201, 6% commission."*

### Lease (Canada)

> *"New draft: lease, $2,400/month, 150 King St W Toronto M5H 1J9, tenant side."*

Currency auto-resolves to CAD from the postal code.

### Listing (standalone, no transaction yet)

> *"Create a listing for 742 Evergreen Terrace Springfield IL 62701, $450k, 5% listing commission, 90-day term."*

Produces a LISTING_ACTIVE draft you can later convert to a transaction via seller-side `/create-transaction`.

### Referral payment — External Referral

> *"Record a $2,500 referral payment from Jane Smith at Keller Williams Downtown, client Michael Brown, expected close May 30 2026."*

One POST to arrakis' `referral-and-disburse`; returns the live Transaction URL.

### Referral payment — Non-Referral Payment (BPO / termination / spiff)

> *"Record a $500 termination fee from test agent at Other Brokerage LLC, for a listing that was terminated early."*

Same endpoint, with `classification: OTHER`. Claude detects the sub-reason ("termination fee") and puts it in the record's comments. If your Pro Team has a pre-cap fee that exceeds this payment (common gotcha for small-dollar Non-Referral Payments), Claude surfaces the ledger warning prominently.

### Resume an in-flight draft

> *"Resume the last draft."*

Claude calls `list_my_builders` to find the most recent in-progress draft, fetches its current state, computes what's missing, asks only for those fields, and finalizes.

### Switch env for one run

> *"Create a draft on play: …"*

Or explicitly: `/create-transaction --env play …`. Never offered: prod. Production is permanently blocked.

### Force a fresh rulebook rebuild

> *"Sync the rules."*

You rarely need this — the skill auto-checks arrakis for rule drift at the start of every flow.

## What makes it smooth (behind the scenes)

- **Memory files** (`memory/*.md`) learn your defaults — typical env, typical office, typical year built, teams you're on, `learned_agents` (name/alias → yentaId for partners and referrals), recent MLS numbers. On run #2 onward, most questions just don't happen.
- **Aggressive post-auth prewarming** — when the MCP starts, it validates every cached env token against yenta in parallel so the first `verify_auth` call in your session is instant.
- **Validator-driven gap detection** — `validate_draft_completeness` is a pure function returning deterministic `{ready, gaps, defaults, blockers}`. Claude doesn't reason about requirements; it calls the validator.
- **Commission math in integer cents** — `compute_commission_splits` handles money. LLMs don't. The post-write `verify_draft_splits` guard fails loud if anything drifted.
- **Post-submit warning surfacer** — every arrakis response is scanned for `errors[]`, `builderErrors[]`, `transactionWarnings[]`. Problems appear above the URL with 🚨 / ⚠️, never buried.
- **Single source of truth for runbooks** — the skill markdown in `src/prompts/*.md` is generated into `.claude/skills/*/SKILL.md`. Editing a runbook in one place updates everywhere.

## Safety

- **Production is permanently blocked.** This tool only works against `team1`–`team5`, `play`, and `stage`.
- **Your password never touches Claude.** Sign-in goes through your normal Real login page on `http://127.0.0.1:<port>`; Claude only sees the bearer token, and it stays on your machine (OS keychain + in-memory cache).
- **Claude never submits the final draft for you.** The Submit click in Bolt is always yours. For `/create-referral-payment` (which has no arrakis draft stage), the preview in chat is the review step — you can interrupt with `Esc` before the tool call.
- **Switching users is explicit.** If you've logged in as one agent and now need to be another, say *"I'm not pwadmin, I'm chung.ta"* or run `/sign_out`. Claude wipes the cached token and re-triggers browser login. Never assume the previous user is still the current user.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"The transaction-builder tools aren't loaded"* | MCP didn't finish its handshake. Fully quit Claude (⌘Q, not close-window), relaunch. CLI: `/exit` then `claude`. |
| Browser login tab didn't open | Claude prints the URL in chat. Click it to sign in. |
| Wrong user cached (you're pwadmin but chung.ta's token is active) | Say *"I'm not {cached name}"* or run `/sign_out` for the current env. Next call opens a fresh login. |
| Team dropdown blank in Bolt after submit | Your prompt didn't name a team, or `user-patterns.md:teams[]` hadn't been cached yet. Re-run saying *"on {teamName}"* — Claude will resolve and patch. |
| Ledger error *"team fees of USD X"* after create | Your team's pre-cap fee exceeds this draft's commission. Common for Pro Team members on small-dollar Non-Referral Payments. Fix in Bolt or pick a non-team owner. |
| Anything else | `./scripts/smoke-mcp.sh` from the repo validates the tool is healthy. If it passes, restart Claude. |

## Keeping in sync with Real

Every flow starts with a drift-check against `github.com/Realtyka/arrakis`. If arrakis's watched paths changed since the last sync (`memory/arrakis-pin.md`), Claude updates `memory/transaction-rules.md` and advances the pin before running your flow. Adds ~half a second when nothing has changed.

---

## For contributors

- `src/prompts/*.md` — single source of truth for all skill runbooks.
- `src/tools/` — granular tools (one per arrakis endpoint) + convenience tools (compositions).
- `src/util/draftRequirements.ts` — validator.
- `memory/` — agent playbook (committed): `transaction-rules.md`, `context-routing.md`, `arrakis-system-model.md`, `arrakis-pin.md`, `error-messages.md`, `post-submit-warnings.md`, `bolt-field-matrix.md`. Per-user state (`user-preferences.md`, `user-patterns.md`) is gitignored and bootstrapped from `*.md.template` on first `setup.sh` run.
- `test/` — vitest unit + scenario tests (97 passing as of this writing).
- `npm run build` → regenerate `.claude/skills/` wrappers from `src/prompts/*.md`, then `tsc`. No OpenAPI codegen; arrakis types are hand-synced.
- `scripts/smoke-mcp.sh` — spawns the MCP over stdio and validates `tools/list` returns no `$ref`, no `$schema`, all roots `type: "object"`.

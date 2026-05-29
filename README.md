# transaction-builder-agent

**Create transactions, listings, and referrals in Real by describing them in plain English.** You type what the deal looks like, Claude builds the draft, you review in Bolt and submit.

## Skills

| Flow | What it does | Bolt equivalent |
|---|---|---|
| `/create-transaction` | Draft a sale or lease — buyer-side, seller-side, or DUAL. Seller-side auto-chains listing → submit → transition → transaction. | "Add Transaction" |
| `/create-listing` | Draft a standalone listing (no buyer yet). | "Add Listing" |
| `/create-from-document` | Create a transaction or listing from a PDF **or image** (screenshot/photo) of a listing agreement, sale contract, or buyer-rep agreement. Extracts only filled-in terms, never fabricates blanks, confirms, then runs the matching create flow. | — |
| `/create-referral-payment` | Record a referral fee or Non-Referral Payment (termination, BPO, spiff). | "Create Referral / Payment" |
| `/list-drafts` | Show every in-flight draft. | "Drafts" tab |
| `/update-draft` | Edit a field on an existing draft (price, commission, team, participants, dates) or resume the most-recent unfinished draft and fill gaps. | Editing inside the draft |
| `/submit-draft` | Promote a draft to a live Transaction / `LISTING_ACTIVE`. | "Create Transaction" button |
| `/delete-draft` | Permanently delete an unsubmitted draft. | Delete from drafts list |

No slash required — Claude recognizes natural phrasing ("create a transaction for…", "list-drafts", ...) and routes to the right skill.

## First-time setup (~1 minute)

> Need Claude? [Claude CLI](https://docs.claude.com/en/docs/claude-code/overview) (recommended) or [Claude Desktop](https://claude.ai/download). Need Node.js? Install **18+** (LTS) from [nodejs.org](https://nodejs.org).

```bash
git clone https://github.com/chung-ta1/transaction-builder-agent.git
cd transaction-builder-agent
./setup.sh
```

**Restart Claude** once `setup.sh` finishes. If you move the folder, re-run it.

> **You must be on the Real VPN.** `setup.sh` runs fully offline, but sign-in and every create call reach internal hosts (keymaker, arrakis, yenta). Off-VPN, setup succeeds but the first sign-in/create fails to connect.

## Examples

### Single deal

You type:

> *"create a transaction where a property is sold for $200k located at 120 Main St NYC 10022, $5,000 commission, I'm the listing agent, NY Pro Team."*

Claude emits a `✓`/`~` parse summary (✓ = read from your message, ~ = defaulted), fires the arrakis calls, and returns a Bolt draft URL. The preview IS the review — interrupt with `Esc` if anything looks wrong. Warnings (team pre-cap fees, ledger errors) surface with 🚨 / ⚠️ above the URL.

A submitted transaction goes live but may land in **`NEW`** until a **commission payer** (the title company / disbursing party) is set — give Claude the payer details up front and it wires them, or add it in Bolt afterward. Same for naming the actual buyer/seller (defaulted to placeholders).

### From a PDF or image

Attach a listing agreement, sale contract, or buyer-rep agreement — as a PDF, screenshot, or photo — and say:

> *"Create a transaction from this."* (attach `Listing_Agreement.pdf`)

Claude reads the document itself (no OCR setup needed), extracts **only the filled-in terms** — never inventing values for blank fields — and shows an extraction summary tagged ✓ (from the doc) / ⚠ (blank, will ask). It confirms the representation side and any missing required fields (e.g. a blank list price or commission), then runs the normal create flow. The agent named on the document is informational only — **you** (the signed-in user) own what's created.

## Safety

- **Production is permanently blocked.** Only `team1`–`team5`, `play`, `stage`.
- **Your password never touches Claude.** Sign-in goes through Real's login on `127.0.0.1:<port>` (same-origin POST only — cross-site requests are rejected); only the bearer token reaches the tool. The token is cached in a `0600`-mode file under `~/.transaction-builder-agent/` (plus the macOS keychain as a best-effort second tier).
- **Switching users is explicit.** Say *"I'm not {cached name}"* or *"clear my credential"* to wipe the cached token and force a fresh sign-in.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"The transaction-builder tools aren't loaded"* | Fully quit Claude (⌘Q), relaunch. CLI: `/exit` then `claude`. |
| Browser login tab didn't open | Claude prints the URL in chat — click it. |
| Wrong user cached | *"I'm not {cached name}"* or *"clear my credential"* — wipes the token and re-prompts sign-in. |
| Team dropdown blank in Bolt | Re-run saying *"on {teamName}"* — Claude resolves and patches. |

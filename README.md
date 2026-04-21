# transaction-builder-agent

**Create transactions, listings, and referrals in Real by describing them in plain English.** You type what the deal looks like, Claude builds the draft, you review in Bolt and submit.

## Skills

| Flow | What it does | Bolt equivalent |
|---|---|---|
| `/create-transaction` | Draft a sale or lease — buyer-side, seller-side, or DUAL. Seller-side auto-chains listing → submit → transition → transaction. | "Add Transaction" |
| `/create-listing` | Draft a standalone listing (no buyer yet). | "Add Listing" |
| `/create-referral-payment` | Record a referral fee or Non-Referral Payment (termination, BPO, spiff). | "Create Referral / Payment" |
| `/list-drafts` | Show every in-flight draft. | "Drafts" tab |
| `/resume-draft` | Pick up the most-recent unfinished draft and fill gaps. | — |
| `/update-draft` | Edit a field on an existing draft (price, commission, team, participants, dates). | Editing inside the draft |
| `/submit-draft` | Promote a draft to a live Transaction / `LISTING_ACTIVE`. | "Create Transaction" button |
| `/delete-draft` | Permanently delete an unsubmitted draft. | Delete from drafts list |
| `/sync-rules` | Force-rebuild the arrakis rulebook from source (rarely needed). | — |

No slash required — Claude recognizes natural phrasing ("create a transaction for…", "resume the last draft", "record a $500 termination fee…") and routes to the right skill.

## First-time setup (~1 minute)

> Need Claude? [Claude CLI](https://docs.claude.com/en/docs/claude-code/overview) (recommended) or [Claude Desktop](https://claude.ai/download). Need Node.js? Install the LTS version from [nodejs.org](https://nodejs.org).

```bash
git clone https://github.com/chung-ta1/transaction-builder-agent.git
cd transaction-builder-agent
./setup.sh
```

**Restart Claude** once `setup.sh` finishes. If you move the folder, re-run it.

## Example

You type:

> *"$200k sale at 120 Main St NYC 10022, $5,000 commission, I'm the listing agent, NY Pro Team."*

Claude emits a `✓`/`~` parse summary (✓ = read from your message, ~ = defaulted), fires the arrakis calls, and returns a Bolt draft URL. The preview IS the review — interrupt with `Esc` if anything looks wrong. Warnings (team pre-cap fees, ledger errors) surface with 🚨 / ⚠️ above the URL.

## Safety

- **Production is permanently blocked.** Only `team1`–`team5`, `play`, `stage`.
- **Your password never touches Claude.** Sign-in goes through Real's login on `127.0.0.1:<port>`; only the bearer token reaches the tool, and it stays in your OS keychain.
- **Switching users is explicit.** Say *"I'm not pwadmin"* or run `/sign_out` to wipe the cached token.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"The transaction-builder tools aren't loaded"* | Fully quit Claude (⌘Q), relaunch. CLI: `/exit` then `claude`. |
| Browser login tab didn't open | Claude prints the URL in chat — click it. |
| Wrong user cached | *"I'm not {cached name}"* or `/sign_out`. |
| Team dropdown blank in Bolt | Re-run saying *"on {teamName}"* — Claude resolves and patches. |

# transaction-agent

**Create a draft transaction in Real by describing it in plain English.** Instead of clicking through the 10-step onboarding wizard, you type what the deal looks like and Claude fills in the draft for you. You review the finished draft in Real and submit — you're always in control.

---

## What it looks like

Type this in Claude:

> *"Create a transaction with $20,000 gross commission for me and my partner Tamir. I am 60%, he's 40%. The address is 123 Main Street, New York, NY 10025."*

Claude asks a few clarifying questions (if needed), shows you this preview with every dollar spelled out:

```
Draft summary — team1

Property:           123 Main Street, New York, NY 10025
Deal type:          Sale
Sale price:         $500,000.00 USD 
Sale commission:    4.00% of sale = $20,000.00   (the full pot, before splits)

Who gets what:
  You  (buyer's agent)    $12,000.00    60%
  Tamir Malchizadi         $8,000.00    40%
  -------------------------------------------
  Total                   $20,000.00   100%   ✓ adds up

Commission paid by:  Title company   (default for US sales)

(Click "Create this draft" to proceed, or "Change something" to adjust.)
```

You click **Create**, Claude builds the draft, and hands you a link to review in Real.

---

## First-time setup (once, ~1 minute)

> **Need Claude?** Get [Claude Desktop](https://claude.ai/download) (Mac/Windows) or install the [Claude CLI](https://docs.claude.com/en/docs/claude-code/overview).
>
> **Need Node.js?** Install the LTS version from [nodejs.org](https://nodejs.org).

### If you have git

```bash
git clone https://github.com/chung-ta1/transaction-agent.git
cd transaction-agent
./setup.sh
```

### If you don't have git (no installation needed)

1. Open [github.com/chung-ta1/transaction-agent](https://github.com/chung-ta1/transaction-agent) in your browser.
2. Click the green **Code ▾** button → **Download ZIP**.
3. Unzip the file (double-click it on macOS). You'll get a folder called `transaction-agent-main`.
4. Open Terminal (Spotlight → "Terminal").
5. Type `cd ` (with a trailing space, **don't press Enter yet**):
   ```
   cd 
   ```
6. Drag the `transaction-agent-main` folder from Finder onto the Terminal window. This pastes its full path after `cd `. **Now press Enter.**
7. Run the setup:
   ```bash
   ./setup.sh
   ```

That's it. `setup.sh` installs everything, builds the tool, and registers it with Claude in one go. Then **restart Claude**.


---

## How to use it

In any Claude chat, just describe the deal in plain English — you don't need slash commands or any special syntax. For example:

> *"Create a transaction with $20,000 commission sale, I'm the buyer's agent, my partner Tamir splits 60/40 with me, 123 Main St NYC 10025."*

Claude recognizes phrases like *"create a transaction"*, *"new draft"*, or *"build me a transaction"* and kicks off the flow automatically.

*(Power-user shortcut: `/create-transaction <describe your deal>` invokes the skill explicitly if you prefer.)*

Claude will:

1. **Ask which environment** (team1, team2, play, etc.) the first time — it remembers your pick afterwards.
2. **Pop open your browser for you** to sign in to Real the first time it needs authentication — a new tab appears with a Real login page. Your password manager should auto-fill. One Enter press and the tab closes itself. (You don't have to open the browser manually.)
3. **Ask clarifying questions** if anything in your prompt was unclear (internal vs. external referral, commission payer, etc.) — batched, up to four questions at once.
4. **Show you a preview** of the draft with every participant and every dollar amount before writing anything to Real.
5. **Wait for your OK** before creating the draft. If the commission math had to be rescaled (because your numbers added up to more than 100%), Claude requires you to type `confirm` — not just click — as an extra check.
6. **Hand you a link** to the new draft in Real. You review and submit it there.

### Examples

All of these work as plain sentences in a Claude chat — no slash command needed.

**A sale with a partner:**
> *"Create a transaction: $20k commission, sale, I'm the buyer's agent, my partner Tamir and I split 60/40, 123 Main St NYC 10025."*

**Dual representation** (you represent both sides):
> *"Build me a transaction: $50k dual rep sale, I'm on both sides, 500 Oak Ave Dallas TX 75201."*

**A lease in Canada:**
> *"New draft: lease, $2,400/month in Toronto, 150 King St W M5H 1J9, tenant side."*

**Switch environments for one run:**
> *"Create a draft on play: ..."* — or use the power-user form `/create-transaction --env play ...`

**Refresh the rules** after a long time away or if something feels off:
> *"Sync the rules."* — or `/sync-rules` explicitly.

---


## Safety

- **Production (the live site at `therealbrokerage.com`) is permanently blocked.** This tool only works against `team1`–`team5`, `play`, and `stage`.
- **Your password never appears in Claude.** You sign in through your browser's normal login page on `http://127.0.0.1:<port>`; the token Claude uses is captured automatically and stays on your machine.
- **Claude never submits the draft for you.** The final submit is always a click in the Real UI — your review is mandatory.

---

## If something goes wrong

Claude translates most errors into plain English and suggests a fix. A few situations you might hit:

| What you see | What to do |
|---|---|
| Claude says your office or profile is missing something in Real | Ask your broker to fix it in Real, or try a different environment. |
| Claude keeps asking you for details | That's by design — answer them; your answers are cached for next time. |
| The browser login tab didn't open | Claude will print the URL in the chat. Click it to sign in. |
| Anything else | Ping whoever set this up for you. |

---

## Keeping it in sync with Real

**You don't need to do anything.** Every time you start a new transaction, Claude checks Real's source for changes first. If Real's logic has moved, Claude updates its rulebook before building your draft — so every draft uses the latest rules. The check adds under half a second when nothing has changed.

If you'd rather force a full fresh rebuild of the rulebook (e.g. after a big Real release), just say:

> *"Sync the rules."*

Or use the explicit command `/sync-rules`.

---


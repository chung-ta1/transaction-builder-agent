# context-routing

**All decisions are made from context, not keywords.** This file is the shared doctrine every skill reads before routing intent. Load it at the start of every flow (transaction, listing, referral, update, submit, delete, list, resume).

## The precedence order for interpreting user intent

Read in this order and stop at the first decisive signal:

1. **Current session focus.** What draft / transaction / listing are we actively discussing in the last 1–3 turns? If the user's message is ambiguous but references "this", "that draft", "it", or a verb adjacent to the current focus — the focus is the subject.
2. **Explicit identifiers.** A UUID or short-hash (`64b1deb3`, `64b1deb3-b4e8-…`) in the prompt. Overrides session focus.
3. **Recent history from `memory/active-drafts.md`.** The most recent `create` / `update` rows within the last 48 hours. "The last draft", "my recent draft", "the $200k one" all resolve against this.
4. **Learned patterns from `memory/user-patterns.md`.** Typical env, typical team, typical year built, typical representation side, frequent partners. Use for silent defaulting, never for conflict resolution.
5. **Prompt keywords.** Last resort. If nothing above resolves, fall back to literal phrase matching.

When steps 1–3 conflict with step 5 — **steps 1–3 win.** Keywords lie; context is ground truth.

## Canonical ambiguity examples and their resolutions

### "create transaction" (or variants: "create", "finalize", "make it")

| Context | Resolution | Skill |
|---|---|---|
| Active draft under discussion in last 3 turns | Submit that draft | `/submit-draft` |
| Bolt "Create Transaction" button mentioned in the same session | Submit that draft (button = submit) | `/submit-draft` |
| Fresh session, no draft in `active-drafts.md` <48h | Create a new draft | `/create-transaction` |
| Fresh session, but `active-drafts.md` has a matching draft (address/amount match) | ASK once: "Submit existing or create new?" | — |
| Prompt explicitly says "a new transaction" / "another one" / "fresh draft" | Create new, regardless of context | `/create-transaction` |
| Prompt explicitly says "submit" / "send" / "ship" / "finalize" | Submit, regardless of context | `/submit-draft` |

### "update" / "change" / "modify"

| Context | Resolution |
|---|---|
| Active draft in focus + mutation verb | `/update-draft` on focused draft |
| Explicit builderId | `/update-draft` on that id |
| "Resume the draft" / "pick up where I left off" | `/resume-draft` (fills gaps, not arbitrary edits) |
| No focus + no id + no recent drafts | ASK which draft |

### "delete" / "cancel" / "throw away"

| Context | Resolution |
|---|---|
| DRAFT in focus | `/delete-draft` |
| SUBMITTED transaction in focus | `request_termination` (different operation — arrakis can't delete submitted records) |
| "Cancel the session" / "never mind" | Abort current flow, not a data mutation |

### "the referral" / "add a referral"

| Context | Resolution |
|---|---|
| Active transaction draft in focus | `add_referral` (line item on that draft) |
| Fresh session + "post a referral" / "find an agent for my client" | `/create-referral` (marketplace) |
| Fresh session + "record a referral payment" / termination-fee / BPO signals | `/create-referral-payment` |

### "my partner {name}"

| Context | Resolution |
|---|---|
| `user-patterns.md:frequent_partners` has exact-match `first_name + last_name` <30d fresh | Use cached yentaId silently |
| Nickname hit in cache | **DANGER** — nicknames can be wrong (see Tamir/Chugn incident). Re-verify via `search_agent_by_name` before using. |
| No cache hit | `search_agent_by_name` |

### "team1" / "Team1" / "my team"

| Context | Resolution |
|---|---|
| env already resolved AND prompt mentions `teamN` | Team-membership reference, resolve via `user-patterns.md:teams[]` |
| env NOT resolved AND prompt is the only signal | ASK (env-vs-team-name collision) |
| `user-patterns.md:typical_team_id` set AND prompt says nothing | Use silently |
| "my team" / "the team" + active draft | Use the draft's current `teamId` (no change) |

### "year built" / "MLS" / "price" / other fields

| Context | Resolution |
|---|---|
| Value in prompt | Use it |
| Value in active draft (user's updating it) | Keep unless prompt changes it |
| `typical_year_built` / `recent_mls_numbers[0]` cached | Offer as FIRST AskUserQuestion option |
| Nothing anywhere | Ask |

## The "ask when and only when" rule

Ambiguity that warrants an `AskUserQuestion`:

1. **Money interpretation at a boundary.** "$5,000 commission on $200k sale" — flat or 2.5%? Ask.
2. **Classification when silent.** REFERRAL vs OTHER (Non-Referral Payment) when the prompt gives zero signal either way.
3. **Identity collision.** Two people with the same first name in `search_agent_by_name` results; `team1` when env isn't resolved; a user prompt like "I'm not pwadmin".
4. **Destructive action with ambiguous target.** "Delete the draft" when multiple drafts match.
5. **Create-vs-submit ambiguity.** Fresh session + prompt matches an existing draft in `active-drafts.md`.

Ambiguity that does NOT warrant a question:

- "Should I proceed?" / "Want me to continue?" — **never** (bypass-permissions mode; preview is the review step).
- "What year was the property built?" when `typical_year_built` is cached — default and mark `~`.
- "Who's the seller?" on buyer-side — default "Unknown Seller", mark `~`.
- "Which team?" when `typical_team_id` is cached — use silently.

## Output pattern when context resolves the decision

Surface the routing decision explicitly in the parse summary, so the user can catch a bad read before it writes:

```
Routing: /submit-draft on 64b1deb3 (active draft from last turn)
```

or

```
Routing: /create-transaction (fresh session, no active drafts)
```

or when ambiguous:

```
I see two possible reads:
  1. Submit the existing draft 64b1deb3 (120 Main St, $200k — you just discussed this)
  2. Create a new transaction draft

Which one? [asks via AskUserQuestion]
```

## Why this matters

Keyword-based routing failed us at least three times in the initial build:

1. `"team1"` parsed as env when the user meant the team named Team1.
2. `"create a referal"` parsed as create-new when the user wanted to submit an existing draft in the session.
3. `"Tamir"` nicknamed a different yenta user; keyword hit resolved wrong.

Context-based routing closes all three. The rule is simple: **if you can answer "what's the user looking at / holding / just mentioned?" you should use that answer before the prompt's words.**

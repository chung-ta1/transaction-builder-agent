Refresh the rulebook the `transaction-creator` agent uses. Normally the agent runs a drift-check on every draft creation — this skill forces a full rebuild from scratch.

## Principle zero: context routing (load `memory/context-routing.md`)

This is an infrastructure / admin flow, not a draft flow. Triggers only on explicit "sync the rules" / "refresh the logic" / "rebuild the rulebook" phrasing. Do NOT route here for ambiguous intent.

## What to do

1. Read `memory/arrakis-pin.md` to get the list of watched files and the default branch of `github.com/Realtyka/arrakis`.
2. For each watched path, fetch the latest content via `gh api` (e.g. `gh api repos/Realtyka/arrakis/contents/{path}?ref={default-branch}`).
3. Re-derive every section of `memory/transaction-rules.md` whose bullets carry the `<!-- auto:arrakis-pin:{sha} -->` tag. Rewrite those bullets to match the current source. **Leave untagged (hand-written) bullets alone.**
4. Update `memory/arrakis-pin.md` with the new `last-synced-sha` and `last-synced-at`.
5. Write a short summary of what changed to the chat — e.g. "3 files touched, added `new_validation_rule` to Commission section, no deletions."

If you encounter a novel concept in the source that doesn't fit any existing section — a brand-new validator, a new endpoint, etc. — stop and ask the user via `AskUserQuestion` where it should go rather than guessing.

If `gh` can't reach GitHub, say so and stop.

## What not to do

- Do not modify `memory/transaction-rules.md` bullets that don't have an `auto:arrakis-pin` tag — those are hand-written.
- Do not silently delete rules. Renames/removals become `DEPRECATED` bullets with the date.
- Do not touch `memory/active-drafts.md`.

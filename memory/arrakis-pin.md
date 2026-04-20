# arrakis pin

Tracks the SHA of `github.com/Realtyka/arrakis` that `memory/transaction-rules.md`
was last synced against. The agent runs a drift-check against this pin on every
`/create-transaction` invocation, and updates the rulebook (and the pin) only
when watched paths have actually changed.

```yaml
last-synced-sha: 162df3e17df5207eb84d25c152a3ee78c37b1445
last-synced-at: 2026-04-16
default-branch: master
watched-paths:
  - arrakis-api/src/main/java/com/real/arrakis/api/controller/TransactionBuilderController.java
  - arrakis-core/src/main/java/com/real/arrakis/commons/request/transaction/builder/
  - arrakis-core/src/main/java/com/real/arrakis/service/TransactionBuilderService.java
  - arrakis-core/src/main/java/com/real/arrakis/domain/validators/
  - arrakis-core/src/main/java/com/real/arrakis/domain/transaction/builder/
```

The agent uses:

```bash
gh api repos/Realtyka/arrakis/compare/{last-synced-sha}...master --jq '.files[].filename'
```

to produce the list of changed files since the pin, and intersects with
`watched-paths` (prefix match for directory entries).

**Write rule — only mutate this file when drift is processed.** Empty intersection
⇒ no drift, do nothing (don't bump any timestamp). Non-empty ⇒ fetch per-file
diffs, summarize rule-relevant changes, auto-edit `memory/transaction-rules.md`,
advance `last-synced-sha` and `last-synced-at`. Keeping writes to drift-only
events means this file rarely changes in commits → no per-user merge conflicts.

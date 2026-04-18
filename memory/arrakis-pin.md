# arrakis pin

Tracks the SHA of `github.com/Realtyka/arrakis` that `memory/transaction-rules.md`
was last synced against. The agent runs a drift-check against this pin on every
`/create-transaction` invocation (throttled to once per 24 hours via
`last-checked-at`), updates the rulebook when watched paths have changed, and
advances the pin.

```yaml
last-synced-sha: 162df3e17df5207eb84d25c152a3ee78c37b1445
last-synced-at: 2026-04-16
last-checked-at: 2026-04-17T00:00:00Z
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
`watched-paths` (prefix match for directory entries). Empty intersection ⇒ no
drift, advance `last-checked-at` silently. Non-empty ⇒ fetch per-file diffs,
summarize rule-relevant changes, auto-edit `memory/transaction-rules.md`,
advance both SHA and timestamps.

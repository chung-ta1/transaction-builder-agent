# error-messages

**Moved to a structured JSON file.** The agent no longer reads this markdown.

The rules are now in `memory/error-rules.json` and accessed via the `lookup_error` MCP tool:

```
lookup_error({ message: "<raw arrakis/yenta error>" })
  → { matched: { class: "A"|"B"|"C"|"D", fix, field?, auto_retry? } | null }
```

**Class** drives the recovery path:
- **A** — fixable missing/invalid field. Use `field` to identify what's wrong; ask user (or self-heal from cached data); update via `update_draft_section` (or appropriate write tool); retry the failed call once.
- **B** — structural. Cannot self-heal. Surface `fix` to the user as the resolution.
- **C** — warning attached to a 200 response. Surface above the URL with ⚠️.
- **D** — transient. Execute `auto_retry.action` once, then retry the original call. Never chain retries.

**Auto-retry actions:**
- `reload_token` — clear cached JWT, re-auth via `pre_flight({ forceFresh: true })`, retry.
- `fetch_user_office` — re-read user profile via `pre_flight`, fill `owner.officeId` via `update_draft_section(section="owner")`, retry.
- `wait_and_retry` — sleep `ms`, retry.

**Adding a new rule:** edit `memory/error-rules.json`, run `npm run build`, restart Claude session. Each rule needs a unique `match` substring (`|` separates alternations).

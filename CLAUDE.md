# CLAUDE.md — in-repo guidance

This file is loaded by Claude Code when it opens the `transaction-builder-agent` repo. It supplements the project's public README with the internal map a coding assistant needs.

## Project shape at a glance

```
transaction-builder-agent/
├── .claude/
│   ├── settings.json                     # registers the MCP
│   │   └── skills/                       # auto-generated from src/prompts/*.md
│   │       ├── create-transaction/SKILL.md
│   │       ├── create-listing/SKILL.md
│   │       ├── create-from-document/SKILL.md   # PDF or image → transaction/listing
│   │       ├── create-referral-payment/SKILL.md
│   │       ├── list-drafts/  update-draft/  submit-draft/  delete-draft/
│   │       └── sync-rules/SKILL.md        # force-rebuild the arrakis rulebook
├── memory/                               # read + written by the agent
│   ├── transaction-rules.md              # arrakis rulebook + accuracy stack
│   ├── arrakis-pin.md                    # drift-check pin
│   ├── user-preferences.md               # per-user smart defaults (identity, env, office)
│   ├── user-patterns.md                  # typical_* categorical + learned_agents cache
│   └── error-messages.md                 # arrakis error → plain-English fix
├── src/
│   ├── index.ts                          # stdio bootstrap
│   ├── server.ts                         # MCP tool registry
│   ├── config.ts                         # env → URL + prod block
│   ├── auth/                             # browser login + token cache
│   ├── services/                         # arrakis + yenta axios clients
│   ├── tools/
│   │   ├── granular/                     # 23 tools (17 files), ~one per arrakis endpoint
│   │   ├── convenience/                  # 3 batched happy-path tools
│   │   ├── Tool.ts                       # common types + result shape
│   │   └── index.ts                      # combined registry (convenience first)
│   └── types/
│       ├── enums.ts                      # mirrors arrakis enums
│       └── schemas.ts                    # zod schemas per tool input
├── test/                                 # vitest
├── package.json, tsconfig.json
├── Dockerfile, docker-compose.yml
└── .github/workflows/build.yml
```

## Where to add things

- **New arrakis endpoint** (e.g., arrakis adds `/{id}/flex-team`): add a method to `src/services/TransactionBuilderApi.ts`, add a granular tool in `src/tools/granular/`, register it in `src/tools/granular/index.ts`. The agent will pick it up automatically via the tools registry.
- **New convenience composition**: add a file in `src/tools/convenience/`, register in `src/tools/convenience/index.ts`. Convenience tools are thin wrappers around the granular ones + arrakis endpoints directly.
- **New edge case to capture** (e.g., arrakis adds a new required field in DUAL rep): edit `memory/transaction-rules.md`. The agent loads it on every run.
- **New error → fix mapping**: edit `memory/error-messages.md`. The agent also appends new stubs on unmapped errors automatically.
- **New env-wide rule** (e.g., a new env `team6`): add to `SUPPORTED_ENVS` in `src/config.ts`, update the env enum in `src/types/schemas.ts:envSchema`.

## Conventions

- **TypeScript, ESM, Node ≥18.** No CommonJS. Imports end with `.js` (Node 16 module resolution).
- **Zod first.** Every tool input runs through zod; invalid LLM output becomes a structured error, never a malformed HTTP call.
- **Money as integer cents.** Never JS floats for dollar amounts. Decimal strings at the JSON boundary, integer math in between.
- **Axios with `validateStatus: () => true`.** HTTP status branches happen in `BaseApi.request`, not in axios's try/catch.
- **No direct Anthropic SDK use.** All LLM reasoning lives in the Claude Code agent (`.claude/agents/transaction-creator.md`). The MCP server is mechanical.
- **Prod block (`therealbrokerage.com`) is enforced in `src/config.ts` before any HTTP call.** Don't add a bypass.

## When arrakis changes

**Memory drift-check** runs on every `/create-transaction`: compares `memory/arrakis-pin.md:last-synced-sha` against `github.com/Realtyka/arrakis` default branch. Only mutates `arrakis-pin.md` when watched paths have actually changed — the pin advances together with the `transaction-rules.md` rule updates, so no per-user timestamp churn, no merge conflicts.

Enum and schema values in `src/types/{enums,schemas}.ts` and `src/util/draftRequirements.ts` are synced manually from the arrakis source. When you see the drift-check flag a change in one of those files, update the TypeScript mirror by hand.

## Testing

- `npm test` → unit + scenario tests against mocked HTTP.
- `npm run test:contract` → opt-in hits team1 for a real round-trip; requires being on the Real VPN + a valid user session.

## Financial-grade accuracy stack

Read `memory/transaction-rules.md` → "Financial-grade accuracy stack". Seven guards (G1–G7) apply to commission math. If you're touching `src/tools/granular/finalize.ts`, `src/tools/granular/commission.ts`, or anything in the agent runbook that writes splits — **don't weaken a guard**. Discuss in a PR first.

## Self-improvement & autonomy (durable working agreement)

- **Learn once, apply forever.** When the user corrects you — or you notice
  you've hit the same friction twice — capture the lesson (here or in
  `memory/lessons.md`) and change behavior immediately. Never make the user
  give the same correction twice.
- **Say a blocker once, then route around it.** State a hard blocker (e.g.
  "the transaction-builder MCP isn't registered in this dev session") exactly
  once, with its fix — then proceed via whatever path IS available. Don't
  re-surface the same caveat every turn.
- **Don't re-present the same menu.** Offer a set of options once. After the
  user gives any direction, commit and drive forward — don't reprint the
  (a)/(b)/(c) choices again.
- **Default to continuing.** Make progress autonomously; pause only for
  genuinely consequential choices (money interpretation, identity,
  irreversible or shared writes). For everything else, proceed and let the
  user redirect.
- **Advance to the limit of what you're allowed — don't ask permission for
  safe actions you can just take.** When you're blocked from *finishing* a
  task, autonomously do every safe, reversible step that moves it forward
  (build, install, register, verify, smoke-test) before handing back the
  single irreducible step only the user can do (e.g. an interactive browser
  login, a restart). Don't offer "want me to run X, or will you?" for a safe
  local command — run it, then report what's left. Example: when the user
  chose self-auth, the right move was to run `./setup.sh` + verify
  registration immediately, leaving only their relaunch + login — not to ask
  whether I should run the installer.

## When a transaction can't be created / submitted

If create or submit fails (validation, infra, or a backend 5xx) and you can't
drive it to a live transaction, do NOT dump the raw error or silently retry in
a loop. In a single response, give the user:

1. **A brief reason** — one or two plain-English sentences on *why* it
   couldn't be created (e.g. "Yenta returned a 500 on submit — a server-side
   error, not a problem with your data"). Don't paste the raw stack/body.
2. **The draft URL** — always surface the link to the saved draft so nothing
   is lost and the user can finish in Bolt:
   `https://bolt.{env}realbrokerage.com/transaction/create/{builderId}`.
3. **Options** — concrete next steps to pick from: submit in Bolt directly,
   retry now/later, or have you investigate. Offer the menu once, then act on
   their choice.

Retry at most once on a transient error (5xx / timeout), and verify draft
state first so you don't double-submit. Never chain retries.

## Identity & "on behalf of" — who owns vs. who's authenticated

The owner of a transaction and the identity that authenticated the call are
two different things. Get this wrong and you create a transaction for someone
who never consented or proved their identity.

- **Default: owner = the authenticated user.** Aim every create at this. When
  the owner equals the signed-in identity, no choice or disclosure is needed —
  just proceed.
- **"On behalf of" is a deliberate, disclosed, authorized exception — never
  the silent path.** Doing it silently is the mistake, not the capability.

**When the intended owner ≠ the authenticated identity, STOP before the write
and branch on authorization:**

- **Authenticated as an admin, creating for a different agent** → offer the
  user a choice up front: (a) create on-behalf-of (disclosed), or (b) have
  that person log in and own it themselves. Confirm the exact owner either way.
- **Authenticated as a non-admin, creating for a different agent** → no choice.
  Impersonation isn't authorized; require the owner to log in. If the server
  lets a non-admin set a different owner, that's a vulnerability, not a feature.

**When you do create on behalf, always:** disclose up front ("this runs as
{admin}, on behalf of {owner}; {owner} won't be asked to log in"), confirm the
owner explicitly, flag that the owner hasn't authenticated (pending payment
settings / consent), and leave an audit trail of "{admin} created for {owner}".

**Authorization is the server's job, not the agent's.** The agent passing an
`agentId` must never be what *grants* permission — arrakis/keymaker must
validate it against the caller's JWT.

**This product's auth is genuine per-user login** (browser login → keymaker →
owner = the authenticated user). There is no hardcoded admin and no dependency
on any other MCP — a freshly cloned machine signs in as itself and owns what it
creates.

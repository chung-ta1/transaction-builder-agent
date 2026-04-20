# error-messages

Lookup table for translating arrakis / yenta error strings into plain-English
fixes. When a tool call fails, the agent substrings the error against `match`
and surfaces the matching `fix` instead of the raw backend message. If no
entry matches, the agent shows the raw message **and** appends a stub to this
file so future runs can do better.

## Optional `auto_retry` field

A subset of entries carry `auto_retry:` metadata. When present, the agent
attempts the documented recovery ONCE before surfacing the error. On a second
failure, the user sees both the original error and what was tried.

Valid `auto_retry.action` values:

- **`reload_token`** — clear the cached JWT for the env and call
  `verify_auth(env)` (which triggers the browser-login helper). Then retry the
  original failed call. Use for 401 / token-expiry errors.
- **`fetch_user_office`** — call `verify_auth(env)` to re-read the user's
  profile, pull their `officeId`, and re-issue the failed call with the office
  filled in. Use for "owner office is empty" errors where the office lookup
  wasn't wired up the first time.
- **`wait_and_retry`** (with `ms: <number>`) — sleep the given milliseconds
  and retry. Use for transient network errors or arrakis 5xx.

Never chain auto-retries: one attempt per failure, period.

```yaml
- match: "ownerAgent's office can't be empty"
  fix: "Your agent profile is missing an office assignment. I'll try to re-read it from your Real profile and retry. If that still fails, ask your broker to set an office for you in yenta."
  auto_retry:
    action: fetch_user_office

- match: "Sale price must be greater than 0"
  fix: "The sale price in the prompt was zero or negative. Please re-state the price."

- match: "ownerAgent info can't be empty"
  fix: "The draft doesn't have an owner agent yet. Run set_owner_agent_info (or create_draft_with_essentials with ownerAgent set) before finalizing."

- match: "ownerAgent's id is missing"
  fix: "The owner agent was set but without a yentaId. Re-run set_owner_agent_info with the agent's yentaId."

- match: "For transactions, you must specify a list of buyers"
  fix: "Add at least one buyer (company name OR first + last name) before calling update_buyer_seller."

- match: "Address is required to update owner agent"
  fix: "Set the property address via update_location before set_owner_agent_info."

- match: "Agent already exists on referral"
  fix: "A referral has already been added. Remove the existing one via delete_referral before adding a new one."

- match: "MISSING_DUAL_REPRESENTATION_COMMISSION"
  fix: "Dual rep requires at least one agent (usually you) with positive commission on BOTH BUYERS_AGENT and SELLERS_AGENT. Adjust the splits and try again."

- match: "DUAL_REPRESENTATION_SPLIT_TO_COMMISSION_CHECK"
  fix: "The per-side commission totals exceed what's available on that side of the deal. Lower the per-side amounts so they're ≤ that side's commission (0.10 tolerance)."

- match: "ONE_REF_AGENT_ERROR"
  fix: "arrakis only allows one non-opcity referral per draft. Remove the existing referral before adding a new one."

- match: "Sale Commission is necessary for Dual Representation"
  fix: "Set saleCommission on the draft (via update_price_and_dates) — required for DUAL rep."

- match: "Listing Commission is necessary for Dual Representation"
  fix: "Set listingCommission on the draft (via update_price_and_dates) — required for DUAL rep."

- match: "Year built is required in the USA"
  fix: "arrakis rejects null yearBuilt on US properties when you call updateYearBuilt() explicitly. Either supply a yearBuilt value OR omit the field from LocationInfoRequest entirely (it's optional when not explicitly set)."

- match: "You cannot create a transaction in a country where your account is not registered"
  fix: "This property is in a different country than your agent profile. Pick a property in your country, or ask Real to enable cross-country rights on your account."

- match: "Referral-only agents can only create referral transactions"
  fix: "The signed-in agent is flagged as referral-only in yenta. They can only create referral-type transactions (dealType=REFERRAL or INTERNAL_REFERRAL), not regular sales/leases/listings. Start over with a referral-type draft."

- match: "Referral-only agents cannot own regular transactions or listings"
  fix: "Referral-only agents cannot be owner on a non-referral draft. Change ownership to a non-referral agent, or convert the deal to a referral transaction."

- match: "Referral-only agents cannot be agent representatives"
  fix: "You added a referral-only agent as a co-agent on a non-referral transaction. Remove that participant or change the transaction to a referral."

- match: "zero commission deal with the current provided commissions"
  fix: "The zeroCommissionDeal flag is inconsistent with the sale/listing commission values. Either set both commissions to zero and flag=true, OR set positive commissions and flag=false."

- match: "sum of commission percentage should be 100"
  fix: "At least one commission split has percentEnabled=true, which requires every percent split to sum to exactly 100. Recompute splits via compute_commission_splits and resubmit."

- match: "sum of total commission splits should be equal to total commissions"
  fix: "Amount-based commission splits don't sum to saleCommission + listingCommission. Recompute via compute_commission_splits (integer-cents arithmetic)."

- match: "participant was provided in the commission splits that is no longer a part of the transaction"
  fix: "A participant was removed from the draft after the splits were set. Call get_draft for current participants, then recompute + set_commission_splits with the live participant IDs."

- match: "You cannot assign a commission split to a domestic team member"
  fix: "Arrakis routes domestic team members' commissions through the domestic lead. Remove the domestic team member's split and assign the total to the domestic lead instead."

- match: "Participant role is required for commission payer info"
  fix: "Commission-payer creation requires all of: role, firstName, lastName, companyName, email, phoneNumber. If the user doesn't have full title/lawyer info, SKIP add_commission_payer_participant — arrakis tolerates a null payer at submit; user fills it in Bolt."

- match: "First name is required for commission payer info|Last name is required for commission payer info|Email is required for commission payer info|Phone number is required for commission payer info|Company name is required for commission payer info"
  fix: "All 6 payer fields are required when creating a commission-payer participant. Skip the payer call entirely if you only have a subset — user fills the rest in Bolt."

- match: "Property slug is not available"
  fix: "That propertySlug is taken. Try another or omit propertySlug to have arrakis generate one."

- match: "salePrice cannot be empty"
  fix: "Sale price is missing from update_price_and_dates. Add it and retry."

- match: "commissionSplitsInfo cannot be empty"
  fix: "No commission splits were written. Call set_commission_splits with the participant ids + percentages before finalize."

- match: "Commission document payer role must be one of"
  fix: "The commission-document payer role must be TITLE, SELLERS_LAWYER, or OTHER_AGENT. Adjust add_commission_payer_participant."

- match: "transaction-builder MCP tools aren't loaded"
  fix: "This Claude Code session started before the MCP was registered, so its tool list is frozen. Don't retry here — exit this session (/exit or ⌘Q) and run 'claude' again. If the error persists AFTER restart, the MCP manifest may contain internal `$ref` schemas (Claude Desktop/Code silently drop servers with those). Run ./scripts/smoke-mcp.sh — it will tell you. If it flags `$ref`, that's a build-time bug: src/server.ts must pass `$refStrategy: \"none\"` to zodToJsonSchema. Rebuild and restart."

- match: "tools aren't loaded in this session"
  fix: "Claude Code only loads MCPs once, at session start. Exit and relaunch: type /exit in the CLI, or ⌘Q + relaunch Claude Desktop. If restart doesn't fix it, run ./scripts/diagnose.sh."

- match: "Unauthorized"
  fix: "Your session expired. I'll reopen the browser to sign in again."
  auto_retry:
    action: reload_token

- match: "401"
  fix: "Authentication expired. I'll reopen the browser to sign in again."
  auto_retry:
    action: reload_token

- match: "ECONNRESET"
  fix: "Network blip while talking to Real. Retrying once."
  auto_retry:
    action: wait_and_retry
    ms: 500

- match: "502 Bad Gateway"
  fix: "Real's server hiccupped. Retrying once."
  auto_retry:
    action: wait_and_retry
    ms: 1000

- match: "503 Service Unavailable"
  fix: "Real is briefly unavailable. Retrying once."
  auto_retry:
    action: wait_and_retry
    ms: 1000

- match: "No enum constant com.real.yenta.service.dto.search.ActiveAgentSearchRequest.AgentSearchSortBy.createdAt"
  fix: "The MCP's agent-search call uses sortBy=createdAt, but yenta's AgentSearchSortBy enum no longer contains that value. This is an MCP bug against the current yenta API — fix the sortBy value in src/services/YentaApi.ts (or wherever search_agent_by_name builds the query) to a currently-valid enum value. Until then, agent name resolution via search_agent_by_name is broken on this env."

- match: "The parameter 'sortBy' of value 'createdAt' could not be converted to type 'List'"
  fix: "Same root cause as the enum-constant error above: MCP is sending sortBy=createdAt to yenta, which rejects it. Fix src/services/YentaApi.ts to send a valid AgentSearchSortBy value."

- match: "\"status\": 403, \"body\": \"\""
  fix: "403 with empty body from arrakis/yenta usually means VPN to the target env is down, or the session has been revoked by Real (admin bounce or long inactivity). Not a JWT-expiry (that's 401). Check: (a) are you on the Real VPN? (b) does `curl -I https://yenta.team1realbrokerage.com` respond? (c) has your Real admin recently reset sessions? If all green, run `./scripts/diagnose.sh` and retry."

- match: "MCP error -32001: Request timed out"
  fix: "An MCP tool call timed out at the transport layer. For verify_auth, this almost always means the browser-login helper couldn't complete (no browser opened, user didn't finish signing in, or keychain prompt blocked). Re-run the tool; if it keeps timing out, run ./scripts/diagnose.sh and check that the browser-login helper is able to open a window."

- match: "The parameter 'id' of value 'myself' could not be converted to type 'UUID'"
  fix: "verify_auth is calling /users/myself against yenta, but yenta now requires a UUID in that path. The MCP's auth probe is broken against this env — fix src/auth/ (or wherever verify_auth resolves the current user) to call the correct /users/me-style endpoint. Until then, verify_auth cannot return the user's yentaId/officeId, and create_draft_with_essentials can't be auto-populated."

- match: "Agent not found by id"
  fix: "arrakis looked up that yentaId in the target env's yenta and got 404. Most likely: (a) the UUID is from a different env (yentaIds don't cross envs), (b) typo, or (c) the agent was deactivated. Double-check the env the ID was copied from, and retry with the correct one. No auto-retry — wrong ID will just 404 again."

- match: "Cannot initialize a CANDIDATE agent"
  fix: "The yentaId you passed belongs to a CANDIDATE (partially-onboarded) agent. Arrakis refuses to put candidates on a transaction as partners or referrals. Pick a different agent (status=ACTIVE) from search_agent_by_name results, or switch to an EXTERNAL referral (kind=external) if they're not yet a Real agent. The partial draft is intact — use the granular add_referral tool on the existing builderId to continue."
```

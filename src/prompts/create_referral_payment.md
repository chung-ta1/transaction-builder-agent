You are helping the user create a Real Brokerage **referral-payment transaction** — the **"Create Referral"** button in Bolt (on the Transactions page header, next to "Add Transaction"; the wizard opens at `/transaction/referral`). This records a referral fee on Real's books as its own Transaction, not a line item on a sale. It is the right flow when money is moving because of a referral and there's no sale of the user's to attach it to.

The Bolt wizard walks 6 steps then a review screen: External Agent Information → Client Information → Deal Information (amount + closing date) → Transaction Owner → Address → Payment Information (skippable) → Review → **Create Referral**. This skill collects the same data in one pass and fires a single create-and-disburse call.

## Principle zero: context routing (load `memory/context-routing.md`)

"Referral payment" and variants live in a two-way ambiguity with the transaction-level `add_referral` tool. Disambiguate from context:
- Active sale draft in focus + user says "add the referral" → `add_referral` tool on that draft.
- User mentions payment flowing between Real and another agent/entity with no sale attached (termination fee, BPO, received-a-referral-check) → **this skill**.
- No context signal + bare "create a referral payment" → this skill is the closest match; proceed and let the classification sub-question (REFERRAL vs OTHER) sort it out.

**When to trigger:** user says "create a referral payment", "record a referral fee", "external agent owes me a referral", "I got a referral payment", "add the referral to my books", "Create Referral", or describes a referral between agents that isn't attached to a sale the user is closing. Also triggers when the user clarifies they want the "Create Referral" button on the Transactions page (wizard at `/transaction/referral`).

**When NOT to trigger:**
- The user is closing a sale and a referral fee is part of that deal → use `/create-transaction` with `add_referral`.
- The user already created the referral and wants to edit it → direct them to the transaction's detail page in Bolt (no edit API today).

## Two classifications, one endpoint

The same `POST /agent/{id}/referral-and-disburse` endpoint handles two kinds of payment, distinguished by the `classification` field (arrakis's `ReferralClassification` enum):

| classification | Bolt label | When to use |
|---|---|---|
| `REFERRAL` (default) | **External Referral** | Traditional agent-to-agent referral from an outside brokerage for a **client** referral. There's a real estate deal on the other side and the client is the star of the story. |
| `OTHER` | **Non-Referral Payment** | Any other payment owed to Real for your licensed activity that isn't a referral or a normal transaction — termination fees, BPOs (Broker Price Opinions), spiffs, one-off licensed services. No "client" is involved in the usual sense; the `clientName` field still gets populated (often with the counterparty's name) because arrakis still requires it. |

**Bolt UI note (feature flag).** The classification selector is gated by the `US_EXTERNAL_REFERRALS` feature flag. On environments where it's off (team1 as of April 2026), Bolt's UI doesn't show the selector and always sends `REFERRAL`. **The API accepts `OTHER` regardless of the flag**, so this skill can set the classification correctly even when Bolt's UI can't.

## Core principles

Same four as `/create-transaction`:

1. **Quick** — smart defaults, batched questions, cached agent lookups.
2. **Accurate** — financial document; never invent names, emails, amounts.
3. **Painless** — memory-first (user-preferences, user-patterns incl. learned_agents).
4. **Ask when ambiguous — never guess.** Names in the API are single strings ("Jane Smith") while the Bolt UI asks first/last separately. If the user's prompt says "referral to Jane" without a last name, ASK before sending "Jane" to arrakis (arrakis validates but lots of downstream reports filter by last name).

## One-shot endpoint — know this before anything else

Arrakis has no draft stage for this flow:

```
POST /api/v1/agent/{senderAgentYentaId}/referral-and-disburse
```

One call, immediate submit. The resulting Transaction is live in arrakis the instant this tool returns. Because there's no Bolt draft URL, **the in-chat preview IS the review step** — emit the full preview block in the same turn as the `create_referral_payment` call so the user sees what's being submitted and can interrupt with Esc if it's wrong. No "are you sure?" button gate.

## Runbook

### 0. Pre-flight (parallel, batched in one turn)

- Read `memory/user-preferences.md`, `memory/user-patterns.md`. For errors, call the `lookup_error` tool (don't read a markdown dictionary).
- `pre_flight(env, userPrompt)` — returns auth + any postal codes from the prompt.

If env isn't yet resolved, ask once with the standard team1/team2/.../play/stage options. Never offer prod.

### 1. Parse the prompt — build the `answers` object

Extraction rules specific to this flow (overrides any general rules):

**Names (CRITICAL — single string, not first+last)**
- `"Jane Smith"` → `externalAgentName: "Jane Smith"`.
- `"Jane"` alone → ASK for last name; don't default.
- `"ACME Team"` → `externalAgentName: "ACME Team"` is fine (arrakis accepts team/business strings).
- Same rule for `clientName`.

**Amounts**
- `"$2,500"`, `"2500"`, `"2.5k"` → `{ amount: 2500, currency: "USD" }`.
- Currency defaults from `officeOfSaleState` when present, else USD.

**Dates** (Bolt's "Approximate Closing Date" — required `*`)
- `"closes May 30"`, `"close 5/30"` → `expectedCloseDate: "2026-05-30"`, `expectedCloseDateSource: "user"` (infer year; never emit a date more than 18 months in the future without asking).
- **Missing + amount < $1,000** → default to today + 60 days, pass `expectedCloseDateSource: "defaulted"`, mark `~` in the parse summary. Don't ask — a wrong date on a sub-$1k payment is low-stakes and the user can fix it in Bolt.
- **Missing + amount ≥ $1,000** → ASK for the real date (one `AskUserQuestion`, free-text). A fabricated close date on a large referral lands in the wrong tax quarter and poisons 1099 reporting, so the tool hard-rejects a defaulted date here (`DEFAULTED_DATE_ON_LARGE_REFERRAL`). Resolve it before firing — don't default.
- **Always tag the source.** Pass `expectedCloseDateSource: "user"` when the date came from the user, `"defaulted"` when you filled it in. The tool's large-referral guard keys off this field; omitting it silently disables the guard.

**Payment info (optional)**
- `"paid by wire on 4/10"` → `externalPaymentMethod: "WIRE"`, `externalPaymentDateSent: "2026-04-10"`.
- `"sent a check"` → `externalPaymentMethod: "CHECK"`.
- Missing → leave out of the body. Do NOT send empty strings; arrakis validates enum strictly.

**Brokerage**
- `"Keller Williams"`, `"KW Downtown"`, `"Sotheby's"` → `externalAgentBrokerage: "…"` verbatim. Don't normalize or shorten.
- If the prompt says "another Real agent" or names someone at Real, this is the wrong flow — route to internal-referral or transaction-add-referral; see "When NOT to trigger" above.

**Classification (REFERRAL vs OTHER)** — critical, applies ambiguity-rule #4

Classification is **never silently defaulted**. The skill's whole advantage over Bolt's UI is that it CAN classify correctly (Bolt's UI hides the selector on envs where `US_EXTERNAL_REFERRALS` is off, and always sends REFERRAL). Silently defaulting to REFERRAL re-introduces the exact limitation we built the skill to bypass. Misclassification pollutes 1099 reporting and referral-vs-non-referral analytics on Real's books.

**Strict rules:**

- **Allow-list for silent REFERRAL** — omit the `classification` field (letting arrakis default to REFERRAL) ONLY when the user's prompt contains one of these verbatim signals:
  - `"referred a client"` / `"client referral"`
  - `"hand-off"` / `"handed off a buyer"` / `"handed off a seller"`
  - `"{agent} sent me a buyer"` / `"sent me a seller"` / `"sent a lead"`
  - `"got a lead from"` / `"received a referral from"`
  - `"outside brokerage closed my client"`

- **Explicit OTHER** — pass `classification: "OTHER"` when the prompt contains: "termination fee", "BPO", "Broker Price Opinion", "spiff", "bonus", "consulting fee", "expert witness", "licensed service that isn't a deal", "no client involved", "non-referral payment", "non referral payment". Surface the reason in `comments` so the record is self-documenting.

- **Everything else → `AskUserQuestion`.** Phrases like "payment from another brokerage", "commission from {agent}", or an unlabeled amount with just a person's name don't pass the allow-list. The skill asks the user which kind it is; no silent judgment call.

- **Tool-side gate (defense in depth):** `create_referral_payment.ts` rejects the call with `PLACEHOLDER_CLIENT_ON_REFERRAL` when `clientName` matches `/unknown|n\/a|tbd|no\s+client|placeholder/i` AND `classification` is REFERRAL (or omitted). A missing/unknown client is semantically incoherent with "a specific client was referred" — the tool won't fire and the skill has to resolve.

**Emails**
- External agent email is REQUIRED. Client email is OPTIONAL. If the prompt has only one email, ambiguity rule #4 fires: ask which party it belongs to.
- **Look up before asking.** When you have the external agent's first+last name but no email, DO NOT offer a fabricated guess like `first.last@example.com` as an AskUserQuestion option. Instead:
  1. Check `user-patterns.md:learned_agents` (match on first+last OR any `aliases[]` entry, env-scoped) for a cached match.
  2. If no cache hit, fire `search_agent_by_name(firstName, lastName)` to yenta.
  3. Present results back to the user:
     - **Exact match** → offer that email as the first option (recommended), plus "Different email — I'll supply".
     - **Multiple matches** → show each candidate with identifying info (brokerage, email) as options, plus "None of these".
     - **Zero matches** → say explicitly "no yenta match found — please supply the email" with Other as the only real input.
  Verified bug 2026-04-20: flow offered `chung.joyner@example.com` as a guess; user pushed back *"you have first and last name. why not look up and verify with the user?"* Yenta had an exact match that was missed.

**Property address** (optional, but surface in the preview when known)
- Same rules as `/create-transaction` step 2 parsing.

**Owner**
- Defaults to the authenticated user. Only pass `transactionOwnerAgentId` explicitly if the user tells you to create it on behalf of someone else (rare — typically only TCs do this).

### 2. Structured parse summary (✓ / ⚠)

Emit BEFORE the first `AskUserQuestion`:

```
Here's what I read — confirm anything wrong:

  ✓ Env:                 team1
  ✓ External agent:      Jane Smith · jane@smith.com · Keller Williams Downtown
  ✓ Client:              Michael Brown · michael@example.com
  ✓ Referral amount:     $2,500 USD
  ✓ Expected close:      2026-05-30
  ~ Owner:               You (Chugn Agent) — default
  ~ Currency:            USD (default; override only if cross-border)
  ⚠ (nothing missing)

Legend: ✓ parsed · ~ defaulted · ⚠ still needed.
```

### 3. Completeness check

Deterministic — every item must be ✓ or `~` before proceeding to step 4.

**Required (NotNull on arrakis side — `CreateAndDisburseReferralRequest`):**
- [ ] `externalAgentName` (single full-name string)
- [ ] `externalAgentEmail` (valid email — arrakis uses Jakarta `@Email`)
- [ ] `externalAgentBrokerage`
- [ ] `clientName` (single full-name string — for Non-Referral Payment, use the counterparty's name or a descriptive stand-in like "BPO Client")
- [ ] `expectedReferralAmount` (`{ amount: number, currency: "USD" | "CAD" }`)
- [ ] `expectedCloseDate` (ISO `yyyy-MM-dd` — for Non-Referral Payment, use the service/activity date) **+ `expectedCloseDateSource`** (`"user"` if supplied, `"defaulted"` if you filled it in). On amount ≥ $1,000 the date must be `"user"`-sourced — ask if it wasn't provided.
- [ ] `classification` (`REFERRAL` default | `OTHER` for Non-Referral Payment) — always explicit when the prompt contains a Non-Referral Payment signal; may be omitted when unambiguously a traditional referral

**Conditional / optional:**
- [ ] `clientEmail` (soft-ask; most real deals have one)
- [ ] `transactionOwnerAgentId` — defaults to sender.
- [ ] `referredPropertyAddress` — only include if every required address field is present (street, city, state, zip, country). Partial addresses cause Bolt to render "Not provided" and also skip a downstream tax-table lookup, so it's all-or-nothing.
- [ ] Payment info (`externalPaymentDateSent`, `externalPaymentMethod`, `externalReferenceNumber`, `externalSenderName`, `comments`) — only when the user has already received/sent the payment. The UI explicitly exposes a "Skip this section" button; mirror that. Don't fabricate.

**Ask only for required data that wasn't provided.** Walk the Required list above: an item the user already gave (in the prompt, an attached document, or memory) is ✓ — never re-ask it. An item with a safe silent default (currency=USD, owner=you, close date when amount < $1,000) is `~` — don't ask. Only the items still `⚠` after that pass become questions. Batch those into ONE `AskUserQuestion` (≤4 items; cycle if more). The optional/conditional items (clientEmail, address, payment info) are never blocking — surface them as "fill in Bolt later", don't gate the create on them.

### 4. Preview + fire — SAME TURN (no confirmation gate, no turn delay)

**Emit the preview text AND fire `create_referral_payment` in the same assistant turn.** The user sees one response: preview, execution, success URL, surfaced warnings. No intermediate "are you sure?" gate, no "next turn" delay.

Preview format:

```
Referral payment — {env}

Type:               {External Referral | Non-Referral Payment (termination fee / BPO / spiff / …)}
External agent:     {name} · {email} · {brokerage}
Client:             {name}{ ` · ` + email if present}
Amount:             ${amount:,} {currency}
Expected close:     {yyyy-MM-dd}
Owner:              {display_name or "You"}
Address:            {full address, or "(not provided — fill in Bolt later)"}
Payment info:       {payment method + date + reference, or "(skipped — fill in Bolt later)"}
```

Always label the Type line explicitly, including the Non-Referral Payment sub-reason when classification=OTHER (pulled from `comments` if set, otherwise just "Non-Referral Payment").

**The only legitimate blocking question in this flow is classification (REFERRAL vs OTHER) when the prompt gives zero signal either way.** Even then, frame it as a data question ("which type?") — never a "shall I proceed?" gate.

**Post-create check:** after the tool returns, scan `raw.transaction.errors[]`, `raw.transaction.builderErrors[]`, `raw.transaction.transactionWarnings[]`, `raw.transaction.lifecycleState`. Surface anything non-empty with 🚨 / ⚠️ ABOVE the URL. Particularly:
- Ledger errors about team pre-cap fees exceeding the payment — this is the most common gotcha for Pro-Team members on small-dollar Non-Referral Payments; always flag it.
- `referralStatus` on the referral object — should be `SUBMITTED`; anything else is a problem.

### 5. Execute — single tool call

```
create_referral_payment({
  env,
  senderAgentYentaId: <pre_flight.auth.user.yentaId>,
  externalAgentName, externalAgentEmail, externalAgentBrokerage,
  clientName, clientEmail?,
  expectedReferralAmount: { amount, currency },
  expectedCloseDate,
  expectedCloseDateSource,        // "user" if the user gave the date, "defaulted" if you filled it in. REQUIRED for the large-referral guard to work — on amount ≥ $1,000 a "defaulted" date is rejected.
  classification?,                // "REFERRAL" (default, omit) or "OTHER" (Non-Referral Payment)
  referredPropertyAddress?,
  externalPaymentDateSent?, externalPaymentMethod?,
  externalReferenceNumber?, externalSenderName?,
  comments?,
  transactionCoordinatorIds?,
})
```

The tool returns `{ transactionId, referralId, transactionCode, detailUrl, raw }`. If the call fails, call `lookup_error({ message })` and surface `matched.fix` in plain English. Never auto-retry a failed referral-and-disburse — stop, explain the error, and let the user re-issue the prompt.

### 6. Return the URL

Unlike `/create-transaction`, this flow returns a `detailUrl` (the live transaction page), NOT a draft URL. Emit as a clickable markdown link OUTSIDE any code fence:

```
Referral payment — {env} · transaction {short-id} ({transactionCode})

External agent:     {name} · {brokerage}
Client:             {name}
Amount:             ${amount:,} {currency}
Expected close:     {yyyy-MM-dd}
Status:             Live in arrakis — review in Bolt
```

> **View in Bolt:** [{detailUrl}]({detailUrl})

If the user needs to add the payment info (skipped earlier), tell them: the transaction detail page has a "Referral" section where they can edit.

### 7. Learn

- External agents (non-Real brokers supplied free-text) are NOT written to `user-patterns.md:learned_agents` — that section is for yenta-resolved Real agents only. If the same external broker shows up repeatedly, the user can ask you to remember them explicitly.
- `memory/user-preferences.md` / `memory/user-patterns.md`: nothing specific here — no new categorical defaults come out of this flow.

(No local audit log. arrakis is the system of record — use `list_my_builders` / transaction detail API to look up past referral payments.)

## What you never do

- Never fire `create_referral_payment` without emitting the full preview block in the same turn. The in-chat preview is the only review step; skipping it means the user has no way to catch a wrong name, amount, or brokerage before arrakis commits.
- Never split a single-string name into first/last when building the API body — arrakis's `CreateAndDisburseReferralRequest` only takes `externalAgentName` and `clientName` as single fields.
- Never send empty-string payment fields to pass validation. Omit them entirely.
- Never send a `referredPropertyAddress` missing required subfields; send the whole object or none at all.
- Never claim the referral can be "edited as a draft" afterwards — arrakis has no edit API for this; only the detail page's manual fixes.

You are creating a Real Brokerage transaction or listing **from a document** — a PDF or image the user supplies (listing agreement, purchase/sale contract, buyer-representation agreement). You read the document yourself: the `Read` tool is multimodal and renders PDFs and images directly, so no OCR tool is needed. A real-estate document is a legal/financial record — **extract only what is actually filled in, never fabricate, and confirm the extracted terms before any write.** This skill does NOT re-implement create logic: it extracts + confirms, then hands off to `/create-listing` or `/create-transaction`, which own auth, validation, preview, and submit.

## 0. Get the file and read it

- The user gives a file path (or attaches a file). Read it with the `Read` tool — PDFs (`.pdf`) and images (`.png`/`.jpg`/`.jpeg`/`.heic`) both work.
- **Large PDF (>~10 pages):** read in page ranges (`pages: "1-6"`, then `"7-12"`) so nothing is truncated. Deal terms live in the first pages (parties, property, price, term, compensation); later pages are usually boilerplate.

## 1. Classify the document → representation side + artifact

Two **independent** decisions — keep them separate. **The document sets the representation *side*; the user's verb sets the *artifact* (transaction vs listing).** Never let the form type override what the user actually asked to create.

- **Representation side (from the document):**
  - Listing agreement / "Exclusive Right to Sell" / "Residential Listing" → **SELLER** side.
  - Buyer representation agreement → **BUYER** side (no sale yet — expect a missing price + gaps).
  - Purchase / sale contract (e.g. "One to Four Family Residential Contract") → the side the signed-in agent is on; if the doc doesn't make it obvious, ASK.
- **Artifact (from the user's verb):**
  - "create a **transaction**" / "create the deal" → **`/create-transaction`** with the representation side above. For a **SELLER**-side transaction this runs the autonomous listing chain (create listing → submit → in-contract → convert to transaction) and lands a *transaction* — do **NOT** stop at a standalone listing.
  - "create a **listing**" / "list this property" → **`/create-listing`** (standalone `type=LISTING`).
  - Silent / ambiguous verb on a listing agreement → it most naturally seeds a seller-side *transaction*; default to `/create-transaction` (SELLER) or ASK — don't assume a standalone listing.
- **Not a real-estate deal document, or can't tell** → say so plainly; do not guess a flow.

Surface **both** decisions (side + artifact) in the extraction summary so the user can catch a misread. **A listing agreement + "create a transaction" = a SELLER-side transaction (via the listing chain), not a standalone listing.**

## 2. Extract ONLY filled-in values → DraftAnswers

Map the document's fields onto the create flow's `answers` shape. Typical mappings (TXR and standard forms):

- **Property** → `address` { street, city, state, zip }. Listing para 2A "Land"/"address"; contract property section. Legal description (Lot/Block/Addition) is supplemental, not the street address.
- **Price** → listing: "Listing Price" (para 3); contract: "Sales Price". Integer dollars.
- **Commission** → listing: "Broker Compensation" (para 5A/5B: `___% of the sales price` OR `flat fee of $___`); contract: commission terms. Map to `saleCommission` / `listingCommission`. **Disambiguate at the money boundary** — a `3%` is a percent, a `$X` is a flat amount; never conflate them.
- **Parties** → seller name(s) (listing para 1); buyer name(s) (contract). An entity seller (LLC/estate) lists the authorized signatory.
- **Dates** → listing "Term": begins → `listingDate`, ends → `listingExpirationDate`. Contract: effective/acceptance + closing dates. ISO `yyyy-MM-dd`.
- **MLS** → listing para 6: filing with MLS → the MLS number if present; "will NOT file with any MLS" → MLS = `"N/A"`.
- **State / country** → from the property address; the form's jurisdiction is a hint (a TXR form ⇒ Texas, but confirm against the address).
- **Brokerage / agent named in the document** (footer, signature block) → **informational only.** It does NOT set the owner (see §4).

## 3. NEVER fabricate — blank ≠ data

- A blank form field is **missing**, not an empty value. Mark it `⚠` and let it become a gap the create flow asks about.
- **Form labels, instructions, and annotations are NOT data.** Templates carry helper text in the blanks — e.g. "As it appears on the Tax Record", "Complete address for the Seller", "To Be enforceable Required", "Property Address", "Your Brokerage Name or DBA". NEVER read these as the seller's name, the property address, the price, etc.
- If the document is an **unfilled template** (all deal fields blank, only boilerplate + annotations), say exactly that. Do not invent a deal from it — ask the user for the terms or for a filled, signed copy.
- A checkbox/initials form: a box is only "checked" if it's actually marked. Don't assume.

## 4. Identity — owner = the authenticated agent, not the document's agent

- What you create is owned by whoever is **signed in** (browser login), per the create flow's identity rules. The broker/associate named on the document does NOT authorize ownership.
- If the signed-in agent differs from the document's agent and the user wants the document's agent to own it, that's the disclosed identity-switch / admin-on-behalf-of path — handle it exactly as the `/create-transaction` runbook's identity section says (the owner must authenticate, or it's a disclosed admin on-behalf-of). Never silently set the document's named agent as the owner.

## 5. Confirm the extracted terms BEFORE any write

Extraction is fallible and this is a legal/financial record. Present an **extraction summary** — every mapped field with its value and a source tag — and let the user correct it before you create anything:

```
Extracted from {filename} — {doc type}:
  ✓ Property:        {address}             (p.2)
  ✓ Listing price:   ${amount:,}           (p.2, "Listing Price")
  ✓ Commission:      {X}% of sales price   (p.2, para 5A)  → ${derived:,}
  ✓ Seller:          {name}                (p.1)
  ✓ Term:            {begin} → {end}        (p.2)
  ~ MLS:             N/A                   (p.4 — "will not file with MLS")
  ⚠ Year built:      blank in document — the create flow will ask
  ⚠ {field}:         blank in document
```
Legend: `✓` from the document · `~` inferred from the document · `⚠` blank/missing.

For money, parties, and dates, print ONLY what's in the document; if a commission % and price are both present, show the derived dollars so the user can sanity-check. If anything is uncertain (faint scan, ambiguous handwriting), mark it `?` and ask rather than guess.

## 6. Hand off to the matching create flow

After the user confirms the extracted terms, follow the runbook for the **artifact the user asked for** (step 1) — routed by the user's verb, NOT the document type — with the extracted values + representation side as its parsed input:

- "create a transaction" → **`/create-transaction`** (with the doc's representation side). SELLER-side runs the listing chain and lands a *transaction*.
- "create a listing" → **`/create-listing`** (standalone listing).

A listing agreement does **not** force a standalone listing. That skill runs the real work: auth (browser login → owner = authenticated), the validator (which turns each `⚠` blank into a gap it asks about — with one-click defaults where it has them, e.g. MLS `N/A`, typical year built), the preview, and the create/submit. Do NOT duplicate that logic here — your job is extract → confirm → drive the existing flow.

## What you never do

- Never fabricate a field from a blank form or from instructional / annotation / label text.
- Never treat the agent named in the document as the owner — owner = the authenticated identity.
- Never force the artifact to a standalone *listing* just because the document is a listing agreement — the user's verb ("transaction" vs "listing") decides the artifact; the document decides only the representation side. "Create a transaction" off a listing agreement ⇒ a SELLER-side transaction via the listing chain.
- Never skip the extraction-confirmation step (extraction is fallible; it's a legal record).
- Never guess a commission interpretation (% vs flat) — disambiguate or ask.
- Never auto-submit a document-sourced deal whose extracted terms the user hasn't confirmed.

Begin now. If the user already gave a file path, read it and start at step 1.

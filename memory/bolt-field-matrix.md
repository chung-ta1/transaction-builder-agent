# Field Matrix — Transactions, Referrals, Listings

**Source of truth:** arrakis OpenAPI spec
(`https://arrakis.stagerealbrokerage.com/v3/api-docs/arrakis-public`), pulled
2026-04-17. This matrix captures what the **arrakis API** requires. A second
layer — what **Bolt's UI** enforces — is noted separately. They differ:

- **arrakis API** = what will actually save. If you don't send it, arrakis
  returns a 400. This is what the MCP must enforce to produce a valid draft.
- **Bolt UI** = what the web form asks for before letting you advance a step.
  Bolt is stricter than arrakis. Fields required by Bolt but not arrakis can
  be defaulted silently by the MCP — the draft will save, and the user can
  correct in Bolt later.

`validate_draft_completeness` encodes both layers:
- `blockers[]` = arrakis-level violations (draft can't save)
- `gaps[]` = prompts we ask the user because the value is either arrakis-required
  OR Bolt-UI-required OR financially consequential
- `defaults[]` = values we auto-populate; user sees them in the parse summary

---

## Enums (authoritative)

```yaml
dealType: [SALE, LEASE, REFERRAL, COMPENSATING, COMMERCIAL_LEASE, PLOT, OTHER, INTERNAL_REFERRAL]
propertyType: [RESIDENTIAL, COMMERCIAL, LAND_LOT, CONDO, MOBILE_HOME, NEW_CONSTRUCTION]
representationType: [SELLER, BUYER, DUAL, LANDLORD, TENANT]
currency: [USD, CAD]
country: [UNITED_STATES, CANADA]
state: # full US states + Canadian provinces, see src/types/enums.ts
payerRole: [TITLE, SELLERS_LAWYER, OTHER_AGENT, LANDLORD, TENANT, MANAGEMENT_COMPANY]  # VALID_CD_PAYER_ROLES
```

**Display-name crosswalk** (Bolt label → arrakis enum value):

| Bolt label | arrakis enum |
|---|---|
| Residential | `RESIDENTIAL` |
| Commercial | `COMMERCIAL` |
| Land Lot | `LAND_LOT` |
| Condo | `CONDO` |
| Mobile Home | `MOBILE_HOME` |
| New Construction | `NEW_CONSTRUCTION` |
| Sale | `SALE` |
| Lease | `LEASE` |
| Seller | `SELLER` |
| Buyer | `BUYER` |
| Dual (Seller & Buyer) | `DUAL` |

---

## Transaction Builder — required-by-arrakis fields

Endpoints under `/api/v1/transaction-builder/*`. Each step is a PUT that writes
one section of the draft.

### `POST /api/v1/transaction-builder` — create
- Empty body. Creates a fresh builder and returns its `id` (the builderId).

### `PUT /{id}/location-info` — `LocationInfoRequest`
```yaml
required:      [street, city, state, zip]
optional:      [street2, unit, yearBuilt, mlsNumber, escrowNumber, propertySlug]
bolt_ui_enforces_also: [yearBuilt (US only), mlsNumber (allows 'N/A')]
```

### `PUT /{id}/price-date-info` — `PriceAndDateInfoRequest`
```yaml
required:  [dealType, salePrice, saleCommission, representationType]
optional:
  - propertyType          # arrakis defaults to RESIDENTIAL
  - listingCommission
  - acceptanceDate
  - closingDate
  - firmDate
  - financingConditionsExpirationDate
  - propertyInspectionExpirationDate
  - saleOfBuyersPropertyExpirationDate
  - condoDocumentsExpirationDate
  - otherConditionsExpirationDate
  - listingDate
  - listingExpirationDate
  - requiresInstallments

conditional:
  - rule: representationType in [SELLER, DUAL] → listingCommission required by Bolt
  - rule: dealType == DUAL → saleCommission AND listingCommission both required (service layer enforces)
  - rule: salePrice.amount must be > 0 (service validate())

bolt_ui_enforces_also: [propertyType, acceptanceDate, closingDate]
```

### `PUT /{id}/buyer-seller-info` — `BuyerAndSellerRequest`
```yaml
required:  [sellers]   # @NotEmpty — arrakis rejects empty array
optional:  [buyers]    # arrakis accepts missing; service-level validator may require for SALE

seller_item_shape (SellerInfo / BuyerInfo):
  # no schema-level required fields BUT service validator requires:
  # companyName OR (firstName AND lastName)
  properties: [firstName, lastName, companyName, phoneNumber, email, address, vendorDirectoryId]

bolt_ui_enforces_also: [buyers (for SALE), address on seller, address on buyer]
```

### `PUT /{id}/owner-info` — `TransactionOwnerAgentInfoRequest`
```yaml
required: [ownerAgent]           # ownerAgent.agentId required
optional: [officeId, officeIds, teamId, leadSource]

service_validate_requires: [ownerAgent.agentId, owner.officeId]  # from TransactionBuilder.validate()

bolt_ui_enforces_also: [officeId, teamId]
```

### `PUT /{id}/commission-info` — array of `CommissionSplitsRequest`
```yaml
item_required: [participantId, commission]
commission_shape: CommissionFractionalPercent { commissionAmount? | commissionPercent, percentEnabled }

service_validate:
  - "percentages sum to exactly 100.00"
  - "Σ dollars == gross (cent-exact)"
  - "DUAL: ≥1 agent with positive commission on BOTH BUYERS_AGENT and SELLERS_AGENT"
```

### `PUT /{id}/commission-payer` — inline
Writes `{ participantId, role }` where role must be in `VALID_CD_PAYER_ROLES =
{TITLE, SELLERS_LAWYER, OTHER_AGENT}`. LEASE variant accepts `LANDLORD, TENANT,
MANAGEMENT_COMPANY` per domain rules.

### `PUT /{id}/add-referral-info` — `AddParticipantRequest`
```yaml
required: [role]           # internally set to REFERRING_AGENT
optional:
  - agentId                # REQUIRED for internal (type=AGENT) referrals
  - firstName, lastName, companyName, email, ein, phoneNumber, address  # for external
  - receivesInvoice, vendorDirectoryId, file

service_validate:
  - "at most one non-opcity referral per draft"
  - "external referral requires companyName + firstName + lastName + address + ein (US)"
```

### `PUT /{id}/co-agent` — `AgentParticipantInfo`
```yaml
required: [agentId]
optional: [role, receivesInvoice, ...]
```

### Mandatory "no-op" writes before submit
```yaml
set_opcity:                { required_body: { opcity: boolean } }
update_personal_deal_info: { required_body: { personalDeal, representedByAgent } }
update_additional_fees_info: { required_body: { hasAdditionalFees } }
update_title_info:         { required_body: { useRealTitle }, conditional: "useRealTitle=true → titleContactInfo + manualOrderPlaced required" }
update_fmls_info:          { when: "state=GEORGIA AND dealType in [SALE, LEASE]", body: { propertyListedOnFmls: bool } }
```

### `POST /{id}/submit` — submission
No request body. Server-side runs `TransactionBuilder.validate()`:
```yaml
validate_rules:
  - salePrice > 0
  - ownerAgent.agentId present
  - owner agent list non-empty
  - owner agent officeId present
  - commission splits total 100.00
```

---

## Transaction flow branches (what changes by rep-type / deal-type)

```yaml
BUYER + SALE:
  # Typical residential buyer-side deal.
  required_people: [sellers (>=1, MCP can default {firstName:Unknown,lastName:Seller})]
  optional_people: [buyers (MCP asks once; Bolt UI requires)]
  commission:
    - saleCommission required
    - listingCommission optional
  other_side_agent: [External / Real / Unrepresented]  # default Unrepresented
  listing_precheck: false

SELLER + SALE:
  required_people: [sellers]
  optional_people: [buyers]
  commission:
    - saleCommission required
    - listingCommission required (Bolt UI)
  listing_precheck: TRUE   # Bolt blocks submit: must have active listing
  default_buyer: {firstName:Unknown,lastName:Buyer}

DUAL + SALE:
  required_people: [sellers]
  commission:
    - saleCommission required
    - listingCommission required (Bolt UI + service DUAL rule)
  service_validate:
    - ≥1 agent positive on BOTH BUYERS_AGENT and SELLERS_AGENT
  listing_precheck: TRUE

BUYER + LEASE (TENANT):
  dealType: LEASE
  representation_type: TENANT  # (use TENANT when representing tenant side)
  commission: { sale_commission: represents tenant-side commission }
  payer_role: default LANDLORD or TENANT or MANAGEMENT_COMPANY (ask user)

SELLER + LEASE (LANDLORD):
  dealType: LEASE
  representation_type: LANDLORD
  listing_precheck: TRUE  # Bolt requires active listing for LANDLORD-side too

REFERRAL (dealType):
  # dealType = REFERRAL OR INTERNAL_REFERRAL. These are transactions where the
  # user is a referring agent, not the closing agent.
  required:
    - representationType (typically REFERRING role semantics)
    - referral participant
  optional:
    - buyers/sellers can be Unknown
  # Arrakis treats this as a TransactionBuilder; still uses all the normal
  # endpoints. `dealType: REFERRAL` tells the system it's a referral-only deal.
```

---

## Listings — not in arrakis

`GET /api/v1/listings/{id}/transition/{state}` exists, but there's **no
create-listing endpoint in arrakis**. Listings are managed by a separate
service. The MCP cannot create listings.

**Impact for SELLER/DUAL/LANDLORD deals:**
- The user must create the listing manually in Bolt at
  `https://bolt.{env}realbrokerage.com/listings` and mark it `in contract`
  BEFORE creating the transaction draft.
- `validate_draft_completeness` asks the user up-front whether an in-contract
  listing already exists. If "No", it returns a blocker (no arrakis write).

When required upfront for these flows (what the user needs to gather BEFORE
creating the listing in Bolt — so the MCP can create the transaction right
after):
```yaml
listing_prereqs_user_should_have_ready:
  - Property address (street, city, state, zip, country)
  - Year built (US)
  - MLS number (or 'N/A')
  - Sale/rental price
  - Listing commission (% or flat)
  - Seller (name + address)
  - Listing agent = the user themselves
  - Listing date + expiration date
  - Property type
```

---

## Referrals — two flavors

### Flavor 1: referral-as-deal-type (in transaction-builder)
- Same as any transaction, but `dealType=REFERRAL` or `INTERNAL_REFERRAL`.
- The user (referring agent) creates a transaction; adds a REFERRING_AGENT
  participant representing themselves or the referral target.
- MCP handles this via existing `create_draft_with_essentials` +
  `add_referral` / `add_internal_referral` / `add_external_referral` tools.

### Flavor 2: standalone referral marketplace (`POST /api/v1/referrals`)
- Creates a `ReferralCentralReferralDto` — a marketplace listing for "I have
  a client looking for X in Y location, commission Z%".
- `required`: applicantAgentIds, referralFeePercentage, priceRange,
  locations, referralAgentId, expirationDate, languages, timeline, clientType,
  status.
- `timeline` enum: `FROM_0_TO_3_MONTHS, FROM_3_TO_6_MONTHS, FROM_6_TO_12_MONTHS, UNKNOWN`.
- `clientType` enum: `BUYER, SELLER, TENANT, LANDLORD`.

The MCP does NOT currently support Flavor 2 (marketplace referrals). If a user
wants that, direct them to Bolt's referral-central page. Otherwise,
referral-as-deal-type covers 95% of use cases.

### Flavor 3: agent-level referral (`POST /api/v1/agent/{yentaId}/referral`)
- `ReferralRequest` shape. `required`: expectedCloseDate.
- Simpler flow — agent-to-agent referral outside of a transaction context.
- Not in current MCP scope.

---

## Commission math rules (from service `validate()`)

1. **Σ percentages == 100.00** — two decimals, exact.
2. **Σ dollars == gross** — integer cents, exact.
3. **Single-rep agent pool**: `agent_pool_pct = 100 - Σ referral_pcts`; agent percents split user's stated ratio × agent_pool_pct.
4. **DUAL rep**: at least one agent with positive commission on each of `BUYERS_AGENT` and `SELLERS_AGENT`; per-side commission amounts ≤ that side's total ± 0.10 tolerance.
5. **Amount-based commissions subtract from gross first**; percent commissions apply to remainder.
6. **One non-opcity referral max** per draft.

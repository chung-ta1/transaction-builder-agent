import axios, { type AxiosInstance } from "axios";
import { guessFromPostalCode } from "../util/zipLookup.js";
import { STATE_OR_PROVINCE, CA_PROVINCES } from "../types/enums.js";

type StateOrProvince = (typeof STATE_OR_PROVINCE)[number];

const CA_PROVINCE_SET: ReadonlySet<string> = new Set(CA_PROVINCES);

/**
 * One resolved location candidate for a street address. `zip` is the primary
 * field; `state`/`country`/`currency` are derived from the ZIP via the same
 * `guessFromPostalCode` table `pre_flight` uses, so the caller can also skip
 * the state/country/currency questions — not just the ZIP one.
 */
export interface LocationCandidate {
  zip: string;
  /** The address the geocoder actually matched, for the caller to confirm. */
  matchedAddress: string;
  city?: string;
  /** Raw Census state abbreviation (e.g. "NY"), for display/confirmation. */
  stateAbbrev?: string;
  /** Enum form derived from the ZIP (e.g. NEW_YORK). */
  state?: StateOrProvince;
  country?: "UNITED_STATES" | "CANADA";
  currency?: "USD" | "CAD";
}

export interface LocationResult {
  /** All distinct candidates (by ZIP) the geocoder returned, best match first. */
  candidates: LocationCandidate[];
  /**
   * True when there is exactly one distinct ZIP — the caller can use it
   * silently. When false (zero or several), the caller must ask the user.
   */
  unambiguous: boolean;
}

/**
 * Address → full location resolver backed by the **US Census Geocoder**
 * (https://geocoding.geo.census.gov) — free, no API key, US public-record
 * data. This is the ONLY place the property address leaves the machine, and it
 * is called solely when the ZIP (and often state) is missing from the user's
 * prompt. US-only: a Canadian address returns no candidates (the caller falls
 * back to asking).
 *
 * Deliberately NOT a BaseApi subclass: there's no auth, no per-env base URL,
 * and no Real prod-block concern (it never touches a *realbrokerage.com host).
 */
/** Census Geocoder base — already includes the `/geocoder` segment, so request
 * paths below must NOT repeat it (doing so 404s and silently returns empty). */
export const CENSUS_BASE_URL = "https://geocoding.geo.census.gov/geocoder";

export class GeocoderApi {
  private readonly http: AxiosInstance;

  constructor(http?: AxiosInstance) {
    this.http =
      http ??
      axios.create({
        baseURL: CENSUS_BASE_URL,
        timeout: 10_000,
        // We inspect status ourselves rather than letting axios throw.
        validateStatus: () => true,
        headers: { "User-Agent": "transaction-builder-agent/0.1 (+geocode)" },
      });
  }

  /**
   * Resolve a street + city (+ optional state) to distinct location candidates
   * (best match first), each carrying ZIP + derived state/country/currency.
   * Never throws on a no-match or transport hiccup — it returns an empty
   * candidate list so the caller cleanly falls back to asking the user. (A
   * missing ZIP must never become a hard failure of the flow.)
   */
  async resolve(input: {
    street: string;
    city: string;
    state?: string;
  }): Promise<LocationResult> {
    // The Census Geocoder is US-only. For a known Canadian province, don't
    // bother calling it — return empty so the caller asks for the postal code
    // directly (a US-only lookup would only ever miss on a Canadian address).
    if (input.state && CA_PROVINCE_SET.has(input.state)) return EMPTY;

    const params: Record<string, string> = {
      street: input.street,
      city: input.city,
      benchmark: "Public_AR_Current",
      format: "json",
    };
    // The enum value is underscored (NEW_YORK); the geocoder wants a plain name.
    if (input.state) params.state = input.state.replace(/_/g, " ");

    let raw: unknown;
    try {
      // Path is relative to CENSUS_BASE_URL (which already ends in /geocoder) —
      // do NOT prefix another /geocoder here or the URL doubles and 404s.
      const res = await this.http.get("/locations/address", { params });
      if (res.status < 200 || res.status >= 300) return EMPTY;
      raw = res.data;
    } catch {
      // Network/timeout/DNS — treat as "couldn't find it", let the caller ask.
      return EMPTY;
    }

    return dedupe(parseMatches(raw));
  }
}

const EMPTY: LocationResult = { candidates: [], unambiguous: false };

/** Pull location candidates out of the Census `result.addressMatches[]` shape. */
function parseMatches(raw: unknown): LocationCandidate[] {
  const matches = (raw as { result?: { addressMatches?: unknown } } | undefined)
    ?.result?.addressMatches;
  if (!Array.isArray(matches)) return [];
  const out: LocationCandidate[] = [];
  for (const m of matches) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const comp = (rec.addressComponents ?? {}) as Record<string, unknown>;
    const zip = asStr(comp.zip);
    if (!zip) continue;
    // Derive state/country/currency from the exact ZIP — same table pre_flight
    // uses — so we don't need a state-abbreviation map and stay consistent.
    const guess = guessFromPostalCode(zip);
    out.push({
      zip,
      matchedAddress: asStr(rec.matchedAddress) ?? "",
      city: asStr(comp.city),
      stateAbbrev: asStr(comp.state),
      state: guess?.state,
      country: guess?.country,
      currency: guess?.currency,
    });
  }
  return out;
}

/** Collapse to distinct ZIPs (a single address can return several matches). */
function dedupe(candidates: LocationCandidate[]): LocationResult {
  const seen = new Set<string>();
  const distinct: LocationCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.zip)) continue;
    seen.add(c.zip);
    distinct.push(c);
  }
  return { candidates: distinct, unambiguous: distinct.length === 1 };
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

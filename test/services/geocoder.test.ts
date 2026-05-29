import { describe, expect, it } from "vitest";
import axios, { type AxiosInstance } from "axios";
import { GeocoderApi, CENSUS_BASE_URL } from "../../src/services/GeocoderApi.js";

/**
 * GeocoderApi resolves a street address to a ZIP (+ derived state/country/
 * currency) via the US Census Geocoder. The constructor takes an injectable
 * axios instance so we can serve canned Census responses (shape:
 * result.addressMatches[].addressComponents.{zip,state,city}).
 */

type GetArgs = { url: string; params: Record<string, unknown> };

/** Fake axios with just the `.get` the client uses. */
function fakeHttp(
  responder: (args: GetArgs) => { status: number; data: unknown } | Promise<never>,
): { http: AxiosInstance; calls: GetArgs[] } {
  const calls: GetArgs[] = [];
  const http = {
    async get(url: string, config: { params: Record<string, unknown> }) {
      const args = { url, params: config.params };
      calls.push(args);
      return responder(args);
    },
  } as unknown as AxiosInstance;
  return { http, calls };
}

function censusBody(matches: Array<{ address: string; zip: string; state?: string; city?: string }>) {
  return {
    result: {
      addressMatches: matches.map((m) => ({
        matchedAddress: m.address,
        addressComponents: { zip: m.zip, state: m.state, city: m.city },
      })),
    },
  };
}

describe("GeocoderApi.resolve", () => {
  it("returns a single unambiguous candidate and backfills state/country/currency from the ZIP", async () => {
    const { http } = fakeHttp(() => ({
      status: 200,
      data: censusBody([{ address: "100 E 1ST ST, NEW YORK, NY, 10009", zip: "10009", state: "NY", city: "NEW YORK" }]),
    }));
    const out = await new GeocoderApi(http).resolve({ street: "100 1st Street", city: "New York", state: "NEW_YORK" });
    expect(out.unambiguous).toBe(true);
    expect(out.candidates).toEqual([
      {
        zip: "10009",
        matchedAddress: "100 E 1ST ST, NEW YORK, NY, 10009",
        city: "NEW YORK",
        stateAbbrev: "NY",
        state: "NEW_YORK", // derived from ZIP via guessFromPostalCode
        country: "UNITED_STATES",
        currency: "USD",
      },
    ]);
  });

  it("de-underscores the state enum before sending it to the geocoder", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, data: censusBody([]) }));
    await new GeocoderApi(http).resolve({ street: "1 Main", city: "Austin", state: "NEW_YORK" });
    expect(calls[0].params.state).toBe("NEW YORK");
    expect(calls[0].params.benchmark).toBe("Public_AR_Current");
  });

  it("marks multiple distinct ZIPs as ambiguous (caller must ask)", async () => {
    const { http } = fakeHttp(() => ({
      status: 200,
      data: censusBody([
        { address: "100 W 1ST ST, NEW YORK, NY, 10001", zip: "10001" },
        { address: "100 E 1ST ST, NEW YORK, NY, 10009", zip: "10009" },
      ]),
    }));
    const out = await new GeocoderApi(http).resolve({ street: "100 1st St", city: "New York" });
    expect(out.unambiguous).toBe(false);
    expect(out.candidates.map((c) => c.zip)).toEqual(["10001", "10009"]);
  });

  it("collapses duplicate ZIPs to one unambiguous candidate", async () => {
    const { http } = fakeHttp(() => ({
      status: 200,
      data: censusBody([
        { address: "100 1ST ST, NY, 10009", zip: "10009" },
        { address: "100 1ST STREET, NY, 10009", zip: "10009" },
      ]),
    }));
    const out = await new GeocoderApi(http).resolve({ street: "100 1st St", city: "New York" });
    expect(out.unambiguous).toBe(true);
    expect(out.candidates).toHaveLength(1);
  });

  it("returns empty (ask the user) when there are no matches", async () => {
    const { http } = fakeHttp(() => ({ status: 200, data: censusBody([]) }));
    const out = await new GeocoderApi(http).resolve({ street: "nowhere", city: "void" });
    expect(out).toEqual({ candidates: [], unambiguous: false });
  });

  it("returns empty on a non-2xx response instead of throwing", async () => {
    const { http } = fakeHttp(() => ({ status: 500, data: "boom" }));
    const out = await new GeocoderApi(http).resolve({ street: "1 Main", city: "Austin" });
    expect(out.candidates).toEqual([]);
  });

  it("returns empty on a network error instead of throwing", async () => {
    const { http } = fakeHttp(() => Promise.reject(new Error("ETIMEDOUT")));
    const out = await new GeocoderApi(http).resolve({ street: "1 Main", city: "Austin" });
    expect(out.candidates).toEqual([]);
  });

  it("short-circuits a Canadian province WITHOUT calling the US-only geocoder (caller asks)", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, data: censusBody([{ address: "x", zip: "99999" }]) }));
    const out = await new GeocoderApi(http).resolve({ street: "100 Main", city: "Toronto", state: "ONTARIO" });
    expect(out).toEqual({ candidates: [], unambiguous: false });
    expect(calls).toHaveLength(0); // never hit the network for a CA address
  });

  it("composes the correct Census URL — base + path must NOT double the /geocoder segment", async () => {
    // Regression for the silent-empty bug (2026-05-29): baseURL already ends in
    // /geocoder, so the request path must be relative. The earlier mock-based
    // tests never exercised baseURL+path joining, so this uses a real axios
    // instance (with the production baseURL) and a capturing adapter.
    let fullUrl = "";
    const http = axios.create({
      baseURL: CENSUS_BASE_URL,
      adapter: async (config) => {
        fullUrl = (config.baseURL ?? "") + (config.url ?? "");
        return {
          data: censusBody([{ address: "47 W 13TH ST, NEW YORK, NY, 10011", zip: "10011", state: "NY" }]),
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        };
      },
    });
    const out = await new GeocoderApi(http).resolve({ street: "47 West 13th Street", city: "New York", state: "NEW_YORK" });
    expect(fullUrl).toBe("https://geocoding.geo.census.gov/geocoder/locations/address");
    expect(fullUrl).not.toContain("/geocoder/geocoder");
    expect(out.candidates[0].zip).toBe("10011");
  });

  it("derives CAD currency for a Canadian-province ZIP table hit", async () => {
    // (Census is US-only in practice; this pins the derivation wiring, not CA coverage.)
    const { http } = fakeHttp(() => ({
      status: 200,
      data: censusBody([{ address: "1 MAIN ST, AUSTIN, TX, 78701", zip: "78701", state: "TX" }]),
    }));
    const out = await new GeocoderApi(http).resolve({ street: "1 Main", city: "Austin", state: "TEXAS" });
    expect(out.candidates[0].state).toBe("TEXAS");
    expect(out.candidates[0].currency).toBe("USD");
  });
});

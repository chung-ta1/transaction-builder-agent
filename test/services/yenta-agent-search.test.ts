import { describe, expect, it } from "vitest";
import type { AxiosRequestConfig } from "axios";
import { YentaAgentApi } from "../../src/services/YentaAgentApi.js";
import type { AuthService } from "../../src/auth/AuthService.js";
import type { Env } from "../../src/config.js";

/**
 * The `/search/active` endpoint matches a SINGLE `name` token with LIKE against
 * firstName OR lastName, and paginates. These tests pin the two client-side
 * workarounds in YentaAgentApi.searchAgents (see its docstring):
 *   1. search by the most selective single token, never a joined "First Last"
 *   2. walk every page, not just page 0
 */

type Agent = { id: string; firstName: string; lastName: string; email?: string };

/** Subclass that serves canned, paginated results keyed by the `name` token. */
class FakeYenta extends YentaAgentApi {
  calls: { name: string; pageNumber: number }[] = [];
  constructor(private readonly byToken: Record<string, Agent[]>) {
    super({} as unknown as AuthService);
  }
  // Override the network call. Mirrors yenta's paged shape (results + hasNext).
  protected async request<T>(_env: Env, config: AxiosRequestConfig): Promise<T> {
    const params = (config.params ?? {}) as Record<string, unknown>;
    const name = String(params.name);
    const pageNumber = Number(params.pageNumber);
    const pageSize = Number(params.pageSize);
    this.calls.push({ name, pageNumber });
    const all = this.byToken[name] ?? [];
    const start = pageNumber * pageSize;
    const slice = all.slice(start, start + pageSize);
    return {
      results: slice,
      pageNumber,
      pageSize,
      totalCount: all.length,
      hasNext: start + pageSize < all.length,
    } as unknown as T;
  }
}

const ENV: Env = "team1";

function agents(n: number, lastName: string): Agent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${lastName}-${i}`,
    firstName: `First${i}`,
    lastName,
  }));
}

describe("YentaAgentApi.searchAgents — token selection", () => {
  it("searches by the surname token, NOT the joined full name (the empty-result bug)", async () => {
    const joyner: Agent = { id: "joy-1", firstName: "Chung", lastName: "Joyner", email: "j@x.com" };
    const api = new FakeYenta({
      // The full-name string the OLD code sent matches nothing on this endpoint.
      "Chung Joyner": [],
      // The surname token is what actually resolves the agent.
      Joyner: [joyner],
    });

    const out = await api.searchAgents(ENV, { firstName: "Chung", lastName: "Joyner" });

    expect(api.calls.every((c) => c.name === "Joyner")).toBe(true);
    expect(out.map((a) => a.yentaId)).toEqual(["joy-1"]);
  });

  it("derives the surname from a free-text full-name query (last word)", async () => {
    const api = new FakeYenta({
      "Chung Joyner": [],
      Joyner: [{ id: "joy-1", firstName: "Chung", lastName: "Joyner" }],
    });
    const out = await api.searchAgents(ENV, { query: "Chung Joyner" });
    expect(api.calls[0].name).toBe("Joyner");
    expect(out).toHaveLength(1);
  });

  it("falls back to email when no name is given", async () => {
    const api = new FakeYenta({ "a@b.com": [{ id: "e-1", firstName: "A", lastName: "B", email: "a@b.com" }] });
    const out = await api.searchAgents(ENV, { email: "a@b.com" });
    expect(api.calls[0].name).toBe("a@b.com");
    expect(out).toHaveLength(1);
  });

  it("returns [] without calling the API when there is no token at all", async () => {
    const api = new FakeYenta({});
    const out = await api.searchAgents(ENV, {});
    expect(out).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });
});

describe("YentaAgentApi.searchAgents — pagination", () => {
  it("walks every page so a match past page 0 is still found", async () => {
    const roster = agents(45, "Smith"); // 3 pages at pageSize 20
    const target = roster[43]; // deep on the last page
    const api = new FakeYenta({ Smith: roster });

    const out = await api.searchAgents(ENV, { query: "Smith" });

    expect(api.calls.map((c) => c.pageNumber)).toEqual([0, 1, 2]);
    expect(out).toHaveLength(45);
    expect(out.some((a) => a.yentaId === target.id)).toBe(true);
  });

  it("stops after the first page when the server reports no more", async () => {
    const api = new FakeYenta({ Jones: agents(5, "Jones") });
    const out = await api.searchAgents(ENV, { query: "Jones" });
    expect(api.calls.map((c) => c.pageNumber)).toEqual([0]);
    expect(out).toHaveLength(5);
  });
});

describe("YentaAgentApi.searchAgents — client-side narrowing", () => {
  it("keeps only the matching first name when first + last are both given (homonyms across pages)", async () => {
    // 25 Lees spread over 2 pages; exactly one is Jordan Lee.
    const lees = agents(25, "Lee");
    lees[22] = { id: "jordan-lee", firstName: "Jordan", lastName: "Lee" };
    const api = new FakeYenta({ Lee: lees });

    const out = await api.searchAgents(ENV, { firstName: "Jordan", lastName: "Lee" });

    expect(out.map((a) => a.yentaId)).toEqual(["jordan-lee"]);
  });

  it("falls back to all token hits if the full-name filter matches nobody", async () => {
    const api = new FakeYenta({ Lee: agents(3, "Lee") }); // no 'Zzz Lee' exists
    const out = await api.searchAgents(ENV, { firstName: "Zzz", lastName: "Lee" });
    expect(out).toHaveLength(3); // disambiguation list, not a spurious empty
  });

  it("does not over-filter a single-token search", async () => {
    const api = new FakeYenta({ Chung: agents(3, "Chung") });
    const out = await api.searchAgents(ENV, { firstName: "Chung" });
    expect(out).toHaveLength(3);
  });

  it("matches case-insensitively (surname token differs only in case)", async () => {
    // Server LIKE on the exact-case surname returns nothing, but the firstName
    // token finds the roster; case-insensitive narrowing then resolves the agent.
    const target = { id: "tamember8", firstName: "Chung", lastName: "Tamember8" };
    const api = new FakeYenta({
      TaMember8: [], // case-sensitive server miss on the surname token
      Chung: [...agents(2, "Other"), target], // firstName token returns the roster
    });

    const out = await api.searchAgents(ENV, { firstName: "Chung", lastName: "TaMember8" });

    expect(out.map((a) => a.yentaId)).toEqual(["tamember8"]);
  });

  it("only falls through to the next token when the first returns ZERO rows", async () => {
    // Surname token returns rows → we must NOT also search the firstName token.
    const api = new FakeYenta({
      Lee: [{ id: "jordan-lee", firstName: "Jordan", lastName: "Lee" }],
      Jordan: agents(5, "Jordan"),
    });
    const out = await api.searchAgents(ENV, { firstName: "Jordan", lastName: "Lee" });
    expect(api.calls.every((c) => c.name === "Lee")).toBe(true);
    expect(out.map((a) => a.yentaId)).toEqual(["jordan-lee"]);
  });
});

import { BaseApi } from "./BaseApi.js";
import type { AuthService } from "../auth/AuthService.js";
import { urlsFor, type Env } from "../config.js";

export interface AgentCandidate {
  yentaId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  displayName?: string;
  officeId?: string;
  teamId?: string;
  teams?: TeamMembership[];
  country?: string;
  /**
   * yenta AgentStatus: CANDIDATE / ACTIVE / INACTIVE / REJECTED / etc.
   * arrakis refuses to put a CANDIDATE on a transaction (participant, partner,
   * or referral) with `InvalidAgentStatusException: Cannot initialize a
   * CANDIDATE agent`. We surface this field so the caller can lint BEFORE any
   * arrakis write, rather than discovering it at stage 6 of 12.
   */
  agentStatus?: string;
}

export interface TeamMembership {
  teamId: string;
  name: string;
  teamType?: string;
  flex?: boolean;
}

/**
 * Minimal yenta client for agent lookup by name/email. The precise search
 * endpoint in yenta is a paginated search; we expose a thin shape the agent
 * cares about.
 */
export class YentaAgentApi extends BaseApi {
  constructor(auth: AuthService) {
    super(auth, (env) => urlsFor(env).yenta);
  }

  /**
   * Search via yenta's `/search/active` endpoint (AgentController.searchActiveAgents).
   * This is the SAME endpoint Bolt's co-agent picker calls, and it works for a
   * normal agent. The older `/search/lite` path 403s ("Not authorized") for
   * non-admin callers — verified 2026-05-29 against team1 — so it must NOT be
   * used here.
   *
   * Three things the server does that this client has to work around (all
   * confirmed against the AgentController.searchActiveAgents Specification on
   * 2026-05-29):
   *
   * 1. The `name` filter is a SINGLE token matched with `LIKE %name%` against
   *    `firstName` OR `lastName` — NOT a firstName-AND-lastName filter. So a
   *    joined "First Last" string LIKE-matches neither column and returns zero
   *    rows. We therefore search by the most SELECTIVE single token (an explicit
   *    lastName, else the surname word of a free-text query, else the first
   *    name / email) and narrow on the remaining words client-side.
   * 2. The response is PAGINATED and sorted (FIRST_NAME, LAST_NAME). The match
   *    may not be on page 0 — a common surname pushes it onto a later page. So
   *    we walk pages (bounded) until the server reports no more, accumulating
   *    candidates, instead of reading only the first 20 and declaring "no match".
   * 3. The server's `LIKE` can MISS ON CASE for some records — `name=TaMember8`
   *    returned zero rows while the stored surname was `Tamember8` (verified
   *    2026-05-29). A single case-sensitive miss must NOT be reported as "no
   *    such agent": we try the candidate tokens in selectivity order and fall
   *    through to the next one whenever the server returns zero rows, then
   *    narrow the survivors CASE-INSENSITIVELY. Only when EVERY token comes back
   *    empty do we return no match.
   *
   * `sortBy` is a `List<AgentSearchSortBy>` sent as repeated-key (`indexes: null`).
   */
  async searchAgents(env: Env, query: {
    firstName?: string;
    lastName?: string;
    email?: string;
    query?: string;
  }): Promise<AgentCandidate[]> {
    const queryWords = query.query?.trim() ? query.query.trim().split(/\s+/) : [];
    const nameWords = [query.firstName, query.lastName, ...queryWords]
      .map((w) => w?.trim())
      .filter((w): w is string => !!w);

    // Candidate single tokens to search, most selective first. An explicit
    // lastName beats the surname word of a free-text query (last word in
    // "First Last" order), which beats the first name; email is the last resort.
    // Never the joined full name (bug #1). De-duplicated case-insensitively so a
    // first==last token isn't searched twice. We try the first that yields rows,
    // falling through on a zero-row (case-miss) response (bug #3).
    const searchTokens: string[] = [];
    const pushToken = (t?: string): void => {
      const v = t?.trim();
      if (v && !searchTokens.some((x) => x.toLowerCase() === v.toLowerCase())) searchTokens.push(v);
    };
    pushToken(query.lastName);
    pushToken(nameWords[nameWords.length - 1]);
    pushToken(query.firstName);
    pushToken(query.email);

    if (searchTokens.length === 0) return [];

    // Walk pages until the server says there are no more (bug #2). MAX_PAGES is
    // a safety cap so a bare common token can't loop unbounded; surname searches
    // are selective enough that this is almost always a single page. Try the
    // next token only when the current returns ZERO rows (bug #3).
    const PAGE_SIZE = 20;
    const MAX_PAGES = 25;
    let accumulated: AgentCandidate[] = [];
    for (const searchToken of searchTokens) {
      accumulated = [];
      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
        const raw = await this.request<unknown>(env, {
          method: "GET",
          url: `/api/v1/agents/search/active`,
          params: {
            pageNumber,
            pageSize: PAGE_SIZE,
            sortBy: ["FIRST_NAME", "LAST_NAME"],
            sortDirection: "ASC",
            name: searchToken,
          },
          paramsSerializer: { indexes: null },
        });
        accumulated.push(...normalize(raw));
        if (!hasMorePages(raw, pageNumber, PAGE_SIZE)) break;
      }
      if (accumulated.length > 0) break;
    }

    // With only one search word there's nothing to narrow on — return every hit.
    // With more (e.g. first + last), keep candidates matching ALL words so a
    // same-surname homonym on another page doesn't masquerade as the match.
    // Matching is CASE-INSENSITIVE (needles + haystack both lowercased) so a
    // capitalization difference ("TaMember8" vs "Tamember8") doesn't drop a real
    // agent. If the full-name filter empties, fall back to the raw token hits so
    // the caller can still disambiguate rather than seeing a spurious "no match".
    if (nameWords.length <= 1) return accumulated;
    const needles = nameWords.map((w) => w.toLowerCase());
    const filtered = accumulated.filter((a) => {
      const hay = `${a.firstName ?? ""} ${a.lastName ?? ""} ${a.displayName ?? ""} ${a.email ?? ""}`.toLowerCase();
      return needles.every((n) => hay.includes(n));
    });
    return filtered.length ? filtered : accumulated;
  }

  /**
   * GET /api/v1/users/{yentaId} — fetch a specific agent by id. Used for
   * pre-write status linting (catch CANDIDATE/INACTIVE before an arrakis
   * write rejects it). Returns undefined on 404.
   */
  async getAgent(env: Env, yentaId: string): Promise<AgentCandidate | undefined> {
    const raw = await this.request<unknown>(env, {
      method: "GET",
      url: `/api/v1/users/${yentaId}`,
    });
    return mapAgentResponse(raw);
  }

  /**
   * GET /api/v1/users/me — returns the yenta `AgentResponse` shape for the
   * currently-authenticated user (UserController.getCurrentUser maps this
   * to `getUserById(authUserId, true, false)`). A prior version pointed at
   * `/users/myself`, which 404'd silently and made `verify_auth` return an
   * empty identity — the agent then asked the user for their yentaId,
   * which no human knows. Keep this path in sync with yenta.
   */
  async getMyself(env: Env): Promise<AgentCandidate | undefined> {
    const raw = await this.request<unknown>(env, {
      method: "GET",
      url: `/api/v1/users/me`,
    });
    return mapAgentResponse(raw);
  }
}

function mapAgentResponse(raw: unknown): AgentCandidate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const id = (r.id ?? r.yentaId) as string | undefined;
  if (!id) return undefined;
  const officeId =
    asString(r.officeId) ??
    firstOfficeId(r.offices) ??
    asString((r.primaryOffice as Record<string, unknown> | undefined)?.id);
  return {
    yentaId: id,
    firstName: asString(r.firstName),
    lastName: asString(r.lastName),
    email: asString(r.emailAddress ?? r.email),
    displayName: asString(r.displayName ?? r.fullName),
    officeId,
    teamId: asString(r.teamId),
    teams: extractTeams(r.teamMemberships),
    country: asString(r.country),
    agentStatus: asString(r.agentStatus ?? r.status ?? r.userStatus),
  };
}

function extractTeams(v: unknown): TeamMembership[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: TeamMembership[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const teamId = asString(e.teamId);
    const name = asString(e.teamName) ?? asString(e.name);
    if (!teamId || !name) continue;
    out.push({
      teamId,
      name,
      teamType: asString(e.teamType),
      flex: typeof e.flex === "boolean" ? e.flex : undefined,
    });
  }
  return out.length ? out : undefined;
}

function normalize(raw: unknown): AgentCandidate[] {
  if (!raw || typeof raw !== "object") return [];
  // yenta paginated response exposes `results` or `content` depending on version.
  const obj = raw as Record<string, unknown>;
  const list = (obj.results ?? obj.content ?? obj.items ?? []) as unknown[];
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const e = entry as Record<string, unknown>;
    return {
      yentaId: asString(e.id ?? e.yentaId) ?? "",
      firstName: asString(e.firstName),
      lastName: asString(e.lastName),
      email: asString(e.emailAddress ?? e.email),
      displayName: asString(e.displayName ?? e.fullName),
      officeId: asString(e.officeId),
      teamId: asString(e.teamId),
      country: asString(e.country),
      agentStatus: asString(e.agentStatus ?? e.status ?? e.userStatus),
    };
  }).filter((a) => a.yentaId);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Whether the paginated `/search/active` response has another page after the
 * one just read. yenta's paged shape exposes `hasNext` directly on some
 * versions; otherwise derive it from `totalPages`, then `totalCount` /
 * `totalElements`, vs the page just consumed. If no metadata is present, treat
 * a completely-filled page as "maybe more" so we don't stop one short.
 */
function hasMorePages(raw: unknown, pageNumber: number, pageSize: number): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.hasNext === "boolean") return o.hasNext;
  const totalPages = asNumber(o.totalPages);
  if (totalPages != null) return pageNumber + 1 < totalPages;
  const totalCount = asNumber(o.totalCount ?? o.totalElements);
  if (totalCount != null) return (pageNumber + 1) * pageSize < totalCount;
  const list = (o.results ?? o.content ?? o.items) as unknown;
  return Array.isArray(list) && list.length === pageSize;
}

/**
 * Some yenta AgentResponse shapes surface the user's offices as an array of
 * `{ id, name, ... }`; pick the first one as a best-effort officeId when a
 * top-level `officeId` isn't set.
 */
function firstOfficeId(v: unknown): string | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const first = v[0];
  if (first && typeof first === "object") {
    return asString((first as Record<string, unknown>).id);
  }
  return undefined;
}

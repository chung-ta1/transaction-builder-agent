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
   * Search via yenta's `/search/lite` endpoint (AgentController.searchWithLiteResponse).
   * Prefers direct param filters (firstName / lastName / email) over the
   * free-text `searchText` — narrows the result set and makes name+email
   * disambiguation reliable. `sortBy` is a `List<AgentSearchSortBy>` on the
   * server, so we send it as repeated-key (`indexes: null`) with the enum
   * value `LAST_NAME` (not the legacy `createdAt` string).
   */
  async searchAgents(env: Env, query: {
    firstName?: string;
    lastName?: string;
    email?: string;
    query?: string;
  }): Promise<AgentCandidate[]> {
    const params: Record<string, string | number | boolean | string[]> = {
      pageNumber: 0,
      pageSize: 10,
      sortBy: ["LAST_NAME"],
      sortDirection: "ASC",
    };
    if (query.firstName) params.firstName = query.firstName;
    if (query.lastName) params.lastName = query.lastName;
    if (query.email) params.email = query.email;
    if (query.query && !query.firstName && !query.lastName && !query.email) {
      params.searchText = query.query;
    }

    const raw = await this.request<unknown>(env, {
      method: "GET",
      url: `/api/v1/agents/search/lite`,
      params,
      paramsSerializer: { indexes: null },
    });

    return normalize(raw);
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
    };
  }
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
    };
  }).filter((a) => a.yentaId);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
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

import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { AuthService } from "../auth/AuthService.js";
import type { Env } from "../config.js";

/**
 * Shared axios wrapper. Handles:
 *   - attaching Bearer token (fetched lazily from AuthService)
 *   - 401 retry: invalidate the cached token, reopen the browser, retry once
 *   - consistent error shape for tool callers
 */
export class BaseApi {
  private readonly clients = new Map<Env, AxiosInstance>();

  constructor(
    private readonly auth: AuthService,
    private readonly baseUrlFor: (env: Env) => string,
  ) {}

  protected client(env: Env): AxiosInstance {
    let existing = this.clients.get(env);
    if (existing) return existing;

    const instance = axios.create({
      baseURL: this.baseUrlFor(env),
      timeout: 30_000,
      validateStatus: () => true, // we inspect status ourselves
    });
    this.clients.set(env, instance);
    return instance;
  }

  /**
   * Make a request with auth + 401/403 retry. Throws ApiError on non-2xx.
   *
   * 401 = unauthenticated (token missing/malformed) — always re-auth.
   * 403 = forbidden. Two flavors:
   *   (a) authenticated but not authorized for this resource — arrakis
   *       returns a real error body like "You cannot assign a commission
   *       split to a domestic team member". Don't re-auth, throw as-is.
   *   (b) token revoked / stale session — Real's ingress/keymaker layer
   *       returns 403 with an EMPTY body (no JSON message). We can't
   *       distinguish this at the HTTP layer, but the empty-body signal
   *       is reliable in practice. Treat as auth failure and re-auth.
   *
   * Verified 2026-04-20: a multi-day-stale JWT against yenta team1
   * produced 403 with empty body; user had to restart Claude Code to
   * recover. This retry path fixes that.
   */
  protected async request<T>(env: Env, config: AxiosRequestConfig): Promise<T> {
    const first = await this.attempt<T>(env, config);
    if (!needsReauth(first.status, first.data, await this.tokenAge(env))) {
      return this.unwrap<T>(first);
    }
    await this.auth.invalidate(env);
    const retry = await this.attempt<T>(env, config);
    return this.unwrap<T>(retry);
  }

  private async tokenAge(env: Env): Promise<number> {
    const cached = await this.auth.peek(env);
    return cached?.obtainedAt ? Date.now() - cached.obtainedAt : Infinity;
  }

  private async attempt<T>(
    env: Env,
    config: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    const bearer = await this.auth.getBearer(env);
    const headers = {
      ...(config.headers ?? {}),
      Authorization: `Bearer ${bearer}`,
    };
    // axios is configured with validateStatus: () => true, so it does not throw
    // on HTTP status — status branching happens in `unwrap`. A throw here is a
    // genuine network/transport error; let it propagate unchanged.
    return this.client(env).request<T>({ ...config, headers });
  }

  private unwrap<T>(res: AxiosResponse<T>): T {
    if (res.status >= 200 && res.status < 300) {
      return res.data;
    }
    throw new ApiError(res.status, messageOf(res), res.data);
  }
}

/** ms after which an empty-body 403 might plausibly be a revoked/stale session. */
const STALE_TOKEN_MS = 120_000;

/**
 * 401 = unauthenticated → always re-auth.
 * 403 = forbidden. An empty body is ambiguous: a revoked/stale token at Real's
 *   auth layer (re-auth recovers it) vs an authorization denial on a VALID token
 *   (re-auth can't fix it — and reopening the browser pops a confusing SECOND
 *   login + discards a good token; verified 2026-05-23 with an agent lacking
 *   transaction-create permission, which 403s with an empty body). A token
 *   minted moments ago is NOT stale, so a 403 on it is authorization → do NOT
 *   re-auth. Only re-auth an empty-body 403 when the token is old enough to
 *   plausibly be a revoked session.
 * 403 with a real authorization message → never re-auth; surface it.
 */
export function needsReauth(status: number, body: unknown, tokenAgeMs: number): boolean {
  if (status === 401) return true;
  if (status !== 403 || !isEmptyBody(body)) return false;
  return tokenAgeMs > STALE_TOKEN_MS;
}

export function isEmptyBody(body: unknown): boolean {
  if (body == null) return true;
  if (typeof body === "string") return body.trim().length === 0;
  if (typeof body === "object") {
    const obj = unwrapArrakisError(body as Record<string, unknown>);
    return !(obj.message ?? obj.error ?? obj.detail);
  }
  return false;
}

/**
 * arrakis (real-commons) wraps errors in a single-key envelope keyed by the
 * Java class name: `{ "com.real.commons.apierror.ApiError": { message, ... } }`.
 * The real message lives one level down, so a check for a top-level `message`
 * sees nothing and would misread an authorization 403 as an empty-body (stale
 * session) one — discarding a valid token and reopening the browser. Peel the
 * envelope before inspecting. Verified 2026-05-27: a nested-message 403 on
 * /listings/search popped a spurious second sign-in.
 */
function unwrapArrakisError(obj: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0].startsWith("com.real.commons.apierror")) {
    const inner = obj[keys[0]];
    if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  }
  return obj;
}

function messageOf(res: AxiosResponse): string {
  const body = res.data;
  if (body == null) return `HTTP ${res.status}`;
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    const bodyObj = body as Record<string, unknown>;
    const m = (bodyObj.message ?? bodyObj.error ?? bodyObj.detail) as string | undefined;
    if (m) return m;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return `HTTP ${res.status}`;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

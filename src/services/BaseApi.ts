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
    const first = await this.attempt<T>(env, config, false);
    if (!shouldReauth(first)) {
      return this.unwrap<T>(first);
    }
    await this.auth.invalidate(env);
    const retry = await this.attempt<T>(env, config, true);
    return this.unwrap<T>(retry);
  }

  private async attempt<T>(
    env: Env,
    config: AxiosRequestConfig,
    isRetry: boolean,
  ): Promise<AxiosResponse<T>> {
    const bearer = await this.auth.getBearer(env);
    const headers = {
      ...(config.headers ?? {}),
      Authorization: `Bearer ${bearer}`,
    };
    try {
      return await this.client(env).request<T>({ ...config, headers });
    } catch (err) {
      if (isRetry) throw err;
      throw err;
    }
  }

  private unwrap<T>(res: AxiosResponse<T>): T {
    if (res.status >= 200 && res.status < 300) {
      return res.data;
    }
    throw new ApiError(res.status, messageOf(res), res.data);
  }
}

function shouldReauth(res: AxiosResponse): boolean {
  if (res.status === 401) return true;
  if (res.status !== 403) return false;
  // 403 with an empty body is the signature of a revoked/stale token at
  // Real's auth layer. 403 with a real authorization message (arrakis's
  // own authz rules) has a body — leave those alone.
  const body = res.data;
  if (body == null) return true;
  if (typeof body === "string") return body.trim().length === 0;
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    return !(obj.message ?? obj.error ?? obj.detail);
  }
  return false;
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

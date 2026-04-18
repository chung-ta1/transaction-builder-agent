import { TokenCache, type CachedToken } from "./TokenCache.js";
import { runBrowserLogin } from "./BrowserLoginServer.js";
import type { Env } from "../config.js";

/**
 * Orchestrates: check cache → if miss, open the browser-login helper → cache
 * the result. Callers ask for a bearer for an env; this class handles the rest.
 *
 * On 401, callers invoke `invalidate(env)` and retry — the next `getBearer`
 * will re-open the browser, the OS password manager auto-fills, user presses
 * Enter, and we're back.
 *
 * Non-blocking variants (`peek`, `startLogin`) exist so `verify_auth` can
 * return within Claude Desktop's ~60s tool-call timeout even when the user
 * takes longer than that to complete sign-in. The MCP server keeps the
 * browser-login server running in the background; later authenticated calls
 * reuse the in-flight promise via `getBearer`.
 */
export class AuthService {
  private readonly cache: TokenCache;
  private readonly inFlight = new Map<Env, Promise<CachedToken>>();

  constructor(cache?: TokenCache) {
    this.cache = cache ?? new TokenCache();
  }

  /**
   * Non-blocking cache probe. Returns the cached token if present, without
   * starting a browser login. Use this to answer "am I already signed in?"
   * without risking a 60s+ wait.
   */
  async peek(env: Env): Promise<CachedToken | undefined> {
    return this.cache.get(env);
  }

  /**
   * Kick off browser login and return the in-flight promise immediately
   * (without awaiting it). If a login is already in flight for this env, the
   * existing promise is returned — safe to call concurrently.
   *
   * Callers that want to wait for the token should `await` the returned
   * promise; callers that just want to start the flow can drop it on the
   * floor.
   */
  startLogin(env: Env, prefillEmail?: string): Promise<CachedToken> {
    const pending = this.inFlight.get(env);
    if (pending) return pending;

    const login = runBrowserLogin(env, prefillEmail)
      .then(async (result) => {
        const token: CachedToken = {
          accessToken: result.accessToken,
          email: result.email,
        };
        await this.cache.set(env, token, { persist: result.remember !== false });
        return token;
      })
      .finally(() => {
        this.inFlight.delete(env);
      });

    this.inFlight.set(env, login);
    return login;
  }

  async getBearer(env: Env, prefillEmail?: string): Promise<string> {
    const token = await this.getCachedOrLogin(env, prefillEmail);
    return token.accessToken;
  }

  /**
   * Called by API clients on a 401. Drops the cached token; the next
   * `getBearer` call will trigger a fresh browser login.
   */
  async invalidate(env: Env): Promise<void> {
    await this.cache.clear(env);
  }

  private async getCachedOrLogin(env: Env, prefillEmail?: string): Promise<CachedToken> {
    const cached = await this.cache.get(env);
    if (cached) return cached;
    return this.startLogin(env, prefillEmail);
  }
}

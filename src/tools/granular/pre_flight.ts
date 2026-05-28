import { z } from "zod";
import { defineTool, fail, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { guessFromPostalCode } from "../../util/zipLookup.js";
import type { AgentCandidate } from "../../services/YentaAgentApi.js";
import { ApiError } from "../../services/BaseApi.js";

/**
 * How long pre_flight(waitForLogin) blocks per call before returning
 * loginPending so the caller can poll again. Kept under the MCP transport
 * timeout — the agent loops the call until authenticated, so a slow sign-in
 * just means a few iterations rather than one long hang. Override for tests.
 */
const LOGIN_WAIT_MS = Number(process.env.TRANSACTION_AGENT_LOGIN_WAIT_MS) || 25_000;

interface AuthState {
  authenticated: boolean;
  user?: AgentCandidate;
  loginPending?: true;
  message?: string;
}

interface LocationGuess {
  postalCode: string;
  state: string;
  country: "UNITED_STATES" | "CANADA";
  currency: "USD" | "CAD";
}

interface PreFlightResult {
  auth: AuthState;
  /**
   * Any US ZIPs or Canadian postal codes extracted from the user's prompt,
   * with state/country/currency already resolved server-side so the agent
   * doesn't have to guess. Deduped and ordered by first appearance.
   */
  locationGuesses: LocationGuess[];
}

/**
 * Consolidated pre-flight call. Does in a single round-trip:
 *   - Non-blocking auth probe: returns the user's identity immediately if a
 *     cached token exists, or kicks off the browser login in the background
 *     without waiting for sign-in.
 *   - Postal-code → state/country/currency extraction from the user's prompt
 *     so the agent doesn't need to ask for state when the ZIP alone is enough.
 *   - Optional sign-out (forceFresh) — clears the cached token before probing,
 *     forcing a new browser login. Use when the user says "I'm not <cached
 *     identity>" or wants to switch accounts.
 */
export const preFlight = defineTool({
  name: "pre_flight",
  description:
    "Pre-flight for any transaction flow. Probes auth AND extracts any US ZIPs or Canadian postal codes from the user's prompt, pre-resolving state + country + currency. Default probe is non-blocking (returns loginPending immediately, opening the browser). Pass waitForLogin=true to BLOCK (briefly) until the user finishes signing in — reuses the already-open login (no second browser); returns authenticated once the token lands, or loginPending if the wait elapses (call again to keep waiting). This is how the agent auto-continues after sign-in without a second user message. Pass forceFresh=true to invalidate the cached token first (use when the user says they're not the cached identity, or wants to switch envs/accounts).",
  input: z.object({
    env: envSchema,
    userPrompt: z.string().min(1).describe("The user's original request, verbatim."),
    forceFresh: z.boolean().default(false).describe("Clear the cached token before probing. Triggers a fresh browser login. Use only when the user explicitly wants to switch identity."),
    waitForLogin: z.boolean().default(false).describe("Block until the user finishes the in-progress browser login (bounded; reuses the open login, never opens a second). Returns authenticated when the token lands, or loginPending if the wait elapses — loop until authenticated to auto-continue after sign-in."),
  }),
  async handler({ env, userPrompt, forceFresh, waitForLogin }, { auth, yenta }): Promise<ToolResult<PreFlightResult>> {
    const locationGuesses = extractPostalCodes(userPrompt);

    try {
      if (forceFresh) await auth.invalidate(env);
      const cached = forceFresh ? null : await auth.peek(env);
      if (cached) {
        const user = await yenta.getMyself(env);
        return ok({
          auth: { authenticated: true, user },
          locationGuesses,
        });
      }
      if (waitForLogin) {
        // Reuse the already-open login (startLogin dedupes — no second browser)
        // and wait up to LOGIN_WAIT_MS for the user to finish. If they do, we
        // return authenticated and the agent continues in the SAME turn — no
        // second user message needed. If the wait elapses, return loginPending
        // (the background login keeps running) so the agent can call again.
        const TIMED_OUT = Symbol("timed_out");
        const outcome = await Promise.race([
          auth.startLogin(env).then(() => "ok" as const).catch(() => "failed" as const),
          new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), LOGIN_WAIT_MS)),
        ]);
        if (outcome === "ok") {
          const user = await yenta.getMyself(env);
          return ok({ auth: { authenticated: true, user }, locationGuesses });
        }
        return ok({
          auth: {
            authenticated: false,
            loginPending: true,
            message: `Still waiting for sign-in to ${env}. Call pre_flight again with waitForLogin=true to keep waiting.`,
          },
          locationGuesses,
        });
      }
      // Pure probe — do NOT open the browser here. The browser opens in exactly
      // ONE place: the waitForLogin branch above. Previously this path eagerly
      // started a login (one tab) and then the agent's waitForLogin call started
      // another — two login-capable calls, which intermittently left a SECOND
      // tab open (verified 2026-05-22/23). Now the flow is: probe (here, no
      // browser) → present summary → pre_flight(waitForLogin) opens the login +
      // waits. Other skills that just make an authenticated call still get a
      // lazy browser via AuthService.getBearer.
      return ok({
        auth: {
          authenticated: false,
          loginPending: true,
          message: `Not signed in to ${env}. Call pre_flight again with waitForLogin=true to open the browser login and wait — it auto-continues the moment sign-in completes (and never opens a second tab).`,
        },
        locationGuesses,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        return fail(err.message, { status: err.status, body: err.body });
      }
      if (err instanceof Error) return fail(err.message);
      return fail(String(err));
    }
  },
});

/**
 * Pull every US ZIP (5-digit, optional +4) and Canadian postal code
 * (A1A 1A1) out of the prompt, dedupe, resolve each via the lookup table.
 * Unknown prefixes are dropped — better to ask than to guess wrong on an
 * address field.
 */
function extractPostalCodes(prompt: string): LocationGuess[] {
  const results: LocationGuess[] = [];
  const seen = new Set<string>();
  // Canadian first — its pattern is more restrictive so it won't match a
  // random 5-digit sequence.
  const caRegex = /\b([ABCEGHJKLMNPRSTVXY]\d[A-Z])\s?(\d[A-Z]\d)\b/gi;
  const usRegex = /\b(\d{5})(?:-\d{4})?\b/g;
  for (const match of prompt.matchAll(caRegex)) {
    const code = `${match[1]} ${match[2]}`.toUpperCase();
    pushIfNew(results, seen, code);
  }
  for (const match of prompt.matchAll(usRegex)) {
    const code = match[1];
    pushIfNew(results, seen, code);
  }
  return results;
}

function pushIfNew(out: LocationGuess[], seen: Set<string>, code: string): void {
  if (seen.has(code)) return;
  const guess = guessFromPostalCode(code);
  if (!guess) return;
  seen.add(code);
  out.push({
    postalCode: code,
    state: guess.state,
    country: guess.country,
    currency: guess.currency,
  });
}

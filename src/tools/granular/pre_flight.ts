import { z } from "zod";
import { defineTool, fail, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { guessFromPostalCode } from "../../util/zipLookup.js";
import type { AgentCandidate } from "../../services/YentaAgentApi.js";
import { ApiError } from "../../services/BaseApi.js";

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
 * Consolidated pre-flight call. Does in a single round-trip what the
 * runbook's step 0 would otherwise need two calls for:
 *   - Non-blocking auth probe (same behavior as `verify_auth`): returns the
 *     user's identity immediately if a cached token exists, or kicks off
 *     the browser login in the background without waiting for sign-in.
 *   - Deterministic postal-code → state/country/currency extraction from
 *     the user's original prompt, so the agent doesn't need to ask for
 *     state when the ZIP alone is enough.
 *
 * Saves a round-trip and removes two entire classes of "did you mean state
 * X?" clarifying questions from the typical flow.
 */
export const preFlight = defineTool({
  name: "pre_flight",
  description:
    "Pre-flight for the transaction flow. Probes auth (non-blocking — returns immediately even if sign-in is in progress) AND extracts any US ZIPs or Canadian postal codes from the user's prompt, pre-resolving state + country + currency. Call this instead of verify_auth at step 0 when you have the user's original prompt; saves a round-trip and eliminates the 'what state?' question when a ZIP was given.",
  input: z.object({
    env: envSchema,
    userPrompt: z.string().min(1).describe("The user's original request, verbatim."),
  }),
  async handler({ env, userPrompt }, { auth, yenta }): Promise<ToolResult<PreFlightResult>> {
    const locationGuesses = extractPostalCodes(userPrompt);

    try {
      const cached = await auth.peek(env);
      if (cached) {
        const user = await yenta.getMyself(env);
        return ok({
          auth: { authenticated: true, user },
          locationGuesses,
        });
      }
      auth.startLogin(env).catch((err) => {
        console.error(`[transaction-agent] background login failed for ${env}:`, err);
      });
      return ok({
        auth: {
          authenticated: false,
          loginPending: true,
          message: `Browser opened for sign-in to ${env}. Complete sign-in; subsequent tool calls will proceed automatically once the token is cached.`,
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

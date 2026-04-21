import { z } from "zod";
import { defineTool, fail, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import type { AgentCandidate } from "../../services/YentaAgentApi.js";
import { ApiError } from "../../services/BaseApi.js";

type VerifyAuthResult =
  | { authenticated: true; user: AgentCandidate | undefined }
  | { authenticated: false; loginPending: true; message: string };

/**
 * Non-blocking auth probe. If we already have a cached token, validate it
 * against yenta (/users/myself) and return the user's identity immediately.
 * If there's no cached token, kick off the browser-login helper in the
 * background and return a pending-login response right away — without
 * waiting for the user to actually sign in.
 *
 * Why non-blocking: Claude Desktop has a ~60s tool-call timeout. If the user
 * is slow to complete sign-in (password manager lag, MFA, etc.), blocking
 * here causes the whole tool call to time out and the flow fails before
 * anything useful has happened. Returning fast means the browser stays
 * open, the user signs in at their own pace, and the NEXT authenticated
 * tool call (search_agent_by_name, add_partner_agent, …) reuses the
 * now-cached token silently.
 */
export const verifyAuth = defineTool({
  name: "verify_auth",
  description:
    "Non-blocking auth probe. Returns {authenticated:true, user} immediately when a cached token exists. Otherwise opens the browser-login helper in the background and returns {authenticated:false, loginPending:true} without waiting. Call at pre-flight; subsequent authenticated tool calls will block on the pending login until it completes.",
  input: z.object({
    env: envSchema,
  }),
  async handler({ env }, { auth, yenta }): Promise<ToolResult<VerifyAuthResult>> {
    try {
      const cached = await auth.peek(env);
      if (cached) {
        const user = await yenta.getMyself(env);
        return ok({ authenticated: true, user });
      }
      // No cached token — kick off the browser login in the background and
      // return a pending-login response without awaiting sign-in completion.
      // The promise lives on AuthService.inFlight; the next getBearer call
      // (from any authenticated tool) will await it.
      auth.startLogin(env).catch((err) => {
        console.error(`[transaction-builder-agent] background login failed for ${env}:`, err);
      });
      return ok({
        authenticated: false,
        loginPending: true,
        message:
          `Browser opened for sign-in to ${env}. Complete sign-in; subsequent tool calls will proceed automatically once the token is cached.`,
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

import { z } from "zod";
import { defineTool, fail, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";

interface SignOutResult {
  env: string;
  cleared: true;
  message: string;
}

/**
 * Drops the cached bearer token for `env` from BOTH the in-memory tier and
 * the OS keychain. Use when:
 *   - The user explicitly says "I'm not <cached user>" or "log me out".
 *   - A shared workstation switched operators mid-session.
 *   - An automated test wants to force a fresh login branch.
 *
 * After a successful call, the next `pre_flight` / `verify_auth` will open
 * the browser-login helper because there's no cached token for `env`.
 */
export const signOut = defineTool({
  name: "sign_out",
  description:
    "Clear the cached auth token for an env (memory + keychain) so the next pre_flight / verify_auth triggers a fresh browser login. Use when the user says they're not the cached identity.",
  input: z.object({
    env: envSchema,
  }),
  async handler({ env }, { auth }): Promise<ToolResult<SignOutResult>> {
    try {
      await auth.invalidate(env);
      return ok({
        env,
        cleared: true,
        message: `Cached token for ${env} cleared. Next authenticated call will open the browser for sign-in.`,
      });
    } catch (err) {
      if (err instanceof Error) return fail(err.message);
      return fail(String(err));
    }
  },
});

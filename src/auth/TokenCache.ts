import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { Env } from "../config.js";

const KEYCHAIN_SERVICE = "transaction-builder-agent.keymaker";
const KEYCHAIN_DISABLED = process.env.TRANSACTION_AGENT_NO_KEYCHAIN === "1";

export interface CachedToken {
  accessToken: string;
  email?: string;
}

/**
 * Two-tier cache: in-memory (fast) and OS keychain (persists across restarts).
 * The keychain tier is best-effort — failures are swallowed since the in-memory
 * tier alone is enough to keep the MCP functional.
 */
export class TokenCache {
  private readonly memory = new Map<Env, CachedToken>();

  async get(env: Env): Promise<CachedToken | undefined> {
    const mem = this.memory.get(env);
    if (mem) return mem;

    const fromKeychain = await this.readKeychain(env);
    if (fromKeychain) {
      this.memory.set(env, fromKeychain);
      return fromKeychain;
    }
    return undefined;
  }

  /**
   * Stores a token in memory and (by default) in the OS keychain so it
   * survives MCP restarts. Pass `{ persist: false }` for session-only
   * caching — typically when the user unchecked "Remember me" on a shared
   * machine.
   */
  async set(env: Env, token: CachedToken, opts: { persist?: boolean } = {}): Promise<void> {
    this.memory.set(env, token);
    const persist = opts.persist !== false;
    if (persist) {
      await this.writeKeychain(env, token);
    } else {
      // Drop any existing persisted copy so a prior "remember me" doesn't
      // silently resurrect after an explicit opt-out.
      await this.deleteKeychain(env);
    }
  }

  async clear(env: Env): Promise<void> {
    this.memory.delete(env);
    await this.deleteKeychain(env);
  }

  // ---- macOS Keychain via `security` CLI ----

  private async readKeychain(env: Env): Promise<CachedToken | undefined> {
    if (KEYCHAIN_DISABLED || platform() !== "darwin") return undefined;
    const raw = await this.runSecurity([
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      env,
      "-w",
    ]);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw.trim()) as CachedToken;
    } catch {
      return undefined;
    }
  }

  private async writeKeychain(env: Env, token: CachedToken): Promise<void> {
    if (KEYCHAIN_DISABLED || platform() !== "darwin") return;
    // -U updates if exists.
    await this.runSecurity([
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      env,
      "-w",
      JSON.stringify(token),
      "-U",
    ]);
  }

  private async deleteKeychain(env: Env): Promise<void> {
    if (KEYCHAIN_DISABLED || platform() !== "darwin") return;
    await this.runSecurity(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", env]);
  }

  private runSecurity(args: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      const child = spawn("security", args, { stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("error", () => resolve(undefined));
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else resolve(undefined);
      });
    });
  }
}

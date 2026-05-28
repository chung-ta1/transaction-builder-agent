import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import type { Env } from "../config.js";

const KEYCHAIN_SERVICE = "transaction-builder-agent.keymaker";
const KEYCHAIN_DISABLED = process.env.TRANSACTION_AGENT_NO_KEYCHAIN === "1";
const TOKEN_DIR = process.env.TRANSACTION_AGENT_TOKEN_DIR
  ?? join(homedir(), ".transaction-builder-agent");

export interface CachedToken {
  accessToken: string;
  email?: string;
  /**
   * Epoch ms when this token was minted (browser login). Lets callers tell a
   * FRESH token (a 403 on it is authorization — don't re-login) from a STALE
   * one (a 403 may be a revoked session — re-login can recover). Absent for
   * tokens cached before this field existed → treated as old.
   */
  obtainedAt?: number;
}

/**
 * Three-tier token cache: in-memory (fast) → file (`~/.transaction-builder-agent/
 * token-{env}.json`, mode 0600) → OS keychain (best-effort).
 *
 * The file tier is the load-bearing one for a painless flow: it survives MCP
 * process restarts AND binary rebuilds (`setup.sh`), and a file read NEVER
 * triggers a GUI prompt — unlike the keychain, whose per-binary ACL pops a
 * "wants to use your keychain" dialog after a rebuild (which the user sees as a
 * spurious re-login). The keychain stays as a secondary tier for defense in
 * depth, written with `-A` so reads don't prompt; but because `get` checks the
 * file before the keychain, the keychain is rarely read in practice.
 *
 * Net effect: log in once, and every later create — even after a restart or
 * rebuild — reuses the token silently. Re-login happens only on a real 401
 * (token actually expired → caller `invalidate`s) or explicit `forceFresh`.
 */
export class TokenCache {
  private readonly memory = new Map<Env, CachedToken>();

  async get(env: Env): Promise<CachedToken | undefined> {
    const mem = this.memory.get(env);
    if (mem) return mem;

    const fromFile = await this.readFile(env);
    if (fromFile) {
      this.memory.set(env, fromFile);
      return fromFile;
    }

    const fromKeychain = await this.readKeychain(env);
    if (fromKeychain) {
      this.memory.set(env, fromKeychain);
      // Heal the file tier so future reads hit the file (no keychain prompt).
      await this.writeFile(env, fromKeychain);
      return fromKeychain;
    }
    return undefined;
  }

  /**
   * Stores a token in memory and (by default) on disk + keychain so it survives
   * MCP restarts. Pass `{ persist: false }` for session-only caching — typically
   * when the user unchecked "Remember me" on a shared machine.
   */
  async set(env: Env, token: CachedToken, opts: { persist?: boolean } = {}): Promise<void> {
    this.memory.set(env, token);
    if (opts.persist !== false) {
      await this.writeFile(env, token);
      await this.writeKeychain(env, token);
    } else {
      // Drop any persisted copy so a prior "remember me" doesn't resurrect.
      await this.deleteFile(env);
      await this.deleteKeychain(env);
    }
  }

  async clear(env: Env): Promise<void> {
    this.memory.delete(env);
    await this.deleteFile(env);
    await this.deleteKeychain(env);
  }

  // ---- file tier (primary persistent store; never prompts) ----

  private tokenPath(env: Env): string {
    return join(TOKEN_DIR, `token-${env}.json`);
  }

  private async readFile(env: Env): Promise<CachedToken | undefined> {
    try {
      const raw = await readFile(this.tokenPath(env), "utf8");
      const parsed = JSON.parse(raw) as CachedToken;
      return parsed?.accessToken ? parsed : undefined;
    } catch {
      return undefined; // missing / unreadable / malformed → treat as no token
    }
  }

  private async writeFile(env: Env, token: CachedToken): Promise<void> {
    try {
      await mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
      await writeFile(this.tokenPath(env), JSON.stringify(token), { mode: 0o600 });
    } catch {
      // best-effort — in-memory tier still keeps the session working
    }
  }

  private async deleteFile(env: Env): Promise<void> {
    try {
      await unlink(this.tokenPath(env));
    } catch {
      // already gone
    }
  }

  // ---- keychain tier (secondary, best-effort) ----

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
    // -U updates if exists. -A allows ANY application to read without a GUI
    // prompt. Without -A, macOS ties the item's ACL to the writing binary's
    // code identity — so after a rebuild or process restart the new binary
    // triggers a "wants to use your keychain" prompt on every read, which the
    // user sees as a spurious re-login. Acceptable tradeoff: sandbox-only tool
    // (prod hard-blocked in config.ts), short-lived team JWT, user's own machine.
    await this.runSecurity([
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      env,
      "-w",
      JSON.stringify(token),
      "-U",
      "-A",
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

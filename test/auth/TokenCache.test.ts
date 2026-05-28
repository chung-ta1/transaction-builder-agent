import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force keychain off + isolate the file tier to a temp dir so these tests are
// deterministic and never touch the real ~/.transaction-builder-agent.
const ORIGINAL_NO_KEYCHAIN = process.env.TRANSACTION_AGENT_NO_KEYCHAIN;
const ORIGINAL_TOKEN_DIR = process.env.TRANSACTION_AGENT_TOKEN_DIR;
let tokenDir: string;

beforeEach(() => {
  process.env.TRANSACTION_AGENT_NO_KEYCHAIN = "1";
  tokenDir = mkdtempSync(join(tmpdir(), "tbagent-tokens-"));
  process.env.TRANSACTION_AGENT_TOKEN_DIR = tokenDir;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_NO_KEYCHAIN === undefined) delete process.env.TRANSACTION_AGENT_NO_KEYCHAIN;
  else process.env.TRANSACTION_AGENT_NO_KEYCHAIN = ORIGINAL_NO_KEYCHAIN;
  if (ORIGINAL_TOKEN_DIR === undefined) delete process.env.TRANSACTION_AGENT_TOKEN_DIR;
  else process.env.TRANSACTION_AGENT_TOKEN_DIR = ORIGINAL_TOKEN_DIR;
  rmSync(tokenDir, { recursive: true, force: true });
});

describe("TokenCache", () => {
  it("round-trips a token for one env", async () => {
    const { TokenCache } = await import("../../src/auth/TokenCache.js");
    const cache = new TokenCache();
    await cache.set("team1", { accessToken: "abc.def.ghi", email: "me@real.com" });
    await expect(cache.get("team1")).resolves.toEqual({
      accessToken: "abc.def.ghi",
      email: "me@real.com",
    });
  });

  it("keeps tokens per-env separate", async () => {
    const { TokenCache } = await import("../../src/auth/TokenCache.js");
    const cache = new TokenCache();
    await cache.set("team1", { accessToken: "t1" });
    await cache.set("play", { accessToken: "p1" });
    await expect(cache.get("team1")).resolves.toEqual({ accessToken: "t1" });
    await expect(cache.get("play")).resolves.toEqual({ accessToken: "p1" });
  });

  it("returns undefined for an env that was never set", async () => {
    const { TokenCache } = await import("../../src/auth/TokenCache.js");
    const cache = new TokenCache();
    await expect(cache.get("stage")).resolves.toBeUndefined();
  });

  it("clear() removes an env's token from memory AND disk", async () => {
    const { TokenCache } = await import("../../src/auth/TokenCache.js");
    const cache = new TokenCache();
    await cache.set("team1", { accessToken: "t1" });
    await cache.clear("team1");
    await expect(cache.get("team1")).resolves.toBeUndefined();
    // A fresh instance (simulating a restart) must also see it gone.
    const restarted = new TokenCache();
    await expect(restarted.get("team1")).resolves.toBeUndefined();
  });

  it("persists across a restart — a NEW cache instance reads the token from disk", async () => {
    const { TokenCache } = await import("../../src/auth/TokenCache.js");
    const first = new TokenCache();
    await first.set("team1", { accessToken: "survives.restart", email: "me@real.com" });
    // Simulate the MCP process restarting: brand-new instance, empty memory.
    const afterRestart = new TokenCache();
    await expect(afterRestart.get("team1")).resolves.toEqual({
      accessToken: "survives.restart",
      email: "me@real.com",
    });
  });

  it("persist:false keeps the token in memory only — a restart loses it", async () => {
    const { TokenCache } = await import("../../src/auth/TokenCache.js");
    const first = new TokenCache();
    await first.set("team1", { accessToken: "session.only" }, { persist: false });
    await expect(first.get("team1")).resolves.toEqual({ accessToken: "session.only" });
    const afterRestart = new TokenCache();
    await expect(afterRestart.get("team1")).resolves.toBeUndefined();
  });
});

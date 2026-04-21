#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, prewarmAuth } from "./server.js";

// Orphan-process watchdog. Claude Desktop / Claude Code spawns us over stdio
// as a child process. When the client is killed ungracefully (⌘Q during a
// crash, `pkill claude`, machine sleep timing out the handshake), our stdin
// closes but the Node process lingers — a stale MCP that answers `claude mcp
// list` but whose tools never re-register in the next session. Two guards:
//   1. If stdin closes, exit. StdioServerTransport usually handles this, but
//      we make it belt-and-suspenders.
//   2. If our parent PID dies (we get re-parented to init / launchd), exit.
//      The only way `ppid` becomes 1 mid-run is if our real parent vanished.
function installOrphanWatchdog(onExit: () => Promise<void>): void {
  const die = async (reason: string): Promise<void> => {
    try { await onExit(); } catch { /* best-effort */ }
    // stderr so we show up in Claude's MCP log during debugging but don't
    // pollute the JSON-RPC stream on stdout.
    console.error(`[transaction-builder-agent] exiting: ${reason}`);
    process.exit(0);
  };

  process.stdin.on("end", () => { void die("stdin closed"); });
  process.stdin.on("close", () => { void die("stdin closed"); });

  const initialParent = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid !== initialParent && process.ppid <= 1) {
      clearInterval(parentWatch);
      void die(`parent PID ${initialParent} gone`);
    }
  }, 5000);
  parentWatch.unref();
}

async function main(): Promise<void> {
  const { server, ctx } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Fire auth pre-warmup in the background. Checks every supported env's
  // OS-keychain token and validates them against yenta/myself so the
  // in-memory cache is hot by the time the first `verify_auth` call lands.
  // Failures are swallowed (stderr only) — pre-warmup must never block or
  // crash the MCP on startup.
  prewarmAuth(ctx).catch((err) => {
    console.error("[transaction-builder-agent] auth pre-warmup failed (non-fatal):", err);
  });

  const shutdown = async (): Promise<void> => { await server.close(); };

  installOrphanWatchdog(shutdown);

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[transaction-builder-agent] Fatal error:", err);
  process.exit(1);
});

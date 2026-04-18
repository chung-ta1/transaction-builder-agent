import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BIN = resolve(__dirname, "../dist/index.js");

describe("orphan-process watchdog", () => {
  it("exits when stdin closes", async () => {
    if (!existsSync(BIN)) {
      throw new Error(`dist/index.js missing — run 'npm run build' before this test.`);
    }

    const child = spawn("node", [BIN], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectExit(new Error("server did not exit within 3s of stdin close"));
      }, 3000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });

    expect(exitCode).toBe(0);
  });
});

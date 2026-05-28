import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/Tool.js";

/**
 * pre_flight(waitForLogin) is what lets the agent auto-continue after the user
 * signs in — without a second user message. It must: reuse the in-flight login
 * (never open a second browser), return authenticated once the token lands, and
 * return loginPending (not hang forever) if the bounded wait elapses.
 *
 * LOGIN_WAIT_MS is read at module load, so each test sets the env var then
 * dynamically imports a fresh module instance.
 */
const ORIG = process.env.TRANSACTION_AGENT_LOGIN_WAIT_MS;

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.TRANSACTION_AGENT_LOGIN_WAIT_MS;
  else process.env.TRANSACTION_AGENT_LOGIN_WAIT_MS = ORIG;
});

const fakeYenta = () => ({ getMyself: async () => ({ yentaId: "y1", firstName: "A", lastName: "B" }) });
const args = (waitForLogin: boolean) => ({ env: "team1", userPrompt: "create at 10025", forceFresh: false, waitForLogin });

describe("pre_flight waitForLogin", () => {
  it("returns authenticated when the in-flight login resolves within the wait, reusing one login", async () => {
    process.env.TRANSACTION_AGENT_LOGIN_WAIT_MS = "500";
    const { preFlight } = await import("../../src/tools/granular/pre_flight.js");
    let startLoginCalls = 0;
    const auth = {
      peek: async () => undefined,
      startLogin: async () => { startLoginCalls += 1; return { accessToken: "tok" }; },
      invalidate: async () => {},
    };
    const res = (await preFlight.handler(args(true) as never, { auth, yenta: fakeYenta() } as unknown as ToolContext)) as { ok: boolean; data: { auth: { authenticated: boolean } } };
    expect(res.ok).toBe(true);
    expect(res.data.auth.authenticated).toBe(true);
    expect(startLoginCalls).toBe(1); // reused the open login — no second browser
  });

  it("returns loginPending (not a hang) when the wait elapses before sign-in", async () => {
    process.env.TRANSACTION_AGENT_LOGIN_WAIT_MS = "30";
    const { preFlight } = await import("../../src/tools/granular/pre_flight.js");
    const auth = {
      peek: async () => undefined,
      startLogin: () => new Promise<{ accessToken: string }>(() => {}), // never resolves
      invalidate: async () => {},
    };
    const res = (await preFlight.handler(args(true) as never, { auth, yenta: fakeYenta() } as unknown as ToolContext)) as { ok: boolean; data: { auth: { authenticated: boolean; loginPending?: boolean } } };
    expect(res.ok).toBe(true);
    expect(res.data.auth.authenticated).toBe(false);
    expect(res.data.auth.loginPending).toBe(true);
  });

  it("cached token → authenticated immediately, never starts a login", async () => {
    const { preFlight } = await import("../../src/tools/granular/pre_flight.js");
    let startLoginCalls = 0;
    const auth = {
      peek: async () => ({ accessToken: "cached" }),
      startLogin: async () => { startLoginCalls += 1; return { accessToken: "x" }; },
      invalidate: async () => {},
    };
    const res = (await preFlight.handler(args(true) as never, { auth, yenta: fakeYenta() } as unknown as ToolContext)) as { data: { auth: { authenticated: boolean } } };
    expect(res.data.auth.authenticated).toBe(true);
    expect(startLoginCalls).toBe(0);
  });

  it("forceFresh + waitForLogin in ONE call: invalidates once, opens exactly one login (no second popup)", async () => {
    process.env.TRANSACTION_AGENT_LOGIN_WAIT_MS = "500";
    const { preFlight } = await import("../../src/tools/granular/pre_flight.js");
    let startLoginCalls = 0;
    let invalidateCalls = 0;
    const auth = {
      peek: async () => undefined,
      startLogin: async () => { startLoginCalls += 1; return { accessToken: "tok2" }; },
      invalidate: async () => { invalidateCalls += 1; },
    };
    const res = (await preFlight.handler(
      { env: "team1", userPrompt: "switch identity 10025", forceFresh: true, waitForLogin: true } as never,
      { auth, yenta: fakeYenta() } as unknown as ToolContext,
    )) as { data: { auth: { authenticated: boolean } } };
    expect(invalidateCalls).toBe(1);
    expect(startLoginCalls).toBe(1); // exactly one login tab — never a second popup
    expect(res.data.auth.authenticated).toBe(true);
  });

  it("non-wait probe does NOT open a browser (no startLogin) when not signed in — waitForLogin is the only opener", async () => {
    const { preFlight } = await import("../../src/tools/granular/pre_flight.js");
    let startLoginCalls = 0;
    const auth = {
      peek: async () => undefined,
      startLogin: async () => { startLoginCalls += 1; return { accessToken: "x" }; },
      invalidate: async () => {},
    };
    const res = (await preFlight.handler(args(false) as never, { auth, yenta: fakeYenta() } as unknown as ToolContext)) as { data: { auth: { authenticated: boolean; loginPending?: boolean } } };
    expect(startLoginCalls).toBe(0); // the probe must not open a browser
    expect(res.data.auth.authenticated).toBe(false);
    expect(res.data.auth.loginPending).toBe(true);
  });
});

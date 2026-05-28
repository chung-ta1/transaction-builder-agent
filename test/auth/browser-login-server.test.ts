import { describe, expect, it, vi } from "vitest";

// runBrowserLogin opens the user's browser via the `open` package. In tests we
// stub it so nothing launches, and capture the loopback URL it was handed so the
// test can drive the /token relay exactly like the login page does.
let openedUrl = "";
vi.mock("open", () => ({
  default: (url: string) => {
    openedUrl = url;
    return Promise.resolve({ pid: 0 } as never);
  },
}));

const { runBrowserLogin, isLoopbackOrigin } = await import("../../src/auth/BrowserLoginServer.js");

/**
 * Regression test for the close-before-flush race: the /token handler used to
 * call resolve() (which closes the server synchronously) immediately after
 * res.end(), severing the connection before the 204 reached the browser — the
 * login page then threw "Failed to fetch" even though the token was captured.
 * The fix resolves from the res.end callback, after the response flushes. This
 * test asserts BOTH sides succeed: the relay fetch gets a clean 204 AND the
 * promise resolves with the token.
 */
describe("runBrowserLogin /token relay", () => {
  it("returns a clean 204 to the browser AND resolves with the token", async () => {
    openedUrl = "";
    const loginPromise = runBrowserLogin("team1", "agent@example.com");

    // Wait for the server to bind + the (stubbed) browser-open to record the URL.
    await vi.waitFor(() => expect(openedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/login/));
    const port = new URL(openedUrl).port;

    // Mimic the login page's relay POST exactly (loginPage.html:574).
    const relay = await fetch(`http://127.0.0.1:${port}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({
        env: "team1",
        accessToken: "test-token-abc",
        email: "agent@example.com",
        remember: true,
      }),
    });

    // The browser must see a successful, fully-flushed response — not a
    // severed connection. Under the old race this would intermittently throw
    // "Failed to fetch" or yield a non-ok response.
    expect(relay.ok).toBe(true);
    expect(relay.status).toBe(204);

    const result = await loginPromise;
    expect(result).toEqual({
      env: "team1",
      accessToken: "test-token-abc",
      email: "agent@example.com",
      remember: true,
    });
  });

  /**
   * Token-fixation guard: a cross-site POST to /token must NOT be able to inject
   * an attacker-chosen bearer. The old guard only rejected a foreign Origin and
   * let a no-Origin POST through; this asserts BOTH are now 403, and that the
   * legitimate loopback-Origin POST still works (so the real flow isn't broken).
   */
  it("rejects /token POSTs that aren't same-origin loopback, then accepts the legit one", async () => {
    openedUrl = "";
    const loginPromise = runBrowserLogin("team1", "agent@example.com");
    await vi.waitFor(() => expect(openedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/login/) && openedUrl !== "");
    const port = new URL(openedUrl).port;
    const tokenUrl = `http://127.0.0.1:${port}/token`;
    const body = JSON.stringify({ env: "team1", accessToken: "attacker-token", remember: true });

    // (a) no Origin header → must be 403 (the previously-open hole).
    const noOrigin = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(noOrigin.status).toBe(403);

    // (b) foreign Origin → must be 403.
    const foreign = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
      body,
    });
    expect(foreign.status).toBe(403);

    // (c) legit loopback Origin → succeeds, resolving the login with the REAL token.
    const ok = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ env: "team1", accessToken: "real-token", remember: true }),
    });
    expect(ok.status).toBe(204);

    const result = await loginPromise;
    expect(result.accessToken).toBe("real-token");
  });
});

describe("isLoopbackOrigin", () => {
  it("accepts loopback http origins (with or without port)", () => {
    expect(isLoopbackOrigin("http://127.0.0.1")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:54321")).toBe(true);
    expect(isLoopbackOrigin("http://localhost")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:8080")).toBe(true);
  });
  it("rejects absent, foreign, or non-http loopback origins", () => {
    expect(isLoopbackOrigin(undefined)).toBe(false);
    expect(isLoopbackOrigin("")).toBe(false);
    expect(isLoopbackOrigin("https://evil.example.com")).toBe(false);
    expect(isLoopbackOrigin("http://127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackOrigin("https://127.0.0.1")).toBe(false);
    expect(isLoopbackOrigin("http://localhost.evil.com")).toBe(false);
  });
});

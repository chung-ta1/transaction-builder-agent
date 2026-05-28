import { describe, expect, it } from "vitest";
import { needsReauth, isEmptyBody } from "../../src/services/BaseApi.js";

const FRESH = 1_000; // 1s old — just minted
const STALE = 10 * 60_000; // 10 min old

/**
 * Re-auth (which reopens the browser) must fire on a genuine auth failure but
 * NOT on an authorization 403 against a freshly-minted token — doing so popped
 * a confusing second login and discarded a valid token (verified 2026-05-23
 * with an agent lacking transaction-create permission, whose 403 has an empty
 * body).
 */
describe("needsReauth", () => {
  it("401 always re-auths regardless of token age", () => {
    expect(needsReauth(401, null, FRESH)).toBe(true);
    expect(needsReauth(401, { message: "x" }, STALE)).toBe(true);
  });

  it("empty-body 403 on a FRESH token does NOT re-auth (it's authorization, not a stale session)", () => {
    expect(needsReauth(403, "", FRESH)).toBe(false);
    expect(needsReauth(403, null, FRESH)).toBe(false);
    expect(needsReauth(403, {}, FRESH)).toBe(false);
  });

  it("empty-body 403 on a STALE token re-auths (possible revoked session)", () => {
    expect(needsReauth(403, "", STALE)).toBe(true);
    expect(needsReauth(403, null, Infinity)).toBe(true);
  });

  it("403 with a real authorization message never re-auths", () => {
    expect(needsReauth(403, { message: "Not authorized" }, STALE)).toBe(false);
    expect(needsReauth(403, { error: "forbidden" }, Infinity)).toBe(false);
  });

  it("403 with an arrakis-ENVELOPED authorization message never re-auths (no spurious popup)", () => {
    const arrakis403 = {
      "com.real.commons.apierror.ApiError": { status: 403, message: "Not authorized" },
    };
    expect(needsReauth(403, arrakis403, STALE)).toBe(false);
    expect(needsReauth(403, arrakis403, Infinity)).toBe(false);
  });

  it("2xx and other statuses never re-auth", () => {
    expect(needsReauth(200, null, STALE)).toBe(false);
    expect(needsReauth(500, "", STALE)).toBe(false);
  });
});

describe("isEmptyBody", () => {
  it("treats null / empty string / message-less object as empty", () => {
    expect(isEmptyBody(null)).toBe(true);
    expect(isEmptyBody("")).toBe(true);
    expect(isEmptyBody("   ")).toBe(true);
    expect(isEmptyBody({})).toBe(true);
  });
  it("treats a body carrying a message/error/detail as non-empty", () => {
    expect(isEmptyBody({ message: "x" })).toBe(false);
    expect(isEmptyBody({ error: "e" })).toBe(false);
    expect(isEmptyBody("boom")).toBe(false);
  });
  it("unwraps the arrakis ApiError envelope before checking for a message", () => {
    expect(
      isEmptyBody({ "com.real.commons.apierror.ApiError": { message: "Not authorized" } }),
    ).toBe(false);
    // genuinely empty enveloped body (no message) is still empty
    expect(
      isEmptyBody({ "com.real.commons.apierror.ApiError": { status: 403 } }),
    ).toBe(true);
  });
});

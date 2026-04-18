import { describe, expect, it } from "vitest";
import {
  assertNotProduction,
  buildDraftUrl,
  InvalidEnvError,
  SUPPORTED_ENVS,
  urlsFor,
} from "../src/config.js";

describe("config", () => {
  describe("SUPPORTED_ENVS", () => {
    it("never includes production", () => {
      expect(SUPPORTED_ENVS).not.toContain("prod");
      expect(SUPPORTED_ENVS).not.toContain("production");
    });

    it("contains the expected team + pre-prod environments", () => {
      expect([...SUPPORTED_ENVS].sort()).toEqual([
        "play",
        "stage",
        "team1",
        "team2",
        "team3",
        "team4",
        "team5",
      ]);
    });
  });

  describe("urlsFor", () => {
    it("maps team1 to the right keymaker/arrakis/yenta/bolt hostnames", () => {
      expect(urlsFor("team1")).toEqual({
        keymaker: "https://keymaker.team1realbrokerage.com",
        arrakis: "https://arrakis.team1realbrokerage.com",
        yenta: "https://yenta.team1realbrokerage.com",
        bolt: "https://bolt.team1realbrokerage.com",
        agentLogin: "https://app.team1onereal.com/agent-login",
      });
    });

    it("maps play similarly", () => {
      const urls = urlsFor("play");
      expect(urls.arrakis).toBe("https://arrakis.playrealbrokerage.com");
      expect(urls.bolt).toBe("https://bolt.playrealbrokerage.com");
    });
  });

  describe("assertNotProduction", () => {
    it("accepts any supported env", () => {
      for (const env of SUPPORTED_ENVS) {
        expect(() => assertNotProduction(env)).not.toThrow();
      }
    });

    it("rejects unknown envs with a helpful message", () => {
      expect(() => assertNotProduction("unknown-env" as never)).toThrow(InvalidEnvError);
    });

    it("rejects anything that would resolve to production hostname", () => {
      // Not a supported env, but if it ever were, the prod-block must still fire.
      expect(() => assertNotProduction("the" as never)).toThrow(InvalidEnvError);
    });
  });

  describe("buildDraftUrl", () => {
    it("builds the bolt URL for a builderId", () => {
      // Bolt uses singular /transaction/create/{id} — plural was a pre-live
      // guess that 400'd on first real use (would-be builderId gets
      // interpreted as transactionId). See memory/transaction-rules.md.
      expect(buildDraftUrl("team1", "8c4f-abcd")).toBe(
        "https://bolt.team1realbrokerage.com/transaction/create/8c4f-abcd",
      );
    });
  });
});

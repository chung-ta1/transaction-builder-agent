/**
 * Environment configuration. The MCP is multi-env — the agent chooses which
 * env to target at runtime and passes it to every tool. This module maps the
 * env name to keymaker / arrakis / yenta / bolt URLs, and hard-rejects production.
 */

export const SUPPORTED_ENVS = [
  "team1",
  "team2",
  "team3",
  "team4",
  "team5",
  "play",
  "stage",
] as const;

export type Env = (typeof SUPPORTED_ENVS)[number];

const PRODUCTION_HOSTNAME = "therealbrokerage.com";

export interface EnvUrls {
  keymaker: string;
  arrakis: string;
  yenta: string;
  bolt: string;
  agentLogin: string;
}

/**
 * Map env → URLs. Production domain is banned by design so we don't need to
 * support it here; see `assertNotProduction` for the runtime check.
 */
export function urlsFor(env: Env): EnvUrls {
  const domain = domainFor(env);
  return {
    keymaker: `https://keymaker.${domain}`,
    arrakis: `https://arrakis.${domain}`,
    yenta: `https://yenta.${domain}`,
    bolt: `https://bolt.${domain}`,
    agentLogin: `https://app.${env}onereal.com/agent-login`,
  };
}

function domainFor(env: Env): string {
  assertNotProduction(env);
  return `${env}realbrokerage.com`;
}

export function assertNotProduction(env: string): asserts env is Env {
  if (!SUPPORTED_ENVS.includes(env as Env)) {
    throw new InvalidEnvError(
      `Unknown environment "${env}". Supported: ${SUPPORTED_ENVS.join(", ")}.`,
    );
  }
  const domain = `${env}realbrokerage.com`;
  if (domain.toLowerCase().includes(PRODUCTION_HOSTNAME)) {
    throw new InvalidEnvError(
      `Environment "${env}" resolves to the production hostname (${PRODUCTION_HOSTNAME}). ` +
        "transaction-builder-agent is permanently blocked from production.",
    );
  }
}

export class InvalidEnvError extends Error {
  override readonly name = "InvalidEnvError";
}

/**
 * URL the agent returns to the user at the end of a successful draft.
 * Route is `/transaction/create/{builderId}` (singular `transaction`).
 * A previous version used the plural form; Bolt's router then treated
 * "create" as a transactionId and threw a UUID conversion error.
 */
export function buildDraftUrl(env: Env, builderId: string): string {
  const { bolt } = urlsFor(env);
  return `${bolt}/transaction/create/${builderId}`;
}

/**
 * URL for a submitted transaction's detail page in Bolt. Used by flows that
 * create AND submit in one shot (e.g. `create_referral_payment`), which
 * return the real Transaction id — not a builder id — and don't produce a
 * draft URL at all.
 */
export function buildTransactionDetailUrl(env: Env, transactionId: string): string {
  const { bolt } = urlsFor(env);
  return `${bolt}/transactions/${transactionId}/detail`;
}

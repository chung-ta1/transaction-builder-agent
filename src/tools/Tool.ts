import { z } from "zod";
import type { AuthService } from "../auth/AuthService.js";
import type { ReferralCentralApi } from "../services/ReferralCentralApi.js";
import type { ReferralPaymentApi } from "../services/ReferralPaymentApi.js";
import type { TransactionBuilderApi } from "../services/TransactionBuilderApi.js";
import type { YentaAgentApi } from "../services/YentaAgentApi.js";

/**
 * Context injected into every tool handler.
 */
export interface ToolContext {
  auth: AuthService;
  arrakis: TransactionBuilderApi;
  yenta: YentaAgentApi;
  referralCentral: ReferralCentralApi;
  referralPayment: ReferralPaymentApi;
}

/**
 * Uniform tool shape used by the registry. Specific zod types (ZodObject,
 * ZodUnion, ZodEffects) don't assign cleanly into a single generic parameter,
 * so the registry stores the widest shape; `defineTool` preserves narrow
 * typing inside each tool's call site so handlers still see `z.infer<Input>`.
 */
export interface Tool {
  name: string;
  description: string;
  input: z.ZodType;
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

/**
 * All tools return the same shape so the agent can branch on `ok` without
 * needing to inspect thrown exceptions.
 */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    message: string;
    code?: string;
    status?: number;
    body?: unknown;
  };
}

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function fail(message: string, detail?: Partial<NonNullable<ToolResult["error"]>>): ToolResult<never> {
  return { ok: false, error: { message, ...detail } };
}

/**
 * Build a Tool, preserving narrow argument typing inside `handler`.
 * The returned object is compatible with the uniform `Tool` registry type.
 */
export function defineTool<Input extends z.ZodType, Output>(def: {
  name: string;
  description: string;
  input: Input;
  handler: (args: z.infer<Input>, ctx: ToolContext) => Promise<Output>;
}): Tool {
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    handler: def.handler as (args: unknown, ctx: ToolContext) => Promise<unknown>,
  };
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AuthService } from "./auth/AuthService.js";
import { TokenCache } from "./auth/TokenCache.js";
import { SUPPORTED_ENVS } from "./config.js";
import { prompts, readPromptContent } from "./prompts/index.js";
import { ReferralPaymentApi } from "./services/ReferralPaymentApi.js";
import { TransactionBuilderApi } from "./services/TransactionBuilderApi.js";
import { YentaAgentApi } from "./services/YentaAgentApi.js";
import { allTools } from "./tools/index.js";
import type { Tool, ToolContext } from "./tools/Tool.js";

export interface CreatedServer {
  server: Server;
  ctx: ToolContext;
}

/**
 * Flatten top-level `anyOf` / `oneOf` / `allOf` on a JSON Schema object root.
 * The Anthropic Messages API rejects `input_schema` with any combinator at the
 * top level, even when `type: "object"` is also present. We merge each branch's
 * `properties` (union) and `required` (intersection — only fields required in
 * every branch stay required) and drop the combinator. The original Zod
 * `superRefine` still enforces branch-specific invariants at runtime in
 * `tools/call`, so relaxing the advertised schema doesn't weaken validation.
 *
 * Returns true if any combinator was flattened. Handles nested combinators
 * (e.g. `oneOf` inside `allOf`) by flattening iteratively.
 */
function flattenTopLevelCombinators(schema: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (!Array.isArray(schema[key])) continue;
    const branches = (schema[key] as Array<Record<string, unknown>>).filter(
      (b) => b && typeof b === "object",
    );
    delete schema[key];
    changed = true;
    if (branches.length === 0) continue;

    const mergedProps: Record<string, unknown> = {
      ...((schema.properties as Record<string, unknown>) ?? {}),
    };
    const existingRequired = Array.isArray(schema.required)
      ? (schema.required as string[])
      : null;
    let requiredIntersection: Set<string> | null = null;

    for (const branch of branches) {
      // allOf = intersection of all requireds; anyOf/oneOf = intersection still
      // (a field required in only some branches can't be required overall).
      if (branch.properties && typeof branch.properties === "object") {
        Object.assign(mergedProps, branch.properties as Record<string, unknown>);
      }
      const branchRequired = Array.isArray(branch.required)
        ? new Set(branch.required as string[])
        : new Set<string>();
      if (requiredIntersection === null) {
        requiredIntersection = branchRequired;
      } else {
        const prev: Set<string> = requiredIntersection;
        requiredIntersection = new Set(
          [...prev].filter((f) => branchRequired.has(f)),
        );
      }
    }

    schema.properties = mergedProps;
    const finalRequired = new Set<string>(existingRequired ?? []);
    if (requiredIntersection) {
      for (const f of requiredIntersection) finalRequired.add(f);
    }
    if (finalRequired.size > 0) schema.required = [...finalRequired];
  }
  return changed;
}

export function createServer(): CreatedServer {
  const auth = new AuthService(new TokenCache());
  const ctx: ToolContext = {
    auth,
    arrakis: new TransactionBuilderApi(auth),
    yenta: new YentaAgentApi(auth),
    referralPayment: new ReferralPaymentApi(auth),
  };

  const byName = new Map<string, Tool>(allTools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "transaction-agent", version: "0.1.0" },
    { capabilities: { tools: {}, prompts: {} } },
  );

  // ---- Tools ----
  // Four zod-to-json-schema leaks to guard against; each causes Claude
  // Desktop / Claude Code (or the Anthropic Messages API itself) to drop
  // the tools/list or reject the API request:
  //   1. `$ref` pointers from reused sub-schemas — fixed via
  //      `$refStrategy: "none"` which inlines everything.
  //   2. The `$schema` meta-property the library emits at the root of every
  //      schema — no library option to suppress, so strip it post-call.
  //   3. A bare `anyOf` / `oneOf` at the root (emitted when a tool's input
  //      is `z.union(...)` or `z.discriminatedUnion(...)` instead of
  //      `z.object(...)`). MCP's inputSchema contract requires
  //      `type: "object"` at the root. Fix: wrap with `{ type: "object", ... }`.
  //   4. ANY top-level `anyOf` / `oneOf` / `allOf` — even on an object root.
  //      Emitted when `z.object(...).superRefine(...)` has a discriminator
  //      enum whose branches have different required-field sets. The
  //      Anthropic Messages API rejects this with:
  //        "input_schema does not support oneOf, allOf, or anyOf at the top
  //         level"
  //      Fix: flatten — merge branches into a single `properties` map,
  //      intersect their `required` lists (only fields required in *every*
  //      branch stay required). The Zod `superRefine` still enforces
  //      branch-specific requireds at runtime via `safeParse` in tools/call,
  //      so we don't lose validation — we just relax the advertised schema.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const diagnostics: Array<{ name: string; wrappedUnion: boolean; flattenedCombinator: boolean; hadSchema: boolean; schemaKeys: string[] }> = [];
    const tools = allTools.map((t) => {
      const schema = zodToJsonSchema(t.input, {
        target: "jsonSchema7",
        $refStrategy: "none",
      }) as Record<string, unknown>;
      const hadSchema = "$schema" in schema;
      delete schema.$schema;
      let wrappedUnion = false;
      let finalSchema: Record<string, unknown> = schema;
      if (finalSchema.type !== "object") {
        finalSchema = { type: "object", ...finalSchema };
        wrappedUnion = true;
      }
      const flattenedCombinator = flattenTopLevelCombinators(finalSchema);
      diagnostics.push({
        name: t.name,
        wrappedUnion,
        flattenedCombinator,
        hadSchema,
        schemaKeys: Object.keys(finalSchema),
      });
      return {
        name: t.name,
        description: t.description,
        inputSchema: finalSchema,
      };
    });
    console.error(`[transaction-agent] tools/list: returning ${tools.length} tools`);
    console.error(`[transaction-agent] tools with wrapped-union roots: ${diagnostics.filter((d) => d.wrappedUnion).map((d) => d.name).join(", ") || "(none)"}`);
    console.error(`[transaction-agent] tools with flattened top-level combinators: ${diagnostics.filter((d) => d.flattenedCombinator).map((d) => d.name).join(", ") || "(none)"}`);
    console.error(`[transaction-agent] tools that had $schema stripped: ${diagnostics.filter((d) => d.hadSchema).length}/${tools.length}`);
    const payloadBytes = JSON.stringify({ tools }).length;
    console.error(`[transaction-agent] tools/list payload size: ${payloadBytes} bytes`);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    console.error(`[transaction-agent] tools/call: ${req.params.name}`);
    const tool = byName.get(req.params.name);
    if (!tool) {
      console.error(`[transaction-agent] tools/call: unknown tool ${req.params.name}`);
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }

    const parsed = tool.input.safeParse(req.params.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
          },
        ],
      };
    }

    try {
      const result = await tool.handler(parsed.data, ctx);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `${tool.name} failed: ${message}` }],
      };
    }
  });

  // ---- Prompts ----
  // Exposed so Claude Desktop users can invoke the runbook from the `+` /
  // attachment menu. Claude CLI users typically get the same flow via the
  // skill (generated from the same source file), but prompts also work there.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts.map((p) => ({
      name: p.name,
      description: p.description,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    try {
      const text = await readPromptContent(req.params.name);
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Prompt load failed for "${req.params.name}": ${message}`);
    }
  });

  return { server, ctx };
}

/**
 * Startup auth pre-warmup. For every supported env, if the OS keychain has a
 * cached token, validate it against yenta/myself so the in-memory cache is
 * already populated when the first `verify_auth` call arrives. Keeps the
 * typical authenticated flow under the 60s MCP tool-call timeout by avoiding
 * the browser-login path entirely when a valid token is on disk.
 *
 * Runs fully in the background — any failure is logged to stderr (picked up
 * by the mcp-server log) and never bubbles up to kill the MCP.
 */
export async function prewarmAuth(ctx: ToolContext): Promise<void> {
  const warmed: string[] = [];
  await Promise.all(
    SUPPORTED_ENVS.map(async (env) => {
      const cached = await ctx.auth.peek(env);
      if (!cached) return;
      try {
        await ctx.yenta.getMyself(env);
        warmed.push(env);
      } catch {
        // Token is likely expired. Drop it so the next verify_auth
        // triggers a fresh browser login instead of silently 401-ing.
        await ctx.auth.invalidate(env).catch(() => undefined);
      }
    }),
  );
  if (warmed.length > 0) {
    console.error(`[transaction-agent] auth pre-warm: hot envs = ${warmed.join(", ")}`);
  }
}

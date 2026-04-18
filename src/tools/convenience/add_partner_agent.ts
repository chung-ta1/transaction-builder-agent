import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { addParticipantRequestSchema, envSchema } from "../../types/schemas.js";
import { fromError } from "../granular/init.js";

/**
 * One tool for "add a partner who works this deal with me":
 *   - Real agent (internal) + single-rep → one addCoAgent
 *   - Real agent (internal) + DUAL rep   → two addCoAgent (BUYERS_AGENT + SELLERS_AGENT)
 *   - Outside agent                      → addOtherParticipant (OTHER_AGENT)
 * Avoids the agent runbook having to remember the dual-twice rule.
 *
 * Schema note: a flat object with a `kind` discriminator and a superRefine
 * branch-check (instead of `z.union([...])` at root) — the Anthropic Messages
 * API rejects tools whose input_schema has anyOf/oneOf/allOf at the root.
 */
export const addPartnerAgent = defineTool({
  name: "add_partner_agent",
  description:
    "Add a partner agent to the draft. For Real agents pass {kind: \"internal\", agentId, side}. For outside agents pass {kind: \"external\", participant: {...brokerage fields…}}. Side=DUAL automatically registers the agent on both BUYERS_AGENT and SELLERS_AGENT roles.",
  input: z
    .object({
      env: envSchema,
      builderId: z.string(),
      kind: z.enum(["internal", "external"]),
      agentId: z.string().uuid().optional(),
      side: z.enum(["BUYERS_AGENT", "SELLERS_AGENT", "TENANT_AGENT", "DUAL"]).optional(),
      receivesInvoice: z.boolean().default(false),
      participant: addParticipantRequestSchema
        .extend({ role: z.literal("OTHER_AGENT").default("OTHER_AGENT") })
        .optional(),
    })
    .superRefine((v, ctx) => {
      if (v.kind === "internal") {
        if (!v.agentId) ctx.addIssue({ code: "custom", path: ["agentId"], message: "agentId is required when kind='internal'" });
        if (!v.side) ctx.addIssue({ code: "custom", path: ["side"], message: "side is required when kind='internal'" });
      } else {
        if (!v.participant) ctx.addIssue({ code: "custom", path: ["participant"], message: "participant is required when kind='external'" });
      }
    }),
  async handler(args, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      if (args.kind === "internal") {
        const { env, builderId, agentId, side, receivesInvoice } = args;
        if (side === "DUAL") {
          await arrakis.addCoAgent(env, builderId, { agentId: agentId!, role: "BUYERS_AGENT", receivesInvoice });
          await arrakis.addCoAgent(env, builderId, { agentId: agentId!, role: "SELLERS_AGENT", receivesInvoice });
          return ok({ registered: ["BUYERS_AGENT", "SELLERS_AGENT"] });
        }
        return ok(await arrakis.addCoAgent(env, builderId, { agentId: agentId!, role: side!, receivesInvoice }));
      }
      return ok(await arrakis.addOtherParticipant(args.env, args.builderId, args.participant!));
    } catch (err) {
      return fromError(err);
    }
  },
});

import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { addParticipantRequestSchema, agentParticipantInfoSchema, envSchema } from "../../types/schemas.js";
import { fromError } from "./init.js";

/**
 * Add one participant to a draft. The `role` discriminator selects which
 * arrakis endpoint receives the call:
 *
 *   co_agent              → PUT /co-agent           (data: agentParticipantInfo)
 *   other_side_agent      → PUT /other-participants (role=OTHER_AGENT)
 *   transaction_coordinator → POST /transaction-coordinator/{yentaId}
 */
export const addParticipant = defineTool({
  name: "add_participant",
  description:
    "Add a participant to a draft. role='co_agent' wires another Real agent on the owner's side (DUAL: call twice with side BUYERS_AGENT then SELLERS_AGENT). role='other_side_agent' wires the OTHER_AGENT on a single-rep deal where the other side is represented. role='transaction_coordinator' attaches a TC by yentaId.",
  input: z.discriminatedUnion("role", [
    z.object({ env: envSchema, builderId: z.string(), role: z.literal("co_agent"), data: agentParticipantInfoSchema }),
    z.object({ env: envSchema, builderId: z.string(), role: z.literal("other_side_agent"), data: addParticipantRequestSchema.extend({ role: z.literal("OTHER_AGENT").default("OTHER_AGENT") }) }),
    z.object({ env: envSchema, builderId: z.string(), role: z.literal("transaction_coordinator"), yentaId: z.string().uuid() }),
  ]),
  async handler(args, { arrakis }): Promise<ToolResult<unknown>> {
    const { env, builderId } = args;
    try {
      switch (args.role) {
        case "co_agent":
          return ok(await arrakis.addCoAgent(env, builderId, args.data));
        case "other_side_agent":
          return ok(await arrakis.addOtherParticipant(env, builderId, args.data));
        case "transaction_coordinator":
          return ok(await arrakis.addTransactionCoordinator(env, builderId, args.yentaId));
      }
    } catch (err) {
      return fromError(err);
    }
  },
});

/**
 * Remove a buyer / seller / co-agent by participant id (from get_draft).
 * arrakis requires ≥1 buyer (TRANSACTION) and ≥1 seller — caller must
 * warn the user if the deletion leaves either array empty.
 */
export const removeParticipant = defineTool({
  name: "remove_participant",
  description:
    "Remove a participant from a draft by participantId (fetch from get_draft). role='buyer' deletes a buyer, 'seller' a seller, 'co_agent' a co-agent. arrakis requires ≥1 buyer (TRANSACTION) and ≥1 seller — warn if the deletion leaves either empty. After removing a co_agent, recompute commission splits.",
  input: z.object({
    env: envSchema,
    builderId: z.string(),
    role: z.enum(["buyer", "seller", "co_agent"]),
    participantId: z.string(),
  }),
  async handler({ env, builderId, role, participantId }, { arrakis }): Promise<ToolResult<unknown>> {
    try {
      switch (role) {
        case "buyer": return ok(await arrakis.deleteBuyer(env, builderId, participantId));
        case "seller": return ok(await arrakis.deleteSeller(env, builderId, participantId));
        case "co_agent": return ok(await arrakis.deleteCoAgent(env, builderId, participantId));
      }
    } catch (err) {
      return fromError(err);
    }
  },
});

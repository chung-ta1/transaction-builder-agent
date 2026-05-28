import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "./init.js";

/**
 * Add a referral to a draft. `kind: "internal"` wires another Real agent by
 * yentaId; `kind: "external"` registers an outside-brokerage agent and
 * (optionally) uploads their W9 in the same call.
 *
 * arrakis cap: max one non-opcity referral per draft.
 */
export const addReferral = defineTool({
  name: "add_referral",
  description:
    "Add a referral to a draft. kind='internal' takes a yentaId for another Real agent. kind='external' takes name + brokerage + EIN + address (+ optional w9Path to upload the W9 PDF in the same call). Max one non-opcity referral per draft — arrakis rejects a second.",
  input: z.discriminatedUnion("kind", [
    z.object({
      env: envSchema, builderId: z.string(), kind: z.literal("internal"),
      agentId: z.string().uuid(), receivesInvoice: z.boolean().default(false),
    }),
    z.object({
      env: envSchema, builderId: z.string(), kind: z.literal("external"),
      firstName: z.string().min(1), lastName: z.string().min(1), companyName: z.string().min(1),
      address: z.string().min(1), ein: z.string().min(1),
      email: z.string().email().optional(), phoneNumber: z.string().optional(),
      receivesInvoice: z.boolean().default(true),
      vendorDirectoryId: z.string().uuid().optional(),
      w9Path: z.string().optional().describe("Path to a W9 PDF; uploaded in the same call when supplied."),
    }),
  ]),
  async handler(args, { arrakis }): Promise<ToolResult<unknown>> {
    const { env, builderId } = args;
    try {
      if (args.kind === "internal") {
        return ok(await arrakis.addReferralInfo(env, builderId, {
          role: "REFERRING_AGENT", type: "AGENT",
          agentId: args.agentId, receivesInvoice: args.receivesInvoice,
        }));
      }
      const { kind: _k, w9Path, ...rest } = args;
      const result = await arrakis.addReferralInfo(env, builderId, {
        role: "REFERRING_AGENT", type: "EXTERNAL_ENTITY", ...rest,
      });
      if (w9Path && result && typeof result === "object" && "id" in result && typeof (result as { id: unknown }).id === "string") {
        await arrakis.uploadReferralW9(env, builderId, (result as { id: string }).id, w9Path);
      }
      return ok(result);
    } catch (err) {
      return fromError(err);
    }
  },
});

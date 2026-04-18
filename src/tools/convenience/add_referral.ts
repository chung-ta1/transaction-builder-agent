import { z } from "zod";
import { defineTool, ok, type ToolResult } from "../Tool.js";
import { envSchema } from "../../types/schemas.js";
import { fromError } from "../granular/init.js";

/**
 * One referral tool that picks the right arrakis call based on whether the
 * referrer is a Real agent (internal) or outside (external), and optionally
 * uploads the W9 when provided.
 *
 * Schema note: a flat object with a `kind` discriminator and a superRefine
 * branch-check (instead of `z.union([...])` at root) — the Anthropic Messages
 * API rejects tools whose input_schema has anyOf/oneOf/allOf at the root.
 */
export const addReferral = defineTool({
  name: "add_referral",
  description:
    "Add a referral to the draft. For a Real agent referrer pass {kind: \"internal\", agentId}. For an outside referrer pass {kind: \"external\"} plus firstName/lastName/companyName/address/ein (+ optional email, phoneNumber, vendorDirectoryId, w9FilePath). Max one non-opcity referral per draft.",
  input: z
    .object({
      env: envSchema,
      builderId: z.string(),
      kind: z.enum(["internal", "external"]),
      receivesInvoice: z.boolean().optional(),
      // internal
      agentId: z.string().uuid().optional(),
      // external
      firstName: z.string().min(1).optional(),
      lastName: z.string().min(1).optional(),
      companyName: z.string().min(1).optional(),
      address: z.string().min(1).optional(),
      ein: z.string().min(1).optional(),
      email: z.string().email().optional(),
      phoneNumber: z.string().optional(),
      vendorDirectoryId: z.string().uuid().optional(),
      w9FilePath: z.string().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.kind === "internal") {
        if (!v.agentId) ctx.addIssue({ code: "custom", path: ["agentId"], message: "agentId is required when kind='internal'" });
      } else {
        for (const f of ["firstName", "lastName", "companyName", "address", "ein"] as const) {
          if (!v[f]) ctx.addIssue({ code: "custom", path: [f], message: `${f} is required when kind='external'` });
        }
      }
    }),
  async handler(args, { arrakis }): Promise<ToolResult<{ participantId?: string }>> {
    try {
      if (args.kind === "internal") {
        const result = (await arrakis.addReferralInfo(args.env, args.builderId, {
          role: "REFERRING_AGENT",
          type: "AGENT",
          agentId: args.agentId!,
          receivesInvoice: args.receivesInvoice ?? false,
        })) as { id?: string } | undefined;
        return ok({ participantId: result?.id });
      }

      const result = (await arrakis.addReferralInfo(args.env, args.builderId, {
        role: "REFERRING_AGENT",
        type: "EXTERNAL_ENTITY",
        firstName: args.firstName!,
        lastName: args.lastName!,
        companyName: args.companyName!,
        address: args.address!,
        ein: args.ein!,
        email: args.email,
        phoneNumber: args.phoneNumber,
        vendorDirectoryId: args.vendorDirectoryId,
        receivesInvoice: args.receivesInvoice ?? true,
      })) as { id?: string } | undefined;

      const participantId = result?.id;
      if (args.w9FilePath && participantId) {
        await arrakis.uploadReferralW9(args.env, args.builderId, participantId, args.w9FilePath);
      }
      return ok({ participantId });
    } catch (err) {
      return fromError(err);
    }
  },
});

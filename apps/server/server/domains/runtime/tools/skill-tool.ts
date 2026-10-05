/** Model `skill` tool (D58): load an available skill's instructions, headed by its read-only folder. */
import { z } from "zod";
import { modelToolSchema } from "./model-tool-schema.js";
import type { ToolHandlerContext, ToolRegistration } from "./types.js";

export const SkillToolInputSchema = z
  .object({
    name: z.string().min(1).describe("The skill's name as listed, e.g. story-review."),
  })
  .strict();

export type SkillToolInput = z.output<typeof SkillToolInputSchema>;

/** The loaded skill's text, or the refusal the model reads. */
export type SkillInvocation = { ok: true; text: string } | { ok: false; message: string };

export function createSkillToolRegistrations(deps: {
  invoke(threadId: string, name: string): Promise<SkillInvocation>;
}): ToolRegistration[] {
  return [
    {
      source: "skill",
      definition: {
        type: "function",
        name: "skill",
        description: "Load a skill listed under Available skills.",
        inputSchema: modelToolSchema(SkillToolInputSchema),
      },
      input: SkillToolInputSchema,
      historyKind: "routine",
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) => {
          const result = await deps.invoke(ctx.threadId, (input as SkillToolInput).name);
          return result.ok ? result.text : { isError: true, output: { message: result.message } };
        },
      },
    },
  ];
}

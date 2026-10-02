/** Model `skill` tool: load an available SKILL.md body into this turn. */
import { z } from "zod";
import { modelToolSchema } from "./model-tool-schema.js";
import type { ToolHandlerContext, ToolRegistration } from "./types.js";

export const SkillToolInputSchema = z.object({ slug: z.string().min(1) }).strict();

export function createSkillToolRegistrations(deps: {
  loadBody(threadId: string, slug: string): Promise<{ slug: string; body: string }>;
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
      historyPreview: (input) => String(input.slug ?? ""),
      historyKind: "routine",
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) => {
          const { slug } = input as z.output<typeof SkillToolInputSchema>;
          try {
            const loaded = await deps.loadBody(ctx.threadId, slug);
            return { slug: loaded.slug, body: loaded.body };
          } catch (error) {
            return {
              isError: true,
              output: {
                message:
                  error instanceof Error ? error.message : `Skill "${slug}" is not available`,
              },
            };
          }
        },
      },
    },
  ];
}

/** Model `skill` tool: load an available SKILL.md body, or one file beside it, into this turn. */
import { z } from "zod";
import { withSkillResources } from "../loop/activated-skills.js";
import { modelToolSchema } from "./model-tool-schema.js";
import type { ToolHandlerContext, ToolRegistration } from "./types.js";

export const SkillToolInputSchema = z
  .object({
    slug: z.string().min(1),
    resource: z
      .string()
      .min(1)
      .optional()
      .describe("A file the skill lists under Resources, such as resources/line-edit.md."),
  })
  .strict();

export function createSkillToolRegistrations(deps: {
  loadBody(
    threadId: string,
    slug: string,
  ): Promise<{ slug: string; body: string; resources: readonly string[] }>;
  loadResource(threadId: string, slug: string, resource: string): Promise<string>;
}): ToolRegistration[] {
  return [
    {
      source: "skill",
      definition: {
        type: "function",
        name: "skill",
        description:
          "Load a skill listed under Available skills. With no such list, you have none.",
        inputSchema: modelToolSchema(SkillToolInputSchema),
      },
      input: SkillToolInputSchema,
      historyKind: "routine",
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) => {
          const { slug, resource } = input as z.output<typeof SkillToolInputSchema>;
          try {
            if (resource !== undefined)
              return await deps.loadResource(ctx.threadId, slug, resource);
            return withSkillResources(await deps.loadBody(ctx.threadId, slug));
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

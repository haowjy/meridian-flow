/** Model `skill` tool: load an available SKILL.md body into this turn. */
import type { ToolHandlerContext, ToolRegistration } from "./types.js";

export function createSkillToolRegistrations(deps: {
  loadBody(threadId: string, slug: string): Promise<{ slug: string; body: string }>;
}): ToolRegistration[] {
  return [
    {
      source: "skill",
      definition: {
        type: "function",
        name: "skill",
        description:
          "Load an available skill's instructions into this turn. Pass the skill slug listed in the system prompt.",
        inputSchema: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Available skill slug" },
          },
          required: ["slug"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) => {
          const slug = skillSlug(input);
          if (!slug) {
            return { isError: true, output: { message: "slug is required" } };
          }
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

function skillSlug(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const slug = (input as { slug?: unknown }).slug;
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

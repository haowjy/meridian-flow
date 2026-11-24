import { z } from "zod";

export const reasoningLevelSchema = z.string().min(1);
export type ReasoningLevel = string;

const AGENT_PERMISSION_VALUES = ["read", "edit"] as const;
export type AgentPermission = (typeof AGENT_PERMISSION_VALUES)[number];
export const DEFAULT_AGENT_PERMISSION: AgentPermission = "edit";
export const agentPermissionSchema = z.enum(AGENT_PERMISSION_VALUES, {
  error: (issue) =>
    `Expected "read" or "edit", got ${JSON.stringify((issue as { input?: unknown }).input)}`,
});

export const retainedSkillReferenceSchema = z.object({
  packageRevisionId: z.string(),
  path: z.string(),
  contentDigest: z.string(),
});
export type RetainedSkillReference = z.infer<typeof retainedSkillReferenceSchema>;

export const resolvedAgentConfigurationSchema = z.object({
  model: z.string(),
  skills: z.object({
    load: z.array(retainedSkillReferenceSchema),
    available: z.array(retainedSkillReferenceSchema),
  }),
  namedTargets: z.array(z.object({ name: z.string(), definitionRevisionId: z.string() })),
  tools: z.array(z.string()).optional(),
  "disallowed-tools": z.array(z.string()).optional(),
  effort: reasoningLevelSchema.optional(),
  permission: agentPermissionSchema,
});
export type ResolvedAgentConfiguration = z.infer<typeof resolvedAgentConfigurationSchema>;

export const invocationPatchSchema = z
  .object({
    model: z.string().optional(),
    effort: reasoningLevelSchema.optional(),
    permission: agentPermissionSchema.optional(),
    "disallowed-tools": z.array(z.string()).optional(),
    subagents: z.array(z.string()).optional(),
    skills: z
      .object({
        load: z.array(z.string()).optional(),
        available: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type InvocationPatch = z.infer<typeof invocationPatchSchema>;

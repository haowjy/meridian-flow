/**
 * Canonical execution-knob contract: the resolved configuration is the shape
 * every surface projects onto. Value sets, the resolved schema, and the
 * presence-sensitive invocation patch are declared once here and imported by
 * the compiler, the resolver, and the patch merge.
 */
import { z } from "zod";

/** Canonical reasoning-effort values carried on a resolved configuration. */
export const AGENT_EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "none",
  "disabled",
  "adaptive",
] as const;
export type AgentEffort = (typeof AGENT_EFFORT_VALUES)[number];
export const agentEffortSchema = z.enum(AGENT_EFFORT_VALUES);

/**
 * What an agent may change (file-access §8). `read` agents still edit their own
 * Work's `scratch://`; delegation applies the minimum over the agent chain.
 */
const AGENT_PERMISSION_VALUES = ["read", "edit"] as const;
export type AgentPermission = (typeof AGENT_PERMISSION_VALUES)[number];
/** An unset permission resolves to this. */
export const DEFAULT_AGENT_PERMISSION: AgentPermission = "edit";
export const agentPermissionSchema = z.enum(AGENT_PERMISSION_VALUES, {
  error: (issue) =>
    `Expected "read" or "edit", got ${JSON.stringify((issue as { input?: unknown }).input)}`,
});

/** A retained skill reference resolved by binding preparation. */
export const retainedSkillReferenceSchema = z.object({
  packageRevisionId: z.string(),
  path: z.string(),
  contentDigest: z.string(),
});
export type RetainedSkillReference = z.infer<typeof retainedSkillReferenceSchema>;

/** The canonical resolved execution configuration; a type source, not a runtime read boundary. */
export const resolvedAgentConfigurationSchema = z.object({
  model: z.string(),
  skills: z.object({
    load: z.array(retainedSkillReferenceSchema),
    available: z.array(retainedSkillReferenceSchema),
  }),
  namedTargets: z.array(z.object({ name: z.string(), definitionRevisionId: z.string() })),
  /** Allow-list of real tool names; absent means the full catalog. */
  tools: z.array(z.string()).optional(),
  "disallowed-tools": z.array(z.string()).optional(),
  effort: agentEffortSchema.optional(),
  permission: agentPermissionSchema,
});
export type ResolvedAgentConfiguration = z.infer<typeof resolvedAgentConfigurationSchema>;

/** Presence-sensitive per-invocation patch; `.strict()` makes unknown keys unrepresentable. */
export const invocationPatchSchema = z
  .object({
    model: z.string().optional(),
    effort: agentEffortSchema.optional(),
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

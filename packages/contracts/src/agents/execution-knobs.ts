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

/** Authoring aliases fold onto a canonical value; an alias is not a second value set. */
export const AGENT_EFFORT_ALIASES = { max: "xhigh" } as const;

/** Every string the authoring/patch surfaces accept, canonical values plus alias keys. */
export const AGENT_EFFORT_AUTHORING_VALUES = [
  ...AGENT_EFFORT_VALUES,
  ...(Object.keys(AGENT_EFFORT_ALIASES) as Array<keyof typeof AGENT_EFFORT_ALIASES>),
] as const;

/**
 * Authoring values are trimmed and lowercased before the enum check: the
 * frontmatter and mars.toml overlay layers do not pre-normalize, so `" High "`
 * must land on `high` here.
 */
export const agentEffortAuthoringSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(AGENT_EFFORT_AUTHORING_VALUES))
  .transform((value) => (value === "max" ? ("xhigh" as const) : value));

/**
 * What an agent may change (file-access §8). `read` agents still edit their own
 * Work's `scratch://`; delegation applies the minimum over the agent chain.
 */
export const AGENT_PERMISSION_VALUES = ["read", "edit"] as const;
export type AgentPermission = (typeof AGENT_PERMISSION_VALUES)[number];
/** An unset permission resolves to this. */
export const DEFAULT_AGENT_PERMISSION: AgentPermission = "edit";
export const agentPermissionSchema = z.enum(AGENT_PERMISSION_VALUES, {
  error: (issue) =>
    `Expected "read" or "edit", got ${JSON.stringify((issue as { input?: unknown }).input)}`,
});

/**
 * Mars tool-name aliases, canonical here so authoring and overrides fold the
 * same way. No alias may be a Flow tool name (`search`, `find`): folding one
 * would rename a real tool.
 */
export const toolAliases: Record<string, string> = {
  bash: "bash",
  shell: "bash",
  terminal: "bash",
  exec_command: "bash",
  shell_command: "bash",
  file_write: "edit",
  apply_patch: "edit",
  edit: "edit",
  sed: "edit",
  str_replace: "edit",
  agent: "agent",
  subagent: "agent",
  spawn_agent: "agent",
  task: "agent",
  skill: "skill",
  workflow: "workflow",
  glob: "glob",
  grep: "grep",
  rg: "grep",
  ripgrep: "grep",
  notebook: "notebook",
  jupyter: "notebook",
  web_search: "web_search",
  websearch: "web_search",
  web: "web_search",
  web_fetch: "web_fetch",
  webfetch: "web_fetch",
  fetch: "web_fetch",
  curl: "web_fetch",
  ask_user: "ask_user",
  askuser: "ask_user",
  request_user_input: "ask_user",
  ask_question: "ask_user",
  todo_read: "todo_read",
  todoread: "todo_read",
  todo_write: "todo_write",
  todowrite: "todo_write",
  cron: "cron",
  notifications: "notifications",
  pushnotification: "notifications",
  push_notification: "notifications",
  plan_mode: "plan_mode",
  planmode: "plan_mode",
  update_plan: "plan_mode",
  switch_mode: "plan_mode",
  worktree: "worktree",
  lsp: "lsp",
  monitor: "monitor",
  send_user_file: "send_user_file",
  senduserfile: "send_user_file",
  schedule_wakeup: "schedule_wakeup",
  schedulewakeup: "schedule_wakeup",
  remote_trigger: "remote_trigger",
  remotetrigger: "remote_trigger",
  tool_search: "tool_search",
  toolsearch: "tool_search",
};

/**
 * `edit` was a capability; access is now `permission` and the document tool is
 * `write` (D12, D34). An allow-list naming it fails with the replacement named.
 */
export const EDIT_IS_PERMISSION_ERROR =
  '"edit" is not a tool. Use "permission: read" or "permission: edit" for what the agent may change, and the "write" tool for documents.';

const TOOL_LIST_ERROR =
  "Expected a list of tool names, e.g. [read, write]; deny tools with disallowed-tools.";

/** One authoring tool name, alias-folded; Flow's support check rejects names outside its catalog. */
function toolReference(rejectEdit: boolean) {
  return z
    .string()
    .trim()
    .min(1)
    .transform((value, context) => {
      const normalized = normalizeToolName(value);
      if (!normalized) {
        context.addIssue({ code: "custom", message: "Invalid Mars tool reference" });
        return z.NEVER;
      }
      if (rejectEdit && normalized.head === "edit") {
        context.addIssue({ code: "custom", message: EDIT_IS_PERMISSION_ERROR });
        return z.NEVER;
      }
      return normalized.name;
    });
}

function toolList(rejectEdit: boolean) {
  return z
    .array(toolReference(rejectEdit), { error: TOOL_LIST_ERROR })
    .transform((values) => [...new Set(values)]);
}

/** A `tools` allow-list; duplicates collapse after folding. */
export const toolAllowListSchema = toolList(true);

/**
 * A `disallowed-tools` list. Flow ignores a name it doesn't have (D57), so
 * `edit` (a normal Claude Code read-only profile's `Edit`) is ignored too.
 */
export const toolDenyListSchema = toolList(false);

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

/** A folded tool reference: the canonical name plus the capability head the alias fold resolved. */
type NormalizedToolName = {
  /** Canonical name, retaining any scoped `(...)` payload or MCP identity verbatim. */
  name: string;
  /** Canonical capability the head folds to, with the payload removed. */
  head: string;
};

// Mars canonical names retain scoped payloads and case-sensitive MCP identities.
function normalizeToolName(value: string): NormalizedToolName | null {
  const open = value.indexOf("(");
  const head = (open < 0 ? value : value.slice(0, open)).trim();
  const payload = open < 0 ? "" : value.slice(open);
  if (!head) return null;
  const lower = head.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (lower === "__proto__") return null;
  if (lower === "mcp" && payload) {
    if (!payload.endsWith(")")) return null;
    const segments = payload.slice(1, -1).split("/");
    if (segments.length > 2 || segments.some((segment) => !segment.trim())) return null;
    return { name: value, head: lower };
  }
  if (lower.startsWith("mcp__")) return { name: value, head: lower };
  const alias = Object.hasOwn(toolAliases, lower) ? toolAliases[lower] : undefined;
  if (alias) return { name: alias + payload, head: alias };
  if (head.includes("_") || !/[a-z]/.test(head)) return { name: lower + payload, head: lower };
  const snake = head.replace(
    /[A-Z]/g,
    (letter, offset) => `${offset ? "_" : ""}${letter.toLowerCase()}`,
  );
  const folded = Object.hasOwn(toolAliases, snake) ? toolAliases[snake] : snake;
  return { name: folded + payload, head: folded };
}

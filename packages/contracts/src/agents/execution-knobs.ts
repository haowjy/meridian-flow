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

export const TOOL_POLICIES = ["allow", "deny"] as const;
export type ToolPolicy = (typeof TOOL_POLICIES)[number];
export const toolPolicySchema = z.enum(TOOL_POLICIES);

/** Mars tool-name aliases, canonical here so authoring and overrides fold the same way. */
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
  find: "glob",
  grep: "grep",
  rg: "grep",
  search: "grep",
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

/** `write` is a model tool name, never an authoring capability. */
export const WRITE_IS_MODEL_TOOL_ERROR =
  '"write" is the model tool name; use "edit" for the document-edit capability';

const RETIRED_READ_NAMES = new Set(["read", "cat", "view", "file_read"]);
const RETIRED_READ_ERROR =
  'Reading is always available; remove this retired read capability entry. Use "edit" to control document mutations.';

function isRetiredReadName(value: string): boolean {
  const open = value.indexOf("(");
  const head = (open < 0 ? value : value.slice(0, open))
    .trim()
    .replace(/[A-Z]/g, (x) => x.toLowerCase());
  return RETIRED_READ_NAMES.has(head);
}

export const toolReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    if (isRetiredReadName(value)) {
      context.addIssue({ code: "custom", message: RETIRED_READ_ERROR });
      return z.NEVER;
    }
    const normalized = normalizeToolName(value);
    if (normalized === null) {
      context.addIssue({ code: "custom", message: "Invalid Mars tool reference" });
      return z.NEVER;
    }
    if (normalized.head === "write") {
      context.addIssue({ code: "custom", message: WRITE_IS_MODEL_TOOL_ERROR });
      return z.NEVER;
    }
    return normalized.name;
  });
export const toolReferencesSchema = z
  .array(toolReferenceSchema)
  .transform((values) => [...new Set(values)]);

/**
 * Fold aliases before duplicate detection so `shell` and `bash` collide
 * observably. Same folded name with the same policy collapses; a different
 * policy is a diagnostic. `Object.fromEntries` collapses only after the check.
 */
export const toolMapSchema = z
  .record(z.string(), toolPolicySchema)
  .transform((map) =>
    Object.entries(map).map(([name, policy]) => [normalizeToolName(name.trim()), policy] as const),
  )
  .superRefine((folded, context) => {
    const names = new Map<string, string>();
    for (const [normalized, policy] of folded) {
      if (normalized && isRetiredReadName(normalized.name)) {
        context.addIssue({ code: "custom", message: RETIRED_READ_ERROR });
        continue;
      }
      if (normalized?.head === "write") {
        context.addIssue({ code: "custom", message: WRITE_IS_MODEL_TOOL_ERROR });
        continue;
      }
      const name = normalized?.name;
      if (!name || (names.has(name) && names.get(name) !== policy)) {
        context.addIssue({ code: "custom", message: "Empty or duplicate normalized tool name" });
      }
      if (name) names.set(name, policy);
    }
  })
  .transform((folded) =>
    Object.fromEntries(
      folded.flatMap(([normalized, policy]) =>
        normalized === null || normalized.head === "write"
          ? []
          : [[normalized.name, policy] as const],
      ),
    ),
  );

/**
 * Authoring/patch tool representation; folds tool-name aliases on parse.
 * Array vs map is exclusive: a union collapses inner custom issues to "Invalid input".
 */
export const toolRepresentationSchema = z.unknown().transform((value, context) => {
  const parsed = Array.isArray(value)
    ? toolReferencesSchema.safeParse(value)
    : toolMapSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    context.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
  return z.NEVER;
});
/** Resolved config stores canonical names already, so it is the plain union. */
export const resolvedToolsSchema = z.union([
  z.array(z.string()),
  z.record(z.string(), toolPolicySchema),
]);

/** Authoring tool selection; resolved configurations are already canonical. */
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
  tools: resolvedToolsSchema.optional(),
  "disallowed-tools": z.array(z.string()).optional(),
  effort: agentEffortSchema.optional(),
});
export type ResolvedAgentConfiguration = z.infer<typeof resolvedAgentConfigurationSchema>;

/** Presence-sensitive per-invocation patch; `.strict()` makes unknown keys unrepresentable. */
export const invocationPatchSchema = z
  .object({
    model: z.string().optional(),
    effort: agentEffortSchema.optional(),
    tools: toolRepresentationSchema.optional(),
    "disallowed-tools": z.array(toolReferenceSchema).optional(),
    subagents: z.array(z.string()).optional(),
    skills: z
      .object({
        load: z.array(z.string()).optional(),
        available: z.array(z.string()).optional(),
      })
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

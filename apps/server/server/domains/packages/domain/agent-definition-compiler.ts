/** Compiles preserved Mars source into presence-sensitive, content-addressed definitions. */
import { z } from "zod";
import { sha256 } from "./helpers.js";
import { canonicalizeJsonObject } from "./mars-source.js";
import type { JsonObject } from "./types.js";

const reference = z.string().trim().min(1);
const references = z.array(reference);
const skills = z.union([
  references.transform((load) => ({ load })),
  z.strictObject({ load: references.optional(), available: references.optional() }),
]);
const toolAliases: Record<string, string> = {
  bash: "bash",
  shell: "bash",
  terminal: "bash",
  exec_command: "bash",
  shell_command: "bash",
  read: "read",
  cat: "read",
  view: "read",
  file_read: "read",
  write: "write",
  file_write: "write",
  apply_patch: "write",
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
const toolReference = reference.transform((value, context) => {
  const name = normalizeToolName(value);
  if (name === null) {
    context.addIssue({ code: "custom", message: "Invalid Mars tool reference" });
    return z.NEVER;
  }
  return name;
});
const toolReferences = z.array(toolReference).transform((values) => [...new Set(values)]);
const toolMap = z
  .record(z.string(), z.enum(["allow", "deny"]))
  .superRefine((value, context) => {
    const names = new Map<string, string>();
    for (const [key, policy] of Object.entries(value)) {
      const name = normalizeToolName(key.trim());
      if (!name || (names.has(name) && names.get(name) !== policy)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Empty or duplicate normalized tool name",
        });
      }
      if (name) names.set(name, policy);
    }
  })
  .transform((value) =>
    Object.fromEntries(
      Object.entries(value).map(([key, policy]) => [
        normalizeToolName(key.trim()) as string,
        policy,
      ]),
    ),
  );
const tools = z.union([toolReferences, toolMap]);
const metadata = z.looseObject({
  name: reference.optional(),
  description: z.string().optional(),
  model: reference.optional(),
  effort: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["low", "medium", "high", "xhigh", "none", "max", "disabled", "adaptive"]))
    .transform((value) => (value === "max" ? ("xhigh" as const) : value))
    .optional(),
  mode: z.enum(["primary", "subagent"]).optional(),
  "model-invocable": z.boolean().optional(),
  "user-invocable": z.boolean().optional(),
  tools: tools.optional(),
  "disallowed-tools": toolReferences.optional(),
  subagents: references.optional(),
  skills: skills.optional(),
  approval: z.enum(["default", "auto", "confirm", "never"]).optional(),
  autocompact: z.number().int().min(0).max(4_294_967_295).optional(),
  autocompact_pct: z.number().int().min(1).max(100).optional(),
});

const overlayMetadata = metadata.extend({
  tools: z
    .strictObject({
      allowed: toolReferences.optional(),
      disallowed: toolReferences.optional(),
    })
    .optional(),
});

export type NormalizedAgentMetadata = z.infer<typeof metadata>;
export interface CompiledAgentDefinition {
  schemaVersion: 1;
  systemPrompt: string;
  metadata: NormalizedAgentMetadata;
}
export interface AgentCompilationDiagnostic {
  field: string;
  message: string;
}
export type AgentCompilationResult =
  | { ok: true; definition: CompiledAgentDefinition; digest: string }
  | { ok: false; diagnostics: AgentCompilationDiagnostic[] };

/**
 * Syntax compilation only. The binding owner must separately check runtime support,
 * resolve model aliases/dependencies, and retain the resulting execution configuration.
 */
export function compileAgentDefinition(source: {
  body: string;
  meta: JsonObject;
  config?: JsonObject;
}): AgentCompilationResult {
  const diagnostics: AgentCompilationDiagnostic[] = [];
  validateJson(source.meta, "meta", diagnostics);
  validateJson(source.config ?? {}, "config", diagnostics);
  if (diagnostics.length) return { ok: false, diagnostics };
  const frontmatter = normalizeAliases(source.meta, "meta", diagnostics);
  const overlay = normalizeAliases(source.config ?? {}, "config", diagnostics);
  const parsedMeta = metadata.safeParse(frontmatter);
  // Validate both layers: a valid overlay must not hide malformed source fields.
  if (!parsedMeta.success) addIssues("meta", parsedMeta.error, diagnostics);
  const parsedOverlay = overlayMetadata.safeParse(overlay);
  if (!parsedOverlay.success) addIssues("config", parsedOverlay.error, diagnostics);
  if (!parsedMeta.success || !parsedOverlay.success || diagnostics.length) {
    return { ok: false, diagnostics };
  }

  const { tools: overlayTools, ...overlayFields } = parsedOverlay.data;
  const merged: NormalizedAgentMetadata = { ...parsedMeta.data, ...overlayFields };
  if (parsedMeta.data.skills && parsedOverlay.data.skills) {
    merged.skills = { ...parsedMeta.data.skills, ...parsedOverlay.data.skills };
  }
  if (overlayTools?.allowed !== undefined) {
    const baseTools = parsedMeta.data.tools;
    const denials =
      baseTools && !Array.isArray(baseTools) && overlayTools.disallowed === undefined
        ? Object.entries(baseTools).filter(([, policy]) => policy === "deny")
        : [];
    merged.tools = denials.length
      ? (Object.fromEntries([
          ...overlayTools.allowed.map((tool) => [tool, "allow"] as const),
          ...denials,
        ]) as Record<string, "allow" | "deny">)
      : overlayTools.allowed;
  }
  if (overlayTools?.disallowed !== undefined) {
    merged["disallowed-tools"] = overlayTools.disallowed;
    if (merged.tools && !Array.isArray(merged.tools)) {
      merged.tools = Object.fromEntries(
        Object.entries(merged.tools).filter(([, policy]) => policy === "allow"),
      );
    }
  }
  const definition: CompiledAgentDefinition = {
    schemaVersion: 1,
    systemPrompt: source.body,
    metadata: canonicalizeJsonObject(merged) as NormalizedAgentMetadata,
  };
  return {
    ok: true,
    definition,
    digest: sha256(
      JSON.stringify(
        canonicalizeJsonObject({
          kind: "meridian.agent-definition",
          ...definition,
        }),
      ),
    ),
  };
}

function normalizeAliases(
  input: JsonObject,
  layer: string,
  diagnostics: AgentCompilationDiagnostic[],
): JsonObject {
  const result = { ...input };
  for (const [alias, canonical] of [
    ["model_invocable", "model-invocable"],
    ["user_invocable", "user-invocable"],
  ] as const) {
    if (!Object.hasOwn(result, alias)) continue;
    if (Object.hasOwn(result, canonical) && result[alias] !== result[canonical]) {
      diagnostics.push({ field: `${layer}.${canonical}`, message: `Conflicts with ${alias}` });
    } else {
      result[canonical] = result[alias];
    }
    delete result[alias];
  }
  return result;
}

function addIssues(layer: string, error: z.ZodError, diagnostics: AgentCompilationDiagnostic[]) {
  for (const issue of error.issues) {
    diagnostics.push({ field: [layer, ...issue.path].join("."), message: issue.message });
  }
}

function validateJson(
  value: unknown,
  field: string,
  diagnostics: AgentCompilationDiagnostic[],
  ancestors = new Set<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    diagnostics.push({ field, message: "Expected finite, acyclic JSON source content" });
    return;
  }
  ancestors.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__") {
      diagnostics.push({ field: `${field}.${key}`, message: "Reserved metadata key __proto__" });
    } else {
      validateJson(entry, `${field}.${key}`, diagnostics, ancestors);
    }
  }
  ancestors.delete(value);
}

// Mars canonical names retain scoped payloads and case-sensitive MCP identities.
function normalizeToolName(value: string): string | null {
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
    return value;
  }
  if (lower.startsWith("mcp__")) return value;
  const alias = Object.hasOwn(toolAliases, lower) ? toolAliases[lower] : undefined;
  if (alias) return alias + payload;
  if (head.includes("_") || !/[a-z]/.test(head)) return lower + payload;
  const snake = head.replace(
    /[A-Z]/g,
    (letter, offset) => `${offset ? "_" : ""}${letter.toLowerCase()}`,
  );
  return (Object.hasOwn(toolAliases, snake) ? toolAliases[snake] : snake) + payload;
}

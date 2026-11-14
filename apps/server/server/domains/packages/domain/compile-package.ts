/**
 * Reads one package's files with Mars and decides which Agents are available.
 *
 * The rule this keeps: anything Mars reports on an Agent's file, of any severity, makes that
 * Agent unavailable, and an unavailable Agent has no definition for anything to run. An Agent
 * never runs with more access than its file says. Mars's severity says whether `mars sync`
 * goes on, not whether a restriction survived (a misspelled `harness-overrides` is a warning
 * that drops the block), so availability is decided by the table in `agentErrors`, not by
 * filtering on severity.
 */
import { canonicalizeJsonObject, sha256 } from "./helpers.js";
import {
  type AgentFields,
  agentSlugOf,
  bodyOf,
  type Diagnostic,
  GRAMMAR_VERSION,
  MANIFEST_PATH,
  projectRules,
  readAgent,
  readManifest,
  readSkill,
  skillSlugOf,
  type ToolProjection,
} from "./mars.js";
import type { SkillFiles } from "./types.js";

export class AgentSourceError extends Error {}

export interface AgentSourceSnapshot {
  coordinate: string;
  files: SkillFiles;
}

export interface PackageDiagnostic {
  /** Package-relative path: `mars.toml`, `agents/critic.md`, `skills/x/SKILL.md`. */
  file: string;
  /** Mars's code, or `flow.*`. */
  code: string;
  severity: "error" | "warning" | "info";
  path: (string | number)[];
  message: string;
}

/** The keys `domains/runtime` reads, which also checks each one against its own list. */
export interface NormalizedAgentMetadata {
  name?: string;
  description?: string;
  model?: string;
  effort?: "none" | "low" | "medium" | "high" | "xhigh";
  mode?: "primary" | "subagent";
  permission?: "read" | "edit";
  "model-invocable"?: boolean;
  "user-invocable"?: boolean;
  /** An allow-list; absent means every tool. `[]` means none. */
  tools?: string[];
  "disallowed-tools"?: string[];
  subagents?: string[];
  skills?: { load?: string[]; available?: string[] };
}
export interface CompiledAgentDefinition {
  schemaVersion: 1;
  systemPrompt: string;
  metadata: NormalizedAgentMetadata;
}

export interface CompiledAgent {
  slug: string;
  name: string;
  description: string;
  diagnostics: PackageDiagnostic[];
  /** Null iff the Agent is unavailable. */
  definition: CompiledAgentDefinition | null;
}
export interface CompiledPackage {
  coordinate: string;
  grammarVersion: string;
  contentDigest: string;
  files: SkillFiles;
  agents: CompiledAgent[];
}

export function compilePackage(
  input: AgentSourceSnapshot,
  grammarVersion: string = GRAMMAR_VERSION,
): CompiledPackage {
  const files = validatedFiles(input);
  const packageErrors = manifestErrors(files);
  const skills = readSkills(files);

  const drafts = new Map<string, Draft>();
  for (const path of Object.keys(files).sort()) {
    const slug = agentSlugOf(path);
    if (slug === undefined) continue;
    drafts.set(slug, draftAgent(slug, path, files[path], packageErrors, skills));
  }
  rejectBrokenSubagents(drafts);

  return {
    coordinate: input.coordinate,
    grammarVersion,
    contentDigest: sha256(
      JSON.stringify(
        canonicalizeJsonObject({
          kind: "meridian.agent-source",
          coordinate: input.coordinate,
          files,
        }),
      ),
    ),
    files,
    agents: [...drafts.values()].map((draft) => ({
      slug: draft.slug,
      name: draft.fields?.name ?? draft.slug,
      description: draft.fields?.description ?? "",
      diagnostics: [...draft.errors, ...draft.warnings],
      definition: draft.errors.length === 0 ? definitionOf(draft) : null,
    })),
  };
}

function validatedFiles(input: AgentSourceSnapshot): SkillFiles {
  if (
    !input.coordinate.trim() ||
    input.coordinate.includes("\0") ||
    Buffer.from(input.coordinate).toString("utf8") !== input.coordinate
  ) {
    throw new AgentSourceError("Agent source coordinate must be nonempty UTF-8 text without NUL");
  }
  for (const [name, text] of Object.entries(input.files)) {
    if (
      name.startsWith("/") ||
      /^[a-z]:/i.test(name) ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new AgentSourceError(`Invalid Agent source file path: ${name}`);
    }
    if (
      typeof text !== "string" ||
      text.includes("\0") ||
      Buffer.from(text).toString("utf8") !== text
    ) {
      throw new AgentSourceError(`Agent source ${name} is not valid UTF-8 text`);
    }
  }
  return input.files;
}

const fromMars = (file: string, diagnostic: Diagnostic): PackageDiagnostic => ({
  file,
  code: diagnostic.code,
  severity: diagnostic.severity,
  path: diagnostic.path,
  message: diagnostic.message,
});
const flow = (
  file: string,
  code: string,
  message: string,
  severity: "error" | "warning" = "error",
  path: (string | number)[] = [],
): PackageDiagnostic => ({ file, code: `flow.${code}`, severity, path, message });

/** Findings on `mars.toml` that make every Agent of the package unavailable. */
function manifestErrors(files: SkillFiles): PackageDiagnostic[] {
  const text = files[MANIFEST_PATH];
  if (text === undefined) {
    return [flow(MANIFEST_PATH, "manifest-missing", "The package has no mars.toml")];
  }
  const reading = readManifest(text);
  const errors = reading.diagnostics.map((item) => fromMars(MANIFEST_PATH, item));
  // Mars merges these into every Agent at sync but its reading does not (mars-agents#376).
  if (reading.fields?.tools && Object.keys(reading.fields.tools).length) {
    errors.push(
      flow(MANIFEST_PATH, "package-tools-unsupported", "[package.tools] is not supported yet"),
    );
  }
  return errors;
}

/** Skills of the package whose file reads with no diagnostic, by slug; the rest by their reasons. */
function readSkills(files: SkillFiles): Map<string, PackageDiagnostic[]> {
  const skills = new Map<string, PackageDiagnostic[]>();
  for (const [path, text] of Object.entries(files)) {
    const slug = skillSlugOf(path);
    if (slug === undefined) continue;
    skills.set(
      slug,
      readSkill(slug, text).diagnostics.map((item) => fromMars(path, item)),
    );
  }
  return skills;
}

interface Draft {
  slug: string;
  file: string;
  fields: AgentFields | null;
  body: string;
  /** Blocking: Mars's findings of any severity, and Flow's own errors. */
  errors: PackageDiagnostic[];
  warnings: PackageDiagnostic[];
  permission: "read" | "edit" | undefined;
  tools: ToolProjection | undefined;
}

function draftAgent(
  slug: string,
  file: string,
  text: string,
  packageErrors: PackageDiagnostic[],
  skills: Map<string, PackageDiagnostic[]>,
): Draft {
  const reading = readAgent(slug, text);
  const draft: Draft = {
    slug,
    file,
    fields: reading.fields,
    body: bodyOf(reading),
    errors: [...packageErrors, ...reading.diagnostics.map((item) => fromMars(file, item))],
    warnings: [],
    permission: undefined,
    tools: undefined,
  };
  const { fields } = reading;
  if (!fields) return draft;

  draft.permission = flowPermission(reading.frontmatter, file, draft.errors);
  if (
    fields.sandbox === "read-only" ||
    fields["model-policies"].some((rule) => rule.override?.sandbox === "read-only")
  ) {
    draft.permission = "read";
  }
  if (fields.tools.length) draft.tools = projectTools(fields.tools, file, draft);
  if (fields["model-policies"].length) {
    draft.warnings.push(
      flow(file, "model-policies-ignored", "model-policies are read, not applied", "warning"),
    );
  }
  if (fields.approval === "confirm") {
    draft.warnings.push(
      flow(file, "approval-confirm", "approval: confirm runs as allow", "warning"),
    );
  }
  for (const name of [...fields.skills.load, ...fields.skills.available]) {
    const skill = skills.get(name);
    if (skill === undefined) {
      draft.errors.push(flow(file, "skill-missing", `Skill "${name}" is not in this package`));
    } else if (skill.length) {
      draft.errors.push(
        flow(file, "skill-unavailable", `Skill "${name}" has a problem: ${skill[0].message}`),
      );
    }
  }
  return draft;
}

/**
 * Lowers the Agent's tool rules with Mars's `project`; precedence and coverage are Mars's. A rule
 * Mars cannot name or scope on Flow makes the Agent unavailable, because a deny that is not
 * enforced would leave the Agent with more access than its file says.
 */
function projectTools(rules: AgentFields["tools"], file: string, draft: Draft): ToolProjection {
  const projection = projectRules(rules, "meridian-flow");
  projection.rules.forEach((projected, index) => {
    if (projected.status !== "unscopable" && projected.status !== "unknown") return;
    const { capability, pattern, action } = projected.rule;
    const named = `${capability}${pattern === null ? "" : `(${pattern})`}: ${action}`;
    const message = `Tool rule ${named}: ${projected.note ?? projected.status}`;
    draft.errors.push(flow(file, `tools-${projected.status}`, message, "error", ["tools", index]));
  });
  if (projection.ask.length || projection.default === "ask") {
    const named = projection.default === "ask" ? ["*", ...projection.ask] : projection.ask;
    const message = `ask runs as allow: ${named.join(", ")}`;
    draft.warnings.push(flow(file, "tools-ask", message, "warning", ["tools"]));
  }
  return projection;
}

type Frontmatter = [string, unknown][];
const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Flow's block of `harness-overrides`, checked from the file as written: Mars returns it
 * unchecked, and a misspelled key must not fall back to the default (`edit`).
 */
function flowPermission(
  frontmatter: Frontmatter,
  file: string,
  errors: PackageDiagnostic[],
): "read" | "edit" | undefined {
  const overrides = frontmatter.find(([key]) => key === "harness-overrides")?.[1];
  if (overrides === undefined) return undefined;
  const path = ["harness-overrides"];
  if (!isMap(overrides)) {
    errors.push(flow(file, "key-unknown", "harness-overrides must be a map", "error", path));
    return undefined;
  }
  const block = overrides["meridian-flow"];
  if (block === undefined) return undefined;
  path.push("meridian-flow");
  if (!isMap(block)) {
    errors.push(
      flow(file, "key-unknown", "harness-overrides.meridian-flow must be a map", "error", path),
    );
    return undefined;
  }
  for (const key of Object.keys(block)) {
    if (key !== "permission") {
      errors.push(
        flow(file, "key-unknown", `Unknown key "${key}"; only permission is read`, "error", [
          ...path,
          key,
        ]),
      );
    }
  }
  if (!Object.hasOwn(block, "permission")) return undefined;
  const value = block.permission;
  if (value !== "read" && value !== "edit") {
    errors.push(
      flow(file, "permission-invalid", 'permission must be "read" or "edit"', "error", [
        ...path,
        "permission",
      ]),
    );
    return undefined;
  }
  return value;
}

/** An Agent that names a subagent that is not an available, invocable Agent is unavailable too. */
function rejectBrokenSubagents(drafts: Map<string, Draft>): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const draft of drafts.values()) {
      if (draft.errors.length || !draft.fields) continue;
      for (const name of draft.fields.subagents) {
        const target = drafts.get(name);
        const [code, message] = !target
          ? ["subagent-missing", `Subagent "${name}" is not in this package`]
          : target.errors.length
            ? ["subagent-unavailable", `Subagent "${name}" is unavailable`]
            : target.fields?.["model-invocable"] === false
              ? ["subagent-not-invocable", `Subagent "${name}" is not model-invocable`]
              : [];
        if (code && message) {
          draft.errors.push(flow(draft.file, code, message));
          changed = true;
        }
      }
    }
  }
}

function definitionOf(draft: Draft): CompiledAgentDefinition {
  const fields = draft.fields as AgentFields;
  const metadata: NormalizedAgentMetadata = {
    ...(fields.name !== null ? { name: fields.name } : {}),
    ...(fields.description !== null ? { description: fields.description } : {}),
    ...(fields.model !== null ? { model: fields.model } : {}),
    ...(fields.mode !== null ? { mode: fields.mode } : {}),
    "model-invocable": fields["model-invocable"],
    "user-invocable": fields["user-invocable"],
    ...(fields.effort !== null
      ? { effort: fields.effort === "max" ? "xhigh" : fields.effort }
      : {}),
    skills: { load: fields.skills.load, available: fields.skills.available },
    subagents: fields.subagents,
    ...(draft.permission !== undefined ? { permission: draft.permission } : {}),
    ...toolsOf(draft.tools),
  };
  return { schemaVersion: 1, systemPrompt: draft.body, metadata };
}

/**
 * `tools` is the allow-list, written whenever the file has one (a `*: deny` rule), `[]` included;
 * grants beside no allow-list restrict nothing. `ask` runs as `allow`.
 */
function toolsOf(
  projection: ToolProjection | undefined,
): Pick<NormalizedAgentMetadata, "tools" | "disallowed-tools"> {
  if (!projection) return {};
  return {
    ...(projection.default === "deny" ? { tools: [...projection.allow, ...projection.ask] } : {}),
    ...(projection.deny.length ? { "disallowed-tools": projection.deny } : {}),
  };
}

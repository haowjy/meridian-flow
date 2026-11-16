/**
 * Reads one package's files with Mars and decides which Agents are available. Mars's `check()` is
 * the verdict on the files (`checkFiles`); the findings here are its own, plus the few that only
 * Flow can make: its tool and permission rules, subagents, unreadable files and dependencies.
 *
 * The rule this keeps: a finding of severity `error`, Mars's or Flow's, on an Agent's file makes
 * that Agent unavailable, and an unavailable Agent has no definition for anything to run. A
 * `warning` or `info` doesn't: it is shown (Info only where `shownFindings` lets it through), and the Agent runs as its file reads (a restriction
 * `prepare` dropped, `field.restriction-lost`, is such a warning). Save installs, for an item with
 * an error, the files of its last saved version when that was usable (`save-packages.ts`), and
 * fails only on a broken `mars.toml`; a saved Agent can still be unavailable, because a newer
 * reader finds an error the older one did not, or the item was never saved without one.
 */
import { OPT_IN_TOOLS, type ReasoningLevel, TOOL_CATALOG } from "@meridian/contracts/agents";
import { canonicalizeJsonObject, sha256 } from "./helpers.js";
import {
  type AgentFields,
  agentSlugOf,
  bodyOf,
  type Check,
  checkFiles,
  type Diagnostic,
  GRAMMAR_VERSION,
  MANIFEST_PATH,
  type Prepared,
  projectRules,
  readPackage,
  skillSlugOf,
  type ToolProjection,
} from "./mars.js";
import type { SkillFiles } from "./types.js";

export class AgentSourceError extends Error {}

export interface AgentSourceSnapshot {
  coordinate: string;
  files: SkillFiles;
  /**
   * Package paths a file cannot be read from (a prose document, a stored file, two documents).
   * The path still names its Agent, skill or manifest, which is unavailable for the reason. Not
   * retained: a revision keeps only the files that were read.
   */
  problems?: Record<string, string>;
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
  effort?: ReasoningLevel;
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
  /** The source's unreadable paths; part of what the digest identifies. */
  problems: Record<string, string>;
  agents: CompiledAgent[];
  /** Skills the package holds; one with an `error` is not offered. */
  skills: Array<{ slug: string; diagnostics: PackageDiagnostic[] }>;
  /** Every finding of the package's own files, each once: the manifest's, the Agents' and the skills'. */
  findings: PackageDiagnostic[];
}

export const isError = (item: { severity: string }): boolean => item.severity === "error";

export function compilePackage(
  input: AgentSourceSnapshot,
  grammarVersion: string = GRAMMAR_VERSION,
): CompiledPackage {
  const files = validatedFiles(input);
  const problems = input.problems ?? {};
  const prepared = readPackage(files);
  const verdict = checkFiles(files, Object.keys(problems));
  const manifest = manifestFindings(prepared, verdict, files, problems);
  const packageErrors = manifest.filter(isError);
  const skills = readSkills(prepared, verdict, problems);

  const drafts = new Map<string, Draft>();
  for (const path of [...Object.keys(files), ...Object.keys(problems)].sort()) {
    const slug = agentSlugOf(path);
    if (slug === undefined) continue;
    drafts.set(
      slug,
      Object.hasOwn(problems, path)
        ? problemAgent(slug, path, [
            ...packageErrors,
            flow(path, "file-unreadable", problems[path]),
          ])
        : draftAgent(slug, path, prepared, verdict, packageErrors, skills),
    );
  }
  rejectBrokenSubagents(drafts);

  const agents = [...drafts.values()].map((draft) => ({
    slug: draft.slug,
    name: draft.fields?.name ?? draft.slug,
    description: draft.fields?.description ?? "",
    diagnostics: [...draft.errors, ...draft.warnings],
    definition: draft.errors.length === 0 ? definitionOf(draft) : null,
  }));
  return {
    coordinate: input.coordinate,
    grammarVersion,
    contentDigest: sourceDigest(input),
    files,
    problems,
    skills: [...skills].map(([slug, diagnostics]) => ({ slug, diagnostics })),
    agents,
    findings: distinct([
      ...manifest,
      ...agents.flatMap((agent) => agent.diagnostics),
      ...[...skills.values()].flat(),
      // What Mars says of a folder, such as a skill folder with no SKILL.md, belongs to no item.
      ...Object.keys(verdict.diagnostics).flatMap((file) => foundIn(verdict, file)),
    ]),
  };
}

function distinct(items: PackageDiagnostic[]): PackageDiagnostic[] {
  const seen = new Map<string, PackageDiagnostic>();
  for (const item of items) {
    seen.set(JSON.stringify([item.file, item.code, item.path, item.message]), item);
  }
  return [...seen.values()];
}

/** What identifies a source: its coordinate, files and problems, in canonical form. */
export function sourceDigest(input: AgentSourceSnapshot): string {
  const problems = input.problems ?? {};
  return sha256(
    JSON.stringify(
      canonicalizeJsonObject({
        kind: "meridian.agent-source",
        coordinate: input.coordinate,
        files: input.files,
        ...(Object.keys(problems).length ? { problems } : {}),
      }),
    ),
  );
}

/** Whether a package-relative path can name a file of a package. */
export function isPackagePath(name: string): boolean {
  return !(
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    name.includes("\\") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  );
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
    if (!isPackagePath(name)) {
      throw new AgentSourceError(`Invalid Agent source file path: ${name}`);
    }
    if (
      typeof text !== "string" ||
      text.includes("\0") ||
      Buffer.from(text).toString("utf8") !== text
    ) {
      throw new AgentSourceError(
        `Agent source ${name} isn't plain text: it holds a NUL byte or isn't valid UTF-8`,
      );
    }
  }
  return input.files;
}

/** Keys of an Agent file whose retirement means the Agent is no longer limited by them. */
const RESTRICTING_KEYS = new Set(["permission", "disallowed-tools"]);

/** A warning that an Agent may run wider than its file reads: the writer sees these first. */
export const losesRestriction = (item: PackageDiagnostic): boolean =>
  item.code === "flow.tools-ask" ||
  item.code === "field.restriction-lost" ||
  (item.code === "field.retired" && RESTRICTING_KEYS.has(String(item.path[0])));

const quoted = (message: string, pattern: RegExp) => pattern.exec(message)?.slice(1);

/**
 * Flow grades some of Mars's findings differently and writes its own message for the grade:
 * - `definition.duplicate-name`, an error in Mars: two Agents, or two skills, of one name both
 *   work here (a ref names a skill by its folder, the picker tells Agents apart by file). Mars
 *   compares names case-sensitively, and so does this;
 * - `field.retired` says, for a restricting key, that the Agent is not limited by it.
 * Mars gives the duplicate name no structured parts but the path, so the names come out of its message.
 */
const fromMars = (file: string, diagnostic: Diagnostic): PackageDiagnostic => {
  const base = {
    file,
    code: diagnostic.code,
    severity: diagnostic.severity,
    path: diagnostic.path,
    message: diagnostic.message,
  };
  switch (diagnostic.code) {
    case "definition.duplicate-name": {
      const [name, other] =
        quoted(diagnostic.message, /name `([^`]+)` is also the name of `([^`]+)`/) ?? [];
      return {
        ...base,
        severity: "warning",
        message:
          name && other
            ? `\`${file}\` and \`${other}\` are both named \`${name}\`; both work here`
            : "Another file of this package has this name; both work here",
      };
    }
    case "field.retired": {
      const key = String(diagnostic.path[0] ?? "");
      return RESTRICTING_KEYS.has(key)
        ? { ...base, message: `\`${key}\` is no longer read, so this Agent is not limited by it.` }
        : base;
    }
    default:
      return base;
  }
};
const flow = (
  file: string,
  code: string,
  message: string,
  severity: "error" | "warning" = "error",
  path: (string | number)[] = [],
): PackageDiagnostic => ({ file, code: `flow.${code}`, severity, path, message });

/** Mars's findings on one file of the package, in Mars's order, Info included. */
const foundIn = (verdict: Check, file: string): PackageDiagnostic[] =>
  (verdict.diagnostics[file] ?? []).map((item) => fromMars(file, item));

/**
 * Findings on `mars.toml`; its errors make every Agent of the package unavailable. `prepare`
 * upgrades a pre-v1 package and translates a foreign one in memory, and says so only in its
 * classification: Flow reads a package as authored, so anything but schema 1 is an error. A
 * dependency Mars says it lacks or can't read fails the package the same way: Flow vendors none
 * yet, so the ref check has no verdict.
 */
function manifestFindings(
  prepared: Prepared,
  verdict: Check,
  files: SkillFiles,
  problems: Record<string, string>,
): PackageDiagnostic[] {
  if (Object.hasOwn(problems, MANIFEST_PATH)) {
    return [flow(MANIFEST_PATH, "file-unreadable", problems[MANIFEST_PATH])];
  }
  if (files[MANIFEST_PATH] === undefined) {
    return [flow(MANIFEST_PATH, "manifest-missing", "The package has no mars.toml")];
  }
  const findings = foundIn(verdict, MANIFEST_PATH);
  for (const { name } of verdict.missing_dependencies) {
    findings.push(
      flow(
        MANIFEST_PATH,
        "dependency-missing",
        `Dependency "${name}" isn't in this package, and Flow can't fetch it`,
        "error",
        ["dependencies", name],
      ),
    );
  }
  // Fires only once imports pass dependencies to `checkFiles`; until then Mars has none to list.
  for (const { name } of verdict.unreadable_dependencies) {
    findings.push(
      flow(MANIFEST_PATH, "dependency-unreadable", `Dependency "${name}" can't be read`, "error", [
        "dependencies",
        name,
      ]),
    );
  }
  const { classification } = prepared;
  // TOML that doesn't parse has no schema to read; its error is the whole story.
  if (
    classification.kind !== "schema-1" &&
    !findings.some((item) => item.code === "toml.invalid")
  ) {
    const schema = classification.kind === "schema-newer" ? ` ${classification.schema}` : "";
    findings.push(
      flow(
        MANIFEST_PATH,
        "package-not-schema-1",
        `Mars reads this package as ${classification.kind}${schema}, not schema 1; Flow reads only schema 1 packages as written`,
      ),
    );
  }
  return findings;
}

/** The package's skills by slug, with every finding on each. */
function readSkills(
  prepared: Prepared,
  verdict: Check,
  problems: Record<string, string>,
): Map<string, PackageDiagnostic[]> {
  const skills = new Map<string, PackageDiagnostic[]>();
  for (const [path, message] of Object.entries(problems)) {
    const slug = skillSlugOf(path);
    if (slug !== undefined) skills.set(slug, [flow(path, "file-unreadable", message)]);
  }
  for (const definition of prepared.definitions) {
    if (definition.kind !== "skill") continue;
    skills.set(definition.slug, foundIn(verdict, definition.source_path));
  }
  return skills;
}

interface Draft {
  slug: string;
  file: string;
  fields: AgentFields | null;
  body: string;
  /** Blocking: findings of severity `error`, Mars's and Flow's. */
  errors: PackageDiagnostic[];
  /** Never blocking: warnings and info. */
  warnings: PackageDiagnostic[];
  permission: "read" | "edit" | undefined;
  tools: ToolProjection | undefined;
  /** Tools off by default that the file turns on (`OPT_IN_TOOLS`). */
  optIn: Set<string>;
}

/** An Agent path whose file cannot be read: the Agent is in the package, unavailable for `errors`. */
function problemAgent(slug: string, file: string, errors: PackageDiagnostic[]): Draft {
  return {
    slug,
    file,
    fields: null,
    body: "",
    errors,
    warnings: [],
    permission: undefined,
    tools: undefined,
    optIn: new Set(),
  };
}

function draftAgent(
  slug: string,
  file: string,
  prepared: Prepared,
  verdict: Check,
  packageErrors: PackageDiagnostic[],
  skills: Map<string, PackageDiagnostic[]>,
): Draft {
  const definition = prepared.definitions.find((item) => item.source_path === file);
  if (definition?.kind !== "agent") {
    // Mars reads no file of a package whose mars.toml has an Error; that Error says why.
    return problemAgent(
      slug,
      file,
      packageErrors.length
        ? packageErrors
        : [flow(file, "file-unreadable", "Mars did not read this file as an Agent")],
    );
  }
  const { reading } = definition;
  const draft: Draft = {
    slug,
    file,
    fields: reading.fields,
    body: bodyOf(reading),
    errors: [...packageErrors],
    warnings: [],
    permission: undefined,
    tools: undefined,
    optIn: new Set(),
  };
  for (const item of foundIn(verdict, file)) {
    (isError(item) ? draft.errors : draft.warnings).push(item);
  }
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
    if (skill?.some(isError)) {
      draft.errors.push(
        flow(
          file,
          "skill-unavailable",
          `Skill "${name}" has a problem: ${skill.find(isError)?.message}`,
        ),
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
  // Mars's vocabulary has no name for a tool that is off by default; Flow reads those rules.
  const isOptIn = (rule: AgentFields["tools"][number]) =>
    (OPT_IN_TOOLS as readonly string[]).includes(rule.capability);
  rules.forEach((rule, index) => {
    if (!isOptIn(rule)) return;
    if (rule.pattern !== null) {
      draft.errors.push(
        flow(
          file,
          "tools-unscopable",
          `Tool rule ${rule.capability}(${rule.pattern}) takes no pattern`,
          "error",
          ["tools", index],
        ),
      );
    } else if (rule.action === "deny") draft.optIn.delete(rule.capability);
    else draft.optIn.add(rule.capability);
  });
  // Mars sees only the rules left after the opt-in ones; its findings name them by position there.
  const sent = rules.flatMap((rule, index) => (isOptIn(rule) ? [] : [{ rule, index }]));
  const projection = projectRules(
    sent.map((item) => item.rule),
    "meridian-flow",
  );
  projection.rules.forEach((projected, position) => {
    const { capability, pattern, action } = projected.rule;
    const named = `${capability}${pattern === null ? "" : `(${pattern})`}: ${action}`;
    const message = `Tool rule ${named}: ${projected.note ?? projected.status}`;
    const at = ["tools", sent[position].index];
    if (projected.status === "unscopable" || projected.status === "unknown")
      draft.errors.push(flow(file, `tools-${projected.status}`, message, "error", at));
    // A rule Mars knows but Flow can only meet more narrowly (an `mcp` rule for one server) says so.
    else if (projected.status === "known" && projected.note)
      draft.warnings.push(flow(file, "tools-narrowed", message, "warning", at));
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
  // `auto` and a missing key are the model's own default: nothing is stored.
  const effort = fields.effort === "auto" ? null : fields.effort;
  const metadata: NormalizedAgentMetadata = {
    ...(fields.name !== null ? { name: fields.name } : {}),
    ...(fields.description !== null ? { description: fields.description } : {}),
    ...(fields.model !== null ? { model: fields.model } : {}),
    ...(fields.mode !== null ? { mode: fields.mode } : {}),
    "model-invocable": fields["model-invocable"],
    "user-invocable": fields["user-invocable"],
    ...(effort !== null ? { effort } : {}),
    skills: { load: fields.skills.load, available: fields.skills.available },
    subagents: fields.subagents,
    ...(draft.permission !== undefined ? { permission: draft.permission } : {}),
    ...toolsOf(draft.tools, draft.optIn),
  };
  return { schemaVersion: 1, systemPrompt: draft.body, metadata };
}

/**
 * `tools` is the allow-list, written whenever the file has one (a `*: deny` rule), `[]` included;
 * grants beside no allow-list restrict nothing. `ask` runs as `allow`.
 */
function toolsOf(
  projection: ToolProjection | undefined,
  optIn: ReadonlySet<string>,
): Pick<NormalizedAgentMetadata, "tools" | "disallowed-tools"> {
  if (!projection) return {};
  const on = [...optIn];
  // An opt-in tool beside no allow-list must not turn the file's default (every tool) into just it.
  const published = new Set<string>(TOOL_CATALOG);
  const tools =
    projection.default === "deny"
      ? [...[...projection.allow, ...projection.ask].filter((name) => published.has(name)), ...on]
      : on.length
        ? [...TOOL_CATALOG, ...on]
        : undefined;
  return {
    ...(tools ? { tools } : {}),
    ...(projection.deny.length ? { "disallowed-tools": projection.deny } : {}),
  };
}

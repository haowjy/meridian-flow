/**
 * Skill files under `skills://` (D52): the read-only folders of the skills an
 * agent's own binding offers it, and of the skills its user invoked in the
 * thread (D64). `skills://` is model-facing only; it is not a context scheme,
 * so the writer's file tree, catalog and routes never see it.
 *
 * `skills://<skill>/<path>` names a file in the skill's package folder. A
 * skill name is unique within a thread: binding resolution refuses one two
 * packages share, and a bound name wins over an invoked one, so no source id
 * is written. Every lookup reads the thread's binding once and asks the pure
 * `skillLevel`; a skill the agent may not see reads as missing.
 */
import { posix } from "node:path";
import type { RetainedSkillReference } from "@meridian/contracts/agents";
import { skillLevel } from "../../file-policy/index.js";
import type { AgentRevisionStore } from "../../packages/index.js";
import { readThreadSkills } from "./available-skills.js";

export const SKILLS_URI_ROOT = "skills://";

export interface SkillFilesDeps {
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}

/** A parsed `skills://` address: the root, or a path inside one skill's folder. */
type SkillUri = { skill: null } | { skill: string; path: string };

type SkillFileRead =
  | { kind: "text"; skill: string; path: string; text: string }
  | { kind: "binary" }
  | { kind: "not_found" };

export interface SkillListEntry {
  uri: string;
  kind: "file" | "directory";
  readonly: true;
  /** Set on a file `read` returns no text for. */
  fileType?: "binary";
}

/** A `skills://` folder's URI and entries, shaped like an `ls` result. */
export interface SkillListing {
  uri: string;
  entries: SkillListEntry[];
}

/**
 * The header over a skill file's text: its address, and the folder its
 * relative paths start from. Shared by `read`, `skill`, and preloaded or
 * activated bodies the model can read (D58).
 */
export function skillFileHeader(skill: string, path: string): string {
  const folder = `${SKILLS_URI_ROOT}${skill}/`;
  return `${folder}${path}\nPaths in this skill are relative to ${folder}.`;
}

/** A skill file's text as `read` and `skill` return it, under its header. */
export function renderSkillFile(skill: string, path: string, text: string): string {
  return `${skillFileHeader(skill, path)}\n\n${text}`;
}

export function isSkillsUri(path: string): boolean {
  return path.trim().startsWith(SKILLS_URI_ROOT);
}

/**
 * Normalizes `skills://…`. Null for a path that leaves its skill's folder, so
 * the caller answers not found.
 */
function parseSkillUri(uri: string): SkillUri | null {
  const rest = uri.trim().slice(SKILLS_URI_ROOT.length);
  const segments = rest.split("/").filter((segment) => segment !== "" && segment !== ".");
  const [skill, ...path] = segments;
  if (!skill) return { skill: null };
  if (skill === ".." || rest.includes("\\")) return null;
  const relative = posix.normalize(path.join("/") || ".");
  if (relative === ".." || relative.startsWith("../")) return null;
  return { skill, path: relative === "." ? "" : relative };
}

/** One file's text, or why there is none. A folder or missing file is not found. */
export async function readSkillFile(
  deps: SkillFilesDeps,
  threadId: string,
  uri: string,
): Promise<SkillFileRead> {
  const parsed = parseSkillUri(uri);
  if (!parsed?.skill || !parsed.path) return { kind: "not_found" };
  return readVisibleFile(deps, threadId, parsed.skill, parsed.path);
}

/**
 * A visible skill's `SKILL.md`, by name. Names are the binding's folder
 * names, so "a/b" or ".." matches none and never reaches another file.
 */
export async function readSkillMd(
  deps: SkillFilesDeps,
  threadId: string,
  name: string,
): Promise<SkillFileRead> {
  return readVisibleFile(deps, threadId, name, "SKILL.md");
}

async function readVisibleFile(
  deps: SkillFilesDeps,
  threadId: string,
  skill: string,
  path: string,
): Promise<SkillFileRead> {
  const folder = await visibleSkillFolder(deps, threadId, skill);
  const entry = folder?.files[`${folder.directory}/${path}`];
  if (entry === undefined) return { kind: "not_found" };
  if (typeof entry !== "string") return { kind: "binary" };
  return { kind: "text", skill, path, text: entry };
}

/**
 * `skills://` lists the visible skills' folders; a folder lists its files and
 * folders, binary files included. A missing or invisible folder lists nothing,
 * as a missing context folder does.
 */
export async function listSkillDir(
  deps: SkillFilesDeps,
  threadId: string,
  uri: string,
): Promise<SkillListing> {
  const parsed = parseSkillUri(uri);
  if (!parsed) return { uri: uri.trim(), entries: [] };
  if (!parsed.skill) {
    const entries = (await visibleSkillNames(deps, threadId)).map((skill) => ({
      uri: `${SKILLS_URI_ROOT}${skill}`,
      kind: "directory" as const,
      readonly: true as const,
    }));
    return { uri: SKILLS_URI_ROOT, entries };
  }
  const base = parsed.path
    ? `${SKILLS_URI_ROOT}${parsed.skill}/${parsed.path}`
    : `${SKILLS_URI_ROOT}${parsed.skill}`;
  const folder = await visibleSkillFolder(deps, threadId, parsed.skill);
  if (!folder) return { uri: base, entries: [] };
  const prefix = parsed.path ? `${folder.directory}/${parsed.path}/` : `${folder.directory}/`;
  const entries = new Map<string, Omit<SkillListEntry, "uri">>();
  for (const [path, file] of Object.entries(folder.files)) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...below] = path.slice(prefix.length).split("/");
    if (!name) continue;
    entries.set(
      name,
      below.length > 0
        ? { kind: "directory", readonly: true }
        : typeof file === "string"
          ? { kind: "file", readonly: true }
          : { kind: "file", readonly: true, fileType: "binary" },
    );
  }
  return {
    uri: base,
    entries: [...entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => ({ uri: `${base}/${name}`, ...entry })),
  };
}

/** The names of the skills this agent may read, sorted. */
export async function visibleSkillNames(deps: SkillFilesDeps, threadId: string): Promise<string[]> {
  return [...(await visibleSkills(deps, threadId)).keys()].sort();
}

/** The skills this agent may read, each with its bound reference. */
async function visibleSkills(
  deps: SkillFilesDeps,
  threadId: string,
): Promise<Map<string, RetainedSkillReference>> {
  const { facts, bound } = await readThreadSkills(deps.agentRevisions, threadId);
  return new Map([...bound].filter(([skill]) => skillLevel(facts, skill) === "read"));
}

async function visibleSkillFolder(
  deps: SkillFilesDeps,
  threadId: string,
  skill: string,
): Promise<{ directory: string; files: Record<string, unknown> } | undefined> {
  const reference = (await visibleSkills(deps, threadId)).get(skill);
  if (!reference) return undefined;
  const source = await deps.agentRevisions.readSource(reference.packageRevisionId);
  if (!source) return undefined;
  return { directory: posix.dirname(reference.path), files: source.files };
}

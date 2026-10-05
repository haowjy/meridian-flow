/**
 * Skill files under `skills://` (D52) and the `skill` tool's load (D58): the
 * read-only folders of the skills an agent's own binding offers it. `skills://` is model-facing only; it is not a
 * context scheme, so the writer's file tree, catalog and routes never see it.
 *
 * `skills://<skill>/<path>` names a file in the skill's package folder. A
 * skill name is unique within a thread, because binding resolution refuses
 * one two packages share, so no source id is written. Every lookup reads the
 * thread's binding once and asks the pure `skillLevel`; a skill the agent may
 * not see reads as missing.
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
export type SkillUri = { skill: null } | { skill: string; path: string };

export type SkillFileRead =
  | { kind: "text"; skill: string; path: string; text: string }
  | { kind: "binary" }
  | { kind: "not_found" };

export interface SkillListEntry {
  uri: string;
  kind: "file" | "directory";
  readonly: true;
}

/** A skill's `SKILL.md` as the model reads it. */
export function skillMdUri(slug: string): string {
  return `${SKILLS_URI_ROOT}${slug}/SKILL.md`;
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

export function isSkillsUri(path: string): boolean {
  return path.trim().startsWith(SKILLS_URI_ROOT);
}

/**
 * Normalizes `skills://…`. Null for a path that leaves its skill's folder, so
 * the caller answers not found.
 */
export function parseSkillUri(uri: string): SkillUri | null {
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
  const folder = await visibleSkillFolder(deps, threadId, parsed.skill);
  const entry = folder?.files[`${folder.directory}/${parsed.path}`];
  if (entry === undefined) return { kind: "not_found" };
  if (typeof entry !== "string") return { kind: "binary" };
  return { kind: "text", skill: parsed.skill, path: parsed.path, text: entry };
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
): Promise<SkillListEntry[]> {
  const parsed = parseSkillUri(uri);
  if (!parsed) return [];
  if (!parsed.skill) {
    return (await visibleSkillNames(deps, threadId)).map((skill) => ({
      uri: `${SKILLS_URI_ROOT}${skill}`,
      kind: "directory",
      readonly: true,
    }));
  }
  const folder = await visibleSkillFolder(deps, threadId, parsed.skill);
  if (!folder) return [];
  const prefix = parsed.path ? `${folder.directory}/${parsed.path}/` : `${folder.directory}/`;
  const base = parsed.path
    ? `${SKILLS_URI_ROOT}${parsed.skill}/${parsed.path}`
    : `${SKILLS_URI_ROOT}${parsed.skill}`;
  const entries = new Map<string, SkillListEntry["kind"]>();
  for (const path of Object.keys(folder.files)) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...below] = path.slice(prefix.length).split("/");
    if (name) entries.set(name, below.length > 0 ? "directory" : "file");
  }
  return [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, kind]) => ({ uri: `${base}/${name}`, kind, readonly: true }));
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

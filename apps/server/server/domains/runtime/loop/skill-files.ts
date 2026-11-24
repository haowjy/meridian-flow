import { posix } from "node:path";
import { documentPathKey, splitDocumentHrefSuffix } from "@meridian/contracts";
import type { RetainedSkillReference } from "@meridian/contracts/agents";
import { type Filetype, parseDocumentFilename } from "@meridian/contracts/protocol";
import { skillLevel } from "../../file-policy/index.js";
import type { AgentRevisionStore } from "../../packages/index.js";
import { readThreadSkills } from "./available-skills.js";

export const SKILLS_URI_ROOT = "skills://";

export interface SkillFilesDeps {
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}

type SkillUri = { skill: null } | { skill: string; path: string };

type SkillFileRead =
  | { kind: "text"; skill: string; path: string; text: string; filetype: Filetype }
  | { kind: "binary" }
  | { kind: "not_found" };

export interface SkillListEntry {
  uri: string;
  kind: "file" | "directory";
  readonly: true;
  fileType?: "binary";
}

export interface SkillListing {
  uri: string;
  entries: SkillListEntry[];
}

export function skillFileHeader(skill: string, path: string): string {
  const folder = `${SKILLS_URI_ROOT}${skill}/`;
  const { path: filename, suffix } = splitDocumentHrefSuffix(path);
  return `${folder}${documentPathKey(filename)}${suffix}\nPaths in this skill are relative to ${folder}.`;
}

export function renderSkillFile(skill: string, path: string, text: string): string {
  return `${skillFileHeader(skill, path)}\n\n${text}`;
}

export function isSkillsUri(path: string): boolean {
  return path.trim().startsWith(SKILLS_URI_ROOT);
}

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

export async function readSkillFile(
  deps: SkillFilesDeps,
  threadId: string,
  uri: string,
): Promise<SkillFileRead> {
  const parsed = parseSkillUri(uri);
  if (!parsed?.skill || !parsed.path) return { kind: "not_found" };
  return readVisibleFile(deps, threadId, parsed.skill, parsed.path);
}

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
  if (!folder) return { kind: "not_found" };
  const exact = folder.files[`${folder.directory}/${path}`];
  if (exact !== undefined && typeof exact !== "string") return { kind: "binary" };
  const wanted = `${folder.directory}/${documentPathKey(path)}`;
  const matches = Object.entries(folder.files).filter(
    ([sourcePath, file]) =>
      (typeof file === "string" ? documentPathKey(sourcePath) : sourcePath) === wanted,
  );
  if (matches.length !== 1 || !matches[0]) return { kind: "not_found" };
  const [sourcePath, entry] = matches[0];
  if (typeof entry !== "string") return { kind: "binary" };
  const filename = parseDocumentFilename(posix.basename(sourcePath));
  return {
    kind: "text",
    skill,
    path: documentPathKey(path),
    text: entry,
    filetype: filename.ok ? filename.value.filetype : "text",
  };
}

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
      below.length === 0 && typeof file === "string" ? documentPathKey(name) : name,
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

export async function visibleSkillNames(deps: SkillFilesDeps, threadId: string): Promise<string[]> {
  return [...(await visibleSkills(deps, threadId)).keys()].sort();
}

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

// @ts-nocheck
/**
 * Skill execution descriptor: package-domain-owned normalization of Mars skill
 * metadata and files into the shape the runtime can execute without knowing
 * Mars frontmatter aliases, file encodings, or uv-project detection rules.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { stringAt } from "./helpers.js";
import { skillFileEntryToBuffer } from "./skill-files.js";
import type { ResolvedSkill } from "./types.js";

const SKILL_ROOT = ".meridian/skills";

export interface SkillExecutionFile {
  relativePath: string;
  bytes: Uint8Array;
}

export interface SkillExecutionDescriptor {
  slug: string;
  description: string;
  skillDir: string;
  contentChecksum: string;
  files: SkillExecutionFile[];
  uvProjectDirs: string[];
  command?: string;
}

function skillDescription(resolved: ResolvedSkill): string {
  const { skill } = resolved;
  return (
    stringAt(skill.meta.description) ??
    stringAt(skill.meta.name) ??
    (skill.body.trim().slice(0, 500) || skill.slug)
  );
}

function normalizeSkillRelativePath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Skill file path escapes skill root: ${relativePath}`);
  }
  return normalized;
}

function skillExecCommand(resolved: ResolvedSkill): string | undefined {
  return (
    stringAt(resolved.skill.meta.command) ??
    stringAt(resolved.skill.meta.exec) ??
    stringAt(resolved.skill.meta.entrypoint)
  );
}

function pairedUvProjectDirs(candidates: Set<string>, files: Set<string>): string[] {
  return [...candidates].filter(
    (dir) =>
      files.has(path.posix.join(dir, "pyproject.toml")) &&
      files.has(path.posix.join(dir, "uv.lock")),
  );
}

function skillExecutionContentChecksum(input: {
  slug: string;
  description: string;
  command?: string;
  files: SkillExecutionFile[];
}): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      slug: input.slug,
      description: input.description,
      command: input.command ?? null,
      files: [...input.files]
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        .map((file) => ({
          relativePath: file.relativePath,
          bytesBase64: Buffer.from(file.bytes).toString("base64"),
        })),
    }),
  );
  return hash.digest("hex");
}

/** Build the package-domain normalized execution descriptor for a resolved skill. */
export function skillExecutionDescriptorFromResolvedSkill(
  resolved: ResolvedSkill,
): SkillExecutionDescriptor {
  const stagedSkillRoot = path.posix.join(SKILL_ROOT, resolved.skill.slug);
  const uvProjectCandidates = new Set<string>();
  const files: SkillExecutionFile[] = [];
  const stagedPaths = new Set<string>();

  for (const [relativePath, entry] of Object.entries(resolved.skill.files)) {
    const safePath = normalizeSkillRelativePath(relativePath);
    const destination = path.posix.join(stagedSkillRoot, safePath);
    files.push({ relativePath: safePath, bytes: skillFileEntryToBuffer(entry) });
    stagedPaths.add(destination);
    const basename = path.posix.basename(safePath);
    if (basename === "pyproject.toml" || basename === "uv.lock") {
      uvProjectCandidates.add(path.posix.dirname(destination));
    }
  }

  const description = skillDescription(resolved);
  const command = skillExecCommand(resolved);
  const contentChecksum = skillExecutionContentChecksum({
    slug: resolved.skill.slug,
    description,
    command,
    files,
  });
  const skillDir = path.posix.join(stagedSkillRoot, contentChecksum);

  return {
    slug: resolved.skill.slug,
    description,
    skillDir,
    contentChecksum,
    files,
    uvProjectDirs: pairedUvProjectDirs(uvProjectCandidates, stagedPaths).map((projectDir) =>
      path.posix.join(skillDir, path.posix.relative(stagedSkillRoot, projectDir)),
    ),
    command,
  };
}

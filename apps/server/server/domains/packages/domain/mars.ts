/**
 * Reads Mars files with `@meridian-flow/mars-schema`. A package is read
 * whole with `prepare` (`readPackage`), which adds the package's `[package.tools]` to each Agent
 * as `mars sync` does; a lone file (a skill, a manifest) is read with `read`. `prepare` never
 * runs with `migrate`, and a package it classes as anything but schema 1 is refused by the
 * caller, because for those `prepare` upgrades or translates in memory.
 */
import {
  type AgentFields,
  type Check,
  check,
  type DefinitionRead,
  type Diagnostic,
  type Effort,
  type ManifestRead,
  type Prepared,
  prepare,
  project,
  read,
  resolveEffort,
  rewriteBlock,
  type SkillFields,
  type ToolProjection,
  version,
} from "@meridian-flow/mars-schema";

export { rewriteBlock };

/** Flow stores max as `xhigh`, which `AGENT_EFFORT_CHOICE` reads back as max. */
const STORED_EFFORT: Record<Effort, "none" | "low" | "medium" | "high" | "xhigh"> = {
  none: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/**
 * An Agent file's `effort` as Flow stores it, read by Mars's rule for the `meridian-flow` host:
 * `minimal` runs at low, `xhigh` at max. `auto` and a missing key store nothing, the model's own
 * default. The model's own levels are applied later, per call, by the gateway.
 */
export function storedAgentEffort(effort: AgentFields["effort"]) {
  const { level } = resolveEffort(effort, null, "meridian-flow");
  return level === null ? undefined : STORED_EFFORT[level];
}

/**
 * The reader that produced a stored definition row. Whoever changes the availability table or
 * the tool projection in `compile-package.ts` bumps `flow-N` in the same commit: the version is
 * part of a revision's key, and without a bump the same bytes are never read twice, so the
 * change never reaches a stored Agent.
 */
export const GRAMMAR_VERSION = `mars-${version()}+flow-10`;

const AGENT_PATH = /^agents\/([^/]+)\.md$/;
const SKILL_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

export const MANIFEST_PATH = "mars.toml";
export const agentPath = (slug: string): `agents/${string}.md` => `agents/${slug}.md`;
export const skillPath = (slug: string): `skills/${string}/SKILL.md` => `skills/${slug}/SKILL.md`;
export const agentSlugOf = (path: string): string | undefined => AGENT_PATH.exec(path)?.[1];
export const skillSlugOf = (path: string): string | undefined => SKILL_PATH.exec(path)?.[1];

export type { AgentFields, Check, Diagnostic, Prepared, SkillFields, ToolProjection };
export { project as projectRules };

const encoder = new TextEncoder();
const treeOf = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]));
export const readPackage = (files: Record<string, string>): Prepared =>
  prepare({ files: treeOf(files), context: "package" });
/**
 * Mars's verdict on a package's files. No dependency is passed because Flow vendors none yet: a
 * package that declares one comes back with it in `missing_dependencies`. Flow couldn't read the
 * `unreadable` paths, so each goes to Mars as an empty file, which keeps Mars's rules about what
 * the package holds true (a skill ref to it resolves, its folder has a `SKILL.md`), and Mars's
 * findings on those stand-ins are dropped: Flow alone speaks of a file it couldn't read. A stand-in
 * is not right about its name (Mars names it after its path), so a duplicate name against one is
 * dropped too.
 */
export const checkFiles = (files: Record<string, string>, unreadable: string[]): Check => {
  const verdict = check({
    files: treeOf({ ...files, ...Object.fromEntries(unreadable.map((path) => [path, ""])) }),
    context: "package",
    dependencies: {},
  });
  for (const path of unreadable) delete verdict.diagnostics[path];
  const names = unreadable.map((path) => `\`${path}\``);
  for (const [path, found] of Object.entries(verdict.diagnostics)) {
    verdict.diagnostics[path] = found.filter(
      (item) =>
        item.code !== "definition.duplicate-name" ||
        !names.some((name) => item.message.includes(name)),
    );
  }
  return verdict;
};

export const readManifest = (text: string): ManifestRead => read(MANIFEST_PATH, text);
export const readAgent = (slug: string, text: string): DefinitionRead<AgentFields> =>
  read(agentPath(slug), text);
export const readSkill = (slug: string, text: string): DefinitionRead<SkillFields> =>
  read(skillPath(slug), text);

/** Mars keeps the blank line after the closing fence; a prompt starts at the line after it. */
export const bodyOf = (reading: { body: string | null }): string =>
  (reading.body ?? "").replace(/^\r?\n/, "");

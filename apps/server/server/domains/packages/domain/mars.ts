/**
 * The only module in the server that imports `@meridian-flow/mars-schema`. A package is read
 * whole with `prepare` (`readPackage`), which adds the package's `[package.tools]` to each Agent
 * as `mars sync` does; a lone file (a skill, a manifest) is read with `read`. `prepare` never
 * runs with `migrate`, and a package it classes as anything but schema 1 is refused by the
 * caller, because for those `prepare` upgrades or translates in memory.
 */
import {
  type AgentFields,
  type DefinitionRead,
  type Diagnostic,
  type ManifestRead,
  type Prepared,
  prepare,
  project,
  read,
  rewriteBlock,
  type SkillFields,
  type ToolProjection,
  version,
} from "@meridian-flow/mars-schema";

export { rewriteBlock };

/**
 * The reader that produced a stored definition row. Whoever changes the availability table or
 * the tool projection in `compile-package.ts` bumps `flow-N` in the same commit: the version is
 * part of a revision's key, and without a bump the same bytes are never read twice, so the
 * change never reaches a stored Agent.
 */
export const GRAMMAR_VERSION = `mars-${version()}+flow-4`;

const AGENT_PATH = /^agents\/([^/]+)\.md$/;
const SKILL_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

export const MANIFEST_PATH = "mars.toml";
export const agentPath = (slug: string): `agents/${string}.md` => `agents/${slug}.md`;
export const skillPath = (slug: string): `skills/${string}/SKILL.md` => `skills/${slug}/SKILL.md`;
export const agentSlugOf = (path: string): string | undefined => AGENT_PATH.exec(path)?.[1];
export const skillSlugOf = (path: string): string | undefined => SKILL_PATH.exec(path)?.[1];

export type { AgentFields, Diagnostic, Prepared, SkillFields, ToolProjection };
export { project as projectRules };

const encoder = new TextEncoder();
export const readPackage = (files: Record<string, string>): Prepared =>
  prepare({
    files: new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)])),
    context: "package",
  });

export const readManifest = (text: string): ManifestRead => read(MANIFEST_PATH, text);
export const readAgent = (slug: string, text: string): DefinitionRead<AgentFields> =>
  read(agentPath(slug), text);
export const readSkill = (slug: string, text: string): DefinitionRead<SkillFields> =>
  read(skillPath(slug), text);

/** Mars keeps the blank line after the closing fence; a prompt starts at the line after it. */
export const bodyOf = (reading: { body: string | null }): string =>
  (reading.body ?? "").replace(/^\r?\n/, "");

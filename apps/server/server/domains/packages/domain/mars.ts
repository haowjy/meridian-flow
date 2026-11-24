import {
  type AgentFields,
  type Check,
  check,
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

export const GRAMMAR_VERSION = `mars-${version()}+flow-11`;

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

export const bodyOf = (reading: { body: string | null }): string =>
  (reading.body ?? "").replace(/^\r?\n/, "");

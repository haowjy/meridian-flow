import {
  DEFAULT_AGENT_PERMISSION,
  type ResolvedAgentConfiguration,
  type RetainedSkillReference,
} from "@meridian/contracts/agents";
import type { AgentRevision, AgentRevisionStore } from "../ports/agent-revision-store.js";
import { isError } from "./compile-package.js";
import { canonicalizeJsonObject, sha256 } from "./helpers.js";
import { readSkill, skillPath, skillSlugOf } from "./mars.js";
import type { SkillFiles } from "./types.js";

export class AgentConfigurationError extends Error {}

export function skillReference(
  packageRevisionId: string,
  files: SkillFiles,
  slug: string,
): RetainedSkillReference {
  const prefix = `skills/${slug}/`;
  return {
    packageRevisionId,
    path: skillPath(slug),
    contentDigest: sha256(
      JSON.stringify(
        canonicalizeJsonObject(
          Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(prefix))),
        ),
      ),
    ),
  };
}

export async function retainedPackageSkillMaps(
  packageRevisionId: string,
  store: Pick<AgentRevisionStore, "readSource">,
): Promise<Map<string, Map<string, RetainedSkillReference>>> {
  const source = await store.readSource(packageRevisionId);
  if (!source) throw new AgentConfigurationError("A retained package source is missing.");
  const skills = new Map<string, RetainedSkillReference>();
  for (const path of Object.keys(source.files).sort()) {
    const slug = skillSlugOf(path);
    if (slug === undefined || readSkill(slug, source.files[path]).diagnostics.some(isError))
      continue;
    skills.set(slug, skillReference(packageRevisionId, source.files, slug));
  }
  return new Map([[packageRevisionId, skills]]);
}

export async function resolveAgentConfiguration(input: {
  revision: AgentRevision;
  store: Pick<AgentRevisionStore, "readSource" | "readPackageDefinitions">;
  modelFor(named?: string): string | undefined;
}): Promise<ResolvedAgentConfiguration> {
  const { revision, store } = input;
  const named = revision.definition.metadata.model;
  const model = input.modelFor(named);
  if (!model) throw new AgentConfigurationError("No configured default model is available.");

  return { model, ...(await resolveAgentDependencies({ revision, store })) };
}

export interface RetainedSkillResolver {
  resolve(reference: string): RetainedSkillReference;
}

export async function buildRetainedSkillResolver(input: {
  packageRevisionId: string;
  store: Pick<AgentRevisionStore, "readSource">;
}): Promise<RetainedSkillResolver> {
  const skills = (await retainedPackageSkillMaps(input.packageRevisionId, input.store)).get(
    input.packageRevisionId,
  );
  return {
    resolve(reference) {
      const skill = skills?.get(reference);
      if (!skill) {
        throw new AgentConfigurationError(`Skill "${reference}" is missing in the package.`);
      }
      return skill;
    },
  };
}

export async function resolveAgentDependencies(input: {
  revision: AgentRevision;
  store: Pick<AgentRevisionStore, "readSource" | "readPackageDefinitions">;
}): Promise<Omit<ResolvedAgentConfiguration, "model">> {
  const { revision, store } = input;
  const source = await store.readSource(revision.packageRevisionId);
  if (!source) throw new AgentConfigurationError("A retained package source is missing.");
  const siblings = await store.readPackageDefinitions(
    revision.packageRevisionId,
    revision.grammarVersion,
  );
  const resolveSkill = (slug: string): RetainedSkillReference => {
    if (!Object.hasOwn(source.files, skillPath(slug))) {
      throw new AgentConfigurationError(`Skill "${slug}" is missing in the package.`);
    }
    return skillReference(revision.packageRevisionId, source.files, slug);
  };
  const meta = revision.definition.metadata;
  return {
    skills: {
      load: (meta.skills?.load ?? []).map(resolveSkill),
      available: (meta.skills?.available ?? []).map(resolveSkill),
    },
    namedTargets: (meta.subagents ?? []).map((name) => {
      const target = siblings.find((agent) => agent.slug === name);
      if (!target) throw new AgentConfigurationError(`Agent "${name}" is missing in the package.`);
      return { name, definitionRevisionId: target.id };
    }),
    ...(meta.tools !== undefined ? { tools: meta.tools } : {}),
    ...(meta["disallowed-tools"] !== undefined
      ? { "disallowed-tools": meta["disallowed-tools"] }
      : {}),
    ...(meta.effort !== undefined ? { effort: meta.effort } : {}),
    permission: meta.permission ?? DEFAULT_AGENT_PERMISSION,
  };
}

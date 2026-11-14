/** Resolve conversation-owned execution values from retained source, never live package records. */
import {
  DEFAULT_AGENT_PERMISSION,
  type ResolvedAgentConfiguration,
  type RetainedSkillReference,
} from "@meridian/contracts/agents";
import type { AgentRevision, AgentRevisionStore } from "../ports/agent-revision-store.js";
import { canonicalizeJsonObject, sha256 } from "./helpers.js";
import { readSkill, skillPath, skillSlugOf } from "./mars.js";
import type { SkillFiles } from "./skill-files.js";

export class AgentConfigurationError extends Error {}

function skillReference(
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

/**
 * The skills a file set offers now, by package revision. Read with the running reader: the
 * question is about now, so a skill with a diagnostic is not offered.
 */
export async function retainedPackageSkillMaps(
  packageRevisionId: string,
  store: Pick<AgentRevisionStore, "readSource">,
): Promise<Map<string, Map<string, RetainedSkillReference>>> {
  const source = await store.readSource(packageRevisionId);
  if (!source) throw new AgentConfigurationError("A retained package source is missing.");
  const skills = new Map<string, RetainedSkillReference>();
  for (const path of Object.keys(source.files).sort()) {
    const slug = skillSlugOf(path);
    if (slug === undefined || readSkill(slug, source.files[path]).diagnostics.length) continue;
    skills.set(slug, skillReference(packageRevisionId, source.files, slug));
  }
  return new Map([[packageRevisionId, skills]]);
}

export async function resolveAgentConfiguration(input: {
  revision: AgentRevision;
  store: Pick<AgentRevisionStore, "readSource" | "readPackageDefinitions">;
  defaultModel: string | undefined;
}): Promise<ResolvedAgentConfiguration> {
  const { revision, store } = input;
  const model = revision.definition.metadata.model ?? input.defaultModel;
  if (!model) throw new AgentConfigurationError("No configured default model is available.");

  return { model, ...(await resolveAgentDependencies({ revision, store })) };
}

export interface RetainedSkillResolver {
  resolve(reference: string): RetainedSkillReference;
}

/** Resolves skill names against the skills one file set offers now. */
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

/**
 * Turns an available revision's names into references, by path alone. The reader's verdict was
 * made once, when the file set was compiled, and is not made again for a revision that is
 * already bound: so this does not read a file with Mars and cannot fail for an available one,
 * including for a chat bound before a reader bump.
 */
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

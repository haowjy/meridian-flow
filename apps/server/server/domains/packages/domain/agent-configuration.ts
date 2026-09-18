/** Resolve conversation-owned execution values from retained source, never live package records. */
import type {
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import type { AgentRevision, AgentRevisionStore } from "../ports/agent-revision-store.js";
import { sha256 } from "./helpers.js";
import { canonicalizeJsonObject } from "./mars-source.js";

export class AgentConfigurationError extends Error {}

const SKILL_MD_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

/** Per-package `skills/<slug>/SKILL.md` maps for the retained dependency graph, root first. */
export async function retainedPackageSkillMaps(
  packageRevisionId: string,
  store: Pick<AgentRevisionStore, "readSource">,
): Promise<Map<string, Map<string, RetainedSkillReference>>> {
  const packages = new Map<string, Map<string, RetainedSkillReference>>();
  async function visit(id: string): Promise<void> {
    if (packages.has(id)) return;
    const source = await store.readSource(id);
    if (!source) throw new AgentConfigurationError("A retained dependency source is missing.");
    const skills = new Map<string, RetainedSkillReference>();
    for (const path of Object.keys(source.files).sort()) {
      const match = SKILL_MD_PATH.exec(path);
      if (!match) continue;
      const slug = match[1];
      if (!slug) continue;
      const prefix = `skills/${slug}/`;
      const files = Object.fromEntries(
        Object.entries(source.files).filter(([name]) => name.startsWith(prefix)),
      );
      skills.set(slug, {
        packageRevisionId: id,
        path,
        contentDigest: sha256(JSON.stringify(canonicalizeJsonObject(files))),
      });
    }
    packages.set(id, skills);
    for (const dependency of Object.values(source.dependencies ?? {})) await visit(dependency);
  }
  await visit(packageRevisionId);
  return packages;
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

/** Publication validates retained references without choosing a conversation's model default. */
export async function resolveAgentDependencies(input: {
  revision: AgentRevision;
  store: Pick<AgentRevisionStore, "readSource" | "readPackageDefinitions">;
}): Promise<Omit<ResolvedAgentConfiguration, "model">> {
  const { revision, store } = input;
  const skillMaps = await retainedPackageSkillMaps(revision.packageRevisionId, store);
  const packages = new Map<
    string,
    {
      skills: Map<string, RetainedSkillReference>;
      agents: AgentRevision[];
    }
  >();
  for (const [id, skills] of skillMaps) {
    packages.set(id, { skills, agents: await store.readPackageDefinitions(id) });
  }

  function unique<T>(reference: string, kind: string, candidates: T[]): T {
    if (candidates.length !== 1) {
      throw new AgentConfigurationError(
        `${kind} "${reference}" is ${candidates.length ? "ambiguous" : "missing"} in the retained package dependencies.`,
      );
    }
    return candidates[0];
  }
  const resolveSkill = (reference: string): RetainedSkillReference =>
    unique(
      reference,
      "Skill",
      [...packages.values()].flatMap((pkg) => {
        const skill = pkg.skills.get(reference);
        return skill ? [skill] : [];
      }),
    );
  const meta = revision.definition.metadata;
  return {
    skills: {
      load: (meta.skills?.load ?? []).map(resolveSkill),
      available: (meta.skills && "available" in meta.skills
        ? (meta.skills.available ?? [])
        : []
      ).map(resolveSkill),
    },
    namedTargets: (meta.subagents ?? []).map((name) => {
      const target = unique(
        name,
        "Agent",
        [...packages.values()].flatMap((pkg) => pkg.agents.filter((agent) => agent.slug === name)),
      );
      // Child-invocability is model-invocable: false only. A pickable primary may also be a named spawn target.
      if (target.definition.metadata["model-invocable"] === false) {
        throw new AgentConfigurationError(`Agent "${name}" cannot be invoked as a child.`);
      }
      return { name, definitionRevisionId: target.id };
    }),
    ...(meta.tools !== undefined ? { tools: meta.tools } : {}),
    ...(meta["disallowed-tools"] !== undefined
      ? { "disallowed-tools": meta["disallowed-tools"] }
      : {}),
    ...(meta.effort !== undefined ? { effort: meta.effort } : {}),
  };
}

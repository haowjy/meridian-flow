/** Resolve conversation-owned execution values from retained source, never live package records. */
import type {
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import type { AgentRevision, AgentRevisionStore } from "../ports/agent-revision-store.js";
import { sha256 } from "./helpers.js";
import { canonicalizeJsonObject } from "./mars-source.js";

export class AgentConfigurationError extends Error {}

export async function resolveAgentConfiguration(input: {
  revision: AgentRevision;
  store: Pick<AgentRevisionStore, "readSource" | "readPackageDefinitions">;
  defaultModel: string | undefined;
}): Promise<ResolvedAgentConfiguration> {
  const { revision, store } = input;
  const model = revision.definition.metadata.model ?? input.defaultModel;
  if (!model) throw new AgentConfigurationError("No configured default model is available.");

  const packages = new Map<
    string,
    {
      skills: Map<string, RetainedSkillReference>;
      agents: AgentRevision[];
    }
  >();
  async function visit(id: string): Promise<void> {
    if (packages.has(id)) return;
    const source = await store.readSource(id);
    if (!source) throw new AgentConfigurationError("A retained dependency source is missing.");
    const skills = new Map<string, RetainedSkillReference>();
    for (const path of Object.keys(source.files).sort()) {
      const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
      if (!match) continue;
      const prefix = `skills/${match[1]}/`;
      const files = Object.fromEntries(
        Object.entries(source.files).filter(([name]) => name.startsWith(prefix)),
      );
      skills.set(match[1], {
        packageRevisionId: id,
        path,
        contentDigest: sha256(JSON.stringify(canonicalizeJsonObject(files))),
      });
    }
    packages.set(id, { skills, agents: await store.readPackageDefinitions(id) });
    for (const dependency of Object.values(source.dependencies ?? {})) await visit(dependency);
  }
  await visit(revision.packageRevisionId);

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
    model,
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
      if (
        target.definition.metadata.mode === "primary" ||
        target.definition.metadata["model-invocable"] === false
      ) {
        throw new AgentConfigurationError(`Agent "${name}" cannot be invoked as a child.`);
      }
      return { name, definitionRevisionId: target.id };
    }),
  };
}

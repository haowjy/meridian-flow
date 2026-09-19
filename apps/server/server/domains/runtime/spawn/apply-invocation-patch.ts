/** Applies a presence-sensitive per-invocation patch to a fully-resolved baseline configuration. */
import type {
  InvocationPatch,
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import {
  AgentConfigurationError,
  type AgentRevisionStore,
  buildRetainedSkillResolver,
  type RetainedSkillResolver,
} from "../../packages/index.js";

/** Unresolvable patch reference (skill name or caller roster name). */
export class InvocationPatchError extends Error {}

export interface ApplyInvocationPatchInput {
  baseline: ResolvedAgentConfiguration;
  patch: InvocationPatch;
  caller: ResolvedAgentConfiguration;
  store: Pick<AgentRevisionStore, "readSource">;
  /**
   * Retained graph root used to resolve newly-added skill names. Null for an
   * agent-less child whose caller has no retained package; skill patching then
   * fails with {@link InvocationPatchError} only when new names are requested.
   */
  packageRevisionId: string | null;
}

export async function applyInvocationPatch(
  input: ApplyInvocationPatchInput,
): Promise<ResolvedAgentConfiguration> {
  const { baseline, patch, caller } = input;

  const result: ResolvedAgentConfiguration = {
    model: patch.model !== undefined ? patch.model : baseline.model,
    skills: await patchSkills(input),
    namedTargets: patchSubagents(baseline, patch, caller),
  };
  if (baseline.tools !== undefined) result.tools = baseline.tools;
  if (baseline["disallowed-tools"] !== undefined) {
    result["disallowed-tools"] = [...baseline["disallowed-tools"]];
  }
  if (baseline.effort !== undefined) result.effort = baseline.effort;

  if (patch.tools !== undefined) result.tools = patchTools(baseline, patch);
  if (patch["disallowed-tools"] !== undefined) {
    result["disallowed-tools"] = [...patch["disallowed-tools"]];
  }
  if (patch.effort !== undefined) result.effort = patch.effort;

  return result;
}

function patchTools(
  baseline: ResolvedAgentConfiguration,
  patch: InvocationPatch,
): ResolvedAgentConfiguration["tools"] {
  const patchTools = patch.tools;
  if (patchTools === undefined) return baseline.tools;
  if (Array.isArray(patchTools)) return [...patchTools];
  const base: Record<string, "allow" | "deny"> = {};
  const baselineTools = baseline.tools;
  if (Array.isArray(baselineTools)) {
    for (const name of baselineTools) base[name] = "allow";
    for (const name of baseline["disallowed-tools"] ?? []) base[name] = "deny";
  } else if (baselineTools !== undefined) {
    Object.assign(base, baselineTools);
  }
  return { ...base, ...patchTools };
}

function patchSubagents(
  baseline: ResolvedAgentConfiguration,
  patch: InvocationPatch,
  caller: ResolvedAgentConfiguration,
): ResolvedAgentConfiguration["namedTargets"] {
  if (patch.subagents === undefined) return baseline.namedTargets;
  const byName = new Map(caller.namedTargets.map((target) => [target.name, target]));
  return patch.subagents.map((name) => {
    const target = byName.get(name);
    if (!target) {
      throw new InvocationPatchError(`Subagent "${name}" is not in the caller's roster.`);
    }
    return { name, definitionRevisionId: target.definitionRevisionId };
  });
}

async function patchSkills(
  input: ApplyInvocationPatchInput,
): Promise<ResolvedAgentConfiguration["skills"]> {
  const { baseline, patch, store, packageRevisionId } = input;
  const skills = patch.skills;
  if (skills === undefined) return baseline.skills;

  const loadNames = skills.load;
  const availableNames = skills.available;
  const needsResolver =
    (loadNames !== undefined && loadNames.length > 0) ||
    (availableNames !== undefined && availableNames.length > 0);
  if (needsResolver && !packageRevisionId) {
    throw new InvocationPatchError(
      "Cannot resolve patched skills without a retained package root.",
    );
  }
  const resolver: RetainedSkillResolver | null =
    needsResolver && packageRevisionId
      ? await buildRetainedSkillResolver({ packageRevisionId, store })
      : null;

  const resolve = (reference: string): RetainedSkillReference => {
    if (!resolver) throw new InvocationPatchError(`Cannot resolve skill "${reference}".`);
    try {
      return resolver.resolve(reference);
    } catch (error) {
      if (error instanceof AgentConfigurationError) {
        throw new InvocationPatchError(error.message);
      }
      throw error;
    }
  };

  return {
    load: loadNames === undefined ? baseline.skills.load : loadNames.map(resolve),
    available:
      availableNames === undefined ? baseline.skills.available : availableNames.map(resolve),
  };
}

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

/** Unresolvable or malformed patch reference (skill name, roster name, or value shape). */
export class InvocationPatchError extends Error {}

const PATCH_KEYS = new Set(["model", "effort", "tools", "disallowed-tools", "subagents", "skills"]);

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "none", "disabled", "adaptive"]);

const TOOL_POLICIES = new Set(["allow", "deny"]);

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

  assertValidPatchShape(patch);

  const result: ResolvedAgentConfiguration = {
    model: patch.model !== undefined ? patch.model : baseline.model,
    skills: await patchSkills(input),
    namedTargets: patchSubagents(baseline, patch, caller),
  };

  const tools = patchTools(baseline, patch);
  if (tools.tools !== undefined) result.tools = tools.tools;
  if (tools["disallowed-tools"] !== undefined) {
    result["disallowed-tools"] = tools["disallowed-tools"];
  }

  if (baseline.effort !== undefined) result.effort = baseline.effort;
  if (patch.effort !== undefined) result.effort = patch.effort;

  return result;
}

interface PatchedTools {
  tools?: ResolvedAgentConfiguration["tools"];
  "disallowed-tools"?: string[];
}

/**
 * Merges a tools patch over the baseline without changing which representation
 * semantics apply. A non-empty array baseline stays an allow-list: an `allow`
 * adds the name to the list, a `deny` keeps the name in the list but adds it to
 * `disallowed-tools`. An object (or empty/omitted) baseline stays a deny-list
 * map. An array patch replaces outright; `[]` keeps Mars's full-tools default.
 */
function patchTools(baseline: ResolvedAgentConfiguration, patch: InvocationPatch): PatchedTools {
  let tools: ResolvedAgentConfiguration["tools"] = copyTools(baseline.tools);
  let disallowed = [...(baseline["disallowed-tools"] ?? [])];

  const patchTools = patch.tools;
  if (Array.isArray(patchTools)) {
    tools = [...patchTools];
  } else if (patchTools !== undefined) {
    const entries = Object.entries(patchTools);
    if (Array.isArray(tools) && tools.length > 0) {
      const list = [...tools];
      for (const [name, policy] of entries) {
        if (policy === "allow") {
          if (!list.includes(name)) list.push(name);
          disallowed = disallowed.filter((item) => item !== name);
        } else if (!disallowed.includes(name)) {
          disallowed = [...disallowed, name];
        }
      }
      tools = list;
    } else {
      const base = tools !== undefined && !Array.isArray(tools) ? { ...tools } : {};
      for (const [name, policy] of entries) {
        base[name] = policy;
        if (policy === "allow") disallowed = disallowed.filter((item) => item !== name);
      }
      tools = base;
    }
  }

  if (patch["disallowed-tools"] !== undefined) {
    disallowed = [...patch["disallowed-tools"]];
  }

  const result: PatchedTools = {};
  if (tools !== undefined) result.tools = tools;
  if (
    disallowed.length > 0 ||
    patch["disallowed-tools"] !== undefined ||
    baseline["disallowed-tools"] !== undefined
  ) {
    result["disallowed-tools"] = disallowed;
  }
  return result;
}

function patchSubagents(
  baseline: ResolvedAgentConfiguration,
  patch: InvocationPatch,
  caller: ResolvedAgentConfiguration,
): ResolvedAgentConfiguration["namedTargets"] {
  if (patch.subagents === undefined) return copyNamedTargets(baseline.namedTargets);
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
  if (skills === undefined) return copySkills(baseline.skills);

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
    load:
      loadNames === undefined ? copySkillReferences(baseline.skills.load) : loadNames.map(resolve),
    available:
      availableNames === undefined
        ? copySkillReferences(baseline.skills.available)
        : availableNames.map(resolve),
  };
}

/** Rejects unknown keys and wrong value shapes before any baseline merge. */
function assertValidPatchShape(patch: InvocationPatch): void {
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) throw new InvocationPatchError(`Unknown override field: ${key}`);
  }
  if (patch.model !== undefined && typeof patch.model !== "string") {
    throw new InvocationPatchError("override model must be a string");
  }
  if (patch.effort !== undefined && !EFFORTS.has(patch.effort)) {
    throw new InvocationPatchError(`Unknown effort: ${patch.effort}`);
  }
  if (patch.tools !== undefined && !Array.isArray(patch.tools)) {
    if (typeof patch.tools !== "object" || patch.tools === null) {
      throw new InvocationPatchError("override tools must be an array or a map");
    }
    for (const [name, policy] of Object.entries(patch.tools)) {
      if (!TOOL_POLICIES.has(policy)) {
        throw new InvocationPatchError(`Unknown tool policy for "${name}": ${policy}`);
      }
    }
  }
  if (patch.tools !== undefined && Array.isArray(patch.tools) && !isStringArray(patch.tools)) {
    throw new InvocationPatchError("override tools must be a string array");
  }
  if (patch["disallowed-tools"] !== undefined && !isStringArray(patch["disallowed-tools"])) {
    throw new InvocationPatchError("override disallowed-tools must be a string array");
  }
  if (patch.subagents !== undefined && !isStringArray(patch.subagents)) {
    throw new InvocationPatchError("override subagents must be a string array");
  }
  if (patch.skills !== undefined) {
    if (typeof patch.skills !== "object" || patch.skills === null || Array.isArray(patch.skills)) {
      throw new InvocationPatchError("override skills must be an object");
    }
    for (const key of Object.keys(patch.skills)) {
      if (key !== "load" && key !== "available") {
        throw new InvocationPatchError(`Unknown skills override field: ${key}`);
      }
    }
    if (patch.skills.load !== undefined && !isStringArray(patch.skills.load)) {
      throw new InvocationPatchError("override skills.load must be a string array");
    }
    if (patch.skills.available !== undefined && !isStringArray(patch.skills.available)) {
      throw new InvocationPatchError("override skills.available must be a string array");
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function copyTools(
  tools: ResolvedAgentConfiguration["tools"],
): ResolvedAgentConfiguration["tools"] {
  if (tools === undefined) return undefined;
  if (Array.isArray(tools)) return [...tools];
  return { ...tools };
}

function copyNamedTargets(
  targets: ResolvedAgentConfiguration["namedTargets"],
): ResolvedAgentConfiguration["namedTargets"] {
  return targets.map((target) => ({ ...target }));
}

function copySkills(
  skills: ResolvedAgentConfiguration["skills"],
): ResolvedAgentConfiguration["skills"] {
  return {
    load: copySkillReferences(skills.load),
    available: copySkillReferences(skills.available),
  };
}

function copySkillReferences(references: RetainedSkillReference[]): RetainedSkillReference[] {
  return references.map((reference) => ({ ...reference }));
}

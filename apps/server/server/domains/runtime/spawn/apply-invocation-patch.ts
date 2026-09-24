/** Applies a presence-sensitive per-invocation patch to a fully-resolved baseline configuration. */
import {
  type InvocationPatch,
  invocationPatchSchema,
  type ResolvedAgentConfiguration,
  type RetainedSkillReference,
} from "@meridian/contracts/agents";
import { ZodError } from "zod";
import {
  AgentConfigurationError,
  type AgentRevisionStore,
  buildRetainedSkillResolver,
  type RetainedSkillResolver,
} from "../../packages/index.js";

/** Unresolvable or malformed patch reference (skill name, roster name, or value shape). */
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

type PatchMerge<K extends keyof InvocationPatch> = (
  value: NonNullable<InvocationPatch[K]>,
  input: ApplyInvocationPatchInput,
) => Partial<ResolvedAgentConfiguration> | Promise<Partial<ResolvedAgentConfiguration>>;

/**
 * One merge per patch key. The mapped type makes a knob added to
 * `invocationPatchSchema` without a merge a compile error.
 */
export const PATCH_MERGES: { [K in keyof InvocationPatch]-?: PatchMerge<K> } = {
  model: (value) => ({ model: value }),
  effort: (value) => ({ effort: value }),
  // tools and disallowed-tools are coupled: a map `allow` lifts the name from the
  // baseline denial list. Each entry returns the full patchTools result so either
  // key present alone still applies the lift; patchTools is pure in
  // (baseline, patch), so this is idempotent and order-independent.
  tools: (_value, input) => patchTools(input.baseline, input.patch),
  "disallowed-tools": (_value, input) => patchTools(input.baseline, input.patch),
  subagents: (_value, input) => ({
    namedTargets: patchSubagents(input.baseline, input.patch, input.caller),
  }),
  skills: async (_value, input) => ({ skills: await patchSkills(input) }),
};

export async function applyInvocationPatch(
  input: ApplyInvocationPatchInput,
): Promise<ResolvedAgentConfiguration> {
  const patch = parseInvocationPatch(input.patch);
  const effective: ApplyInvocationPatchInput = { ...input, patch };
  const { baseline } = effective;

  const result: ResolvedAgentConfiguration = {
    model: baseline.model,
    skills: copySkills(baseline.skills),
    namedTargets: copyNamedTargets(baseline.namedTargets),
  };
  if (baseline.tools !== undefined) result.tools = copyTools(baseline.tools);
  if (baseline["disallowed-tools"] !== undefined) {
    result["disallowed-tools"] = [...baseline["disallowed-tools"]];
  }
  if (baseline.effort !== undefined) result.effort = baseline.effort;

  for (const key of Object.keys(patch) as Array<keyof InvocationPatch>) {
    if (patch[key] === undefined) continue;
    const merge = PATCH_MERGES[key] as PatchMerge<keyof InvocationPatch>;
    Object.assign(result, await merge(patch[key] as never, effective));
  }

  return result;
}

/**
 * The schema is the allow-list; this replaces the old hand-rolled shape guard.
 * A `ZodError` becomes the typed error the spawn path already routes to
 * `spawn_invocation_patch_invalid` before any child row is created.
 */
function parseInvocationPatch(patch: unknown): InvocationPatch {
  try {
    return invocationPatchSchema.parse(patch);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new InvocationPatchError(
        error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      );
    }
    throw error;
  }
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

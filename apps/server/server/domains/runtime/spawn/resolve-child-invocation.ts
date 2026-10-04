/**
 * resolve-child-invocation — resolve and validate a child invocation's agent
 * selection, per-invocation overlay, and availability against the caller's
 * retained binding. Pure resolution: no thread, turn, run, or repository
 * dependency; the caller owns thread creation and persistence.
 */
import {
  GENERIC_SUBAGENT_SLUG,
  type InvocationOverlay,
  type InvocationPatch,
  type ResolvedAgentConfiguration,
} from "@meridian/contracts/agents";
import {
  type MeridianError,
  meridianError,
  meridianErrorFromSystem,
} from "@meridian/contracts/interrupt";
import {
  type AgentRevision,
  type AgentRevisionBinding,
  type AgentRevisionStore,
  type CompiledAgentDefinition,
  resolveAgentConfiguration,
} from "../../packages/index.js";
import { toolsBeyondParent } from "../loop/permissions/invocation-authority.js";
import { type InvalidArgumentIssue, renderInvalidArguments } from "../tools/invalid-arguments.js";
import { applyInvocationPatch, InvocationPatchError } from "./apply-invocation-patch.js";

export interface ResolveChildInvocationDeps {
  agentRevisions: Pick<
    AgentRevisionStore,
    "readRevision" | "readSource" | "readPackageDefinitions"
  >;
  defaultModel(): string | undefined;
  unavailableReasons(definition: CompiledAgentDefinition, model: string): string[];
  modelUnavailable(model: string): string[];
}

export interface ResolveChildInvocationInput {
  parentAgent: AgentRevisionBinding;
  /** Named roster target; an empty slug selects the agent-less generic subagent. */
  requestedSlug: string;
  /** Per-invocation execution patch, applied over the resolved baseline. */
  overrides?: InvocationPatch;
  /** Per-invocation additive prompt layer; omitted appends nothing. */
  appendSystemPrompt?: string;
}

export type ResolveChildInvocationOutcome =
  | {
      ok: true;
      revision: AgentRevision | null;
      configuration: ResolvedAgentConfiguration;
      resolvedSlug: string;
      defaultTitle: string;
      invocationOverlay: InvocationOverlay | null;
    }
  | { ok: false; error: MeridianError };

export async function resolveChildInvocation(
  input: ResolveChildInvocationInput,
  deps: ResolveChildInvocationDeps,
): Promise<ResolveChildInvocationOutcome> {
  const { parentAgent, requestedSlug } = input;
  let revision: AgentRevision | null;
  let configuration: ResolvedAgentConfiguration;
  let resolvedSlug: string;
  let defaultTitle: string;
  let patchPackageRoot: string | null;
  if (requestedSlug === "") {
    configuration = { ...parentAgent.configuration };
    revision = null;
    resolvedSlug = GENERIC_SUBAGENT_SLUG;
    defaultTitle = GENERIC_SUBAGENT_SLUG;
    patchPackageRoot = parentAgent.revision?.packageRevisionId ?? null;
  } else {
    const target = parentAgent.configuration.namedTargets.find(
      (item) => item.name === requestedSlug,
    );
    if (!target) {
      return {
        ok: false,
        error: meridianErrorFromSystem(
          "spawn_agent_not_allowed",
          `Agent "${requestedSlug}" is not in caller subagents`,
        ),
      };
    }
    const childAgent = await deps.agentRevisions.readRevision(target.definitionRevisionId);
    if (!childAgent || childAgent.definition.metadata["model-invocable"] === false) {
      return {
        ok: false,
        error: meridianErrorFromSystem(
          "spawn_agent_not_found",
          `Agent "${requestedSlug}" is unavailable in the caller's retained package`,
        ),
      };
    }
    revision = childAgent;
    configuration = await resolveAgentConfiguration({
      revision: childAgent,
      store: deps.agentRevisions,
      defaultModel: deps.defaultModel(),
    });
    resolvedSlug = requestedSlug;
    defaultTitle = `${requestedSlug} subagent`;
    patchPackageRoot = childAgent.packageRevisionId;
  }

  if (input.overrides !== undefined) {
    const raise = permissionRaiseIssue({
      requested: input.overrides.permission,
      parent: parentAgent.configuration,
      child: configuration,
      childName: resolvedSlug,
    });
    if (raise) return { ok: false, error: spawnInvalidArguments([raise]) };
    let patched: ResolvedAgentConfiguration;
    try {
      patched = await applyInvocationPatch({
        baseline: configuration,
        patch: input.overrides,
        caller: parentAgent.configuration,
        store: deps.agentRevisions,
        packageRevisionId: patchPackageRoot,
      });
    } catch (error) {
      if (error instanceof InvocationPatchError) {
        return {
          ok: false,
          error: meridianErrorFromSystem("spawn_invocation_patch_invalid", error.message),
        };
      }
      throw error;
    }
    configuration = patched;
  }

  const extra = toolsBeyondParent(parentAgent.configuration, configuration);
  if (extra.length) {
    return {
      ok: false,
      error: spawnInvalidArguments([toolsBeyondParentIssue(resolvedSlug, extra)]),
    };
  }

  if (revision) {
    const unavailable = deps.unavailableReasons(revision.definition, configuration.model);
    if (unavailable.length) {
      return {
        ok: false,
        error: meridianErrorFromSystem("spawn_agent_unavailable", unavailable.join(" ")),
      };
    }
  } else {
    const unavailable = deps.modelUnavailable(configuration.model);
    if (unavailable.length) {
      return {
        ok: false,
        error: meridianErrorFromSystem("spawn_agent_unavailable", unavailable.join(" ")),
      };
    }
  }

  const invocationOverlay: InvocationOverlay | null =
    input.appendSystemPrompt !== undefined || input.overrides !== undefined
      ? {
          ...(input.appendSystemPrompt !== undefined
            ? { appendSystemPrompt: input.appendSystemPrompt }
            : {}),
          ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
        }
      : null;

  return {
    ok: true,
    revision,
    configuration,
    resolvedSlug,
    defaultTitle,
    invocationOverlay,
  };
}

/**
 * `overrides.permission` only lowers (file-access §8 D8): asking for `edit`
 * under a `read` parent or a `read` profile is an argument error, never a
 * silent drop.
 */
function permissionRaiseIssue(input: {
  requested: ResolvedAgentConfiguration["permission"] | undefined;
  parent: ResolvedAgentConfiguration;
  child: ResolvedAgentConfiguration;
  childName: string;
}): InvalidArgumentIssue | null {
  if (input.requested !== "edit") return null;
  if (input.parent.permission === "read") {
    return {
      path: "overrides.permission",
      message: 'can only lower permission, and yours is "read"',
    };
  }
  // A generic child copies the parent's configuration, so only a named profile reaches here.
  if (input.child.permission === "read") {
    return {
      path: "overrides.permission",
      message: `can only lower permission, and ${input.childName}'s is "read"`,
    };
  }
  return null;
}

/**
 * A child never gets a tool its parent lacks (D13). Naming them in
 * `overrides.disallowed_tools` is the fix, so the refusal says so instead of
 * dropping them silently.
 */
function toolsBeyondParentIssue(childName: string, tools: string[]): InvalidArgumentIssue {
  const quoted = tools.map((tool) => JSON.stringify(tool));
  const named =
    quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
  return {
    path: "overrides.disallowed_tools",
    message: `${childName} has ${named} and you don't; add ${quoted.length === 1 ? "it" : "them"} here`,
  };
}

/** An `invalid_arguments` refusal carried on the spawn result; the spawn tool unwraps it. */
function spawnInvalidArguments(issues: InvalidArgumentIssue[]): MeridianError {
  return meridianError({
    code: "invalid_arguments",
    message: renderInvalidArguments("spawn", issues),
    source: "tool",
    retryable: false,
    details: { issues },
  });
}

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
import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import {
  type AgentRevision,
  type AgentRevisionBinding,
  type AgentRevisionStore,
  type CompiledAgentDefinition,
  resolveAgentConfiguration,
} from "../../packages/index.js";
import { validateInvocationAuthority } from "../loop/permissions/invocation-authority.js";
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
    const reasons = validateInvocationAuthority({
      baseline: configuration,
      patched,
      caller: parentAgent.configuration,
    });
    if (reasons.length) {
      return {
        ok: false,
        error: meridianErrorFromSystem("spawn_invocation_authority_denied", reasons.join(" ")),
      };
    }
    configuration = patched;
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

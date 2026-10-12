/** Next-turn Agent configuration comes exclusively from the retained thread binding. */
import {
  type AgentEffort,
  GENERIC_AGENT_BODY,
  GENERIC_SUBAGENT_SLUG,
  type ResolvedAgentConfiguration,
} from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import type { AgentRevisionStore } from "../../packages/index.js";
import type { ThreadRepository } from "../../threads/index.js";
import { agentDefinitionUnsupportedReasons } from "../agent-definition-support.js";
import type { GenerateRequest, Tool } from "../gateway/index.js";
import { bindingNamesSkills } from "../loop/available-skills.js";
import { readChainPermission } from "../loop/permissions/agent-chain.js";
import {
  advertiseTools,
  projectToolPolicy,
  type ToolPolicy,
} from "../loop/permissions/tool-policy.js";
import { spawnToolDescription } from "./spawn-tools.js";
import type { ToolRegistry } from "./types.js";

export interface AgentThreadTurnContext {
  agentSlug: string;
  compaction: { autocompact?: number; autocompact_pct?: number };
  gatewayParams: Pick<GenerateRequest, "model" | "reasoning">;
  tools: Tool[];
  agentBody: string;
  appendPrompt: string | undefined;
  subagentGuidance: string | undefined;
  permissionGuidance: string | undefined;
  policy: ToolPolicy;
}

export interface ResolveAgentThreadTurnContextInput {
  thread: Thread;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding">;
  /** Walks the spawn lineage for the chain's permission. */
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  toolRegistry: ToolRegistry;
  baseTools: Tool[] | undefined;
}

/** Mandatory closing instruction for subagent threads; owns the prompt's last layer. */
export const SUBAGENT_GUIDANCE =
  "You are a subagent. Finish by calling return_result with a report for your parent. If blocked or you need an answer, report that to your parent.";

/** States a `read` agent's permission (the chain's minimum) up front so it rarely meets a refusal (file-access §8). */
const READ_PERMISSION_GUIDANCE =
  "Your permission is read: you can read every file, and edit only scratch://.";

/**
 * Exhaustive bridge from canonical effort to `GenerateRequest.reasoning`. The
 * record makes a new canonical effort value demand an explicit provider mapping.
 */
const EFFORT_TO_REASONING: Record<AgentEffort, GenerateRequest["reasoning"]> = {
  low: { effort: "low" },
  medium: { effort: "medium" },
  high: { effort: "high" },
  xhigh: { effort: "max" },
  none: "disabled",
  disabled: "disabled",
  adaptive: "adaptive",
};

export function mapAgentEffortToReasoning(
  effort: AgentEffort | undefined,
): GenerateRequest["reasoning"] {
  return effort === undefined ? undefined : EFFORT_TO_REASONING[effort];
}

/** Translate canonical Mars effort names into the gateway's provider-neutral contract. */
export function agentGatewayMetaToGenerateParams(
  meta: Pick<ResolvedAgentConfiguration, "model" | "effort">,
): Pick<GenerateRequest, "model" | "reasoning"> {
  const params: Pick<GenerateRequest, "model" | "reasoning"> = {};
  if (meta.model) params.model = meta.model;
  const reasoning = mapAgentEffortToReasoning(meta.effort);
  if (reasoning !== undefined) params.reasoning = reasoning;
  return params;
}

export async function resolveAgentThreadTurnContext(
  input: ResolveAgentThreadTurnContextInput,
): Promise<AgentThreadTurnContext> {
  const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
  if (!binding) throw new Error("Conversation has no retained Agent binding");
  if (binding.revision) {
    const reasons = agentDefinitionUnsupportedReasons(binding.revision.definition);
    if (reasons.length) throw new Error(reasons.join(" "));
  }

  const policy = withoutSkillToolWhenNoSkills(
    projectToolPolicy(binding.configuration, input.thread.kind),
    binding,
  );
  // return_result is unadvertised in the registry; the policy adds it for subagents.
  const report = input.toolRegistry.getRegistration("return_result")?.definition;
  const tools = advertiseTools(
    [...(input.baseTools ?? []), ...(report ? [report] : [])],
    policy,
  ).map((tool) =>
    tool.type === "function" && tool.name === "spawn"
      ? {
          ...tool,
          description: spawnToolDescription(binding.configuration.namedTargets.length > 0),
        }
      : tool,
  );
  const agentBody = binding.revision?.definition.systemPrompt ?? GENERIC_AGENT_BODY;
  return {
    compaction: {
      autocompact: binding.revision?.definition.metadata.autocompact,
      autocompact_pct: binding.revision?.definition.metadata.autocompact_pct,
    },
    agentSlug: binding.revision?.slug ?? GENERIC_SUBAGENT_SLUG,
    gatewayParams: agentGatewayMetaToGenerateParams({
      model: binding.configuration.model,
      effort: binding.configuration.effort,
    }),
    tools,
    policy,
    agentBody,
    appendPrompt: binding.invocationOverlay?.appendSystemPrompt,
    subagentGuidance: input.thread.kind === "subagent" ? SUBAGENT_GUIDANCE : undefined,
    permissionGuidance: (await chainIsReadOnly(input, binding.configuration.permission))
      ? READ_PERMISSION_GUIDANCE
      : undefined,
  };
}

/**
 * A thread that can see no skill isn't offered `skill` (D64). It reads only
 * the binding already in hand, so an agent whose listed skills are all hidden
 * from the model keeps the tool and gets a refusal instead.
 */
function withoutSkillToolWhenNoSkills(
  policy: ToolPolicy,
  binding: Parameters<typeof bindingNamesSkills>[0],
): ToolPolicy {
  if (!policy.has("skill") || bindingNamesSkills(binding)) return policy;
  return new Set([...policy].filter((tool) => tool !== "skill"));
}

/** A root thread needs no lineage walk; a child is `read` when any spawner is. */
async function chainIsReadOnly(
  input: ResolveAgentThreadTurnContextInput,
  own: ResolvedAgentConfiguration["permission"],
): Promise<boolean> {
  if (own === "read") return true;
  const parentId = input.thread.parentThreadId;
  return parentId != null && (await readChainPermission(input, parentId)) === "read";
}

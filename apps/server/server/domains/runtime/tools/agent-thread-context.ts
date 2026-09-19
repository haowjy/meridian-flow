/** Next-turn Agent configuration comes exclusively from the retained thread binding. */
import {
  type AgentEffort,
  GENERIC_AGENT_BODY,
  GENERIC_SUBAGENT_SLUG,
  type ResolvedAgentConfiguration,
} from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import type { AgentRevisionStore } from "../../packages/index.js";
import { agentDefinitionUnsupportedReasons } from "../agent-definition-support.js";
import type { GenerateRequest, Tool } from "../gateway/index.js";
import { advertiseTools } from "../loop/permissions/apply-tool-policy.js";
import {
  type EffectiveToolPolicy,
  projectToolPolicy,
} from "../loop/permissions/project-tool-policy.js";
import { spawnToolDescription } from "./spawn-tools.js";
import type { ToolRegistry } from "./types.js";

export interface AgentThreadTurnContext {
  agentSlug: string;
  gatewayParams: Pick<GenerateRequest, "model" | "reasoning">;
  tools: Tool[];
  agentBody: string;
  policy: EffectiveToolPolicy;
}

export interface ResolveAgentThreadTurnContextInput {
  thread: Thread;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding">;
  toolRegistry: ToolRegistry;
  baseTools: Tool[] | undefined;
}

/**
 * Exhaustive bridge from canonical effort to `GenerateRequest.reasoning`. The
 * record makes a new canonical effort value demand an explicit provider mapping.
 */
export const EFFORT_TO_REASONING: Record<AgentEffort, GenerateRequest["reasoning"]> = {
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

  const policy = projectToolPolicy(binding.configuration);
  let tools = advertiseTools(input.baseTools, policy).map((tool) =>
    tool.type === "function" && tool.name === "spawn"
      ? {
          ...tool,
          description: spawnToolDescription(binding.configuration.namedTargets.length > 0),
        }
      : tool,
  );
  const report =
    input.thread.kind === "subagent"
      ? input.toolRegistry.getRegistration("return_result")?.definition
      : undefined;
  if (report && !tools.some((tool) => toolName(tool) === report.name)) tools = [...tools, report];
  const baseBody =
    binding.invocationOverlay?.systemPrompt ??
    binding.revision?.definition.systemPrompt ??
    GENERIC_AGENT_BODY;
  return {
    agentSlug: binding.revision?.slug ?? GENERIC_SUBAGENT_SLUG,
    gatewayParams: agentGatewayMetaToGenerateParams({
      model: binding.configuration.model,
      effort: binding.configuration.effort,
    }),
    tools,
    policy,
    agentBody:
      input.thread.kind === "subagent"
        ? `${baseBody}\n\nYou are a subagent. Finish by calling return_result with a report for your parent. If blocked or you need an answer, report that to your parent.`
        : baseBody,
  };
}

function toolName(tool: Tool): string {
  return tool.type === "function" ? tool.name : tool.kind;
}

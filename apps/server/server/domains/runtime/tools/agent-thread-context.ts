/** Next-turn Agent configuration comes exclusively from the retained thread binding. */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
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

/** Translate canonical Mars effort names into the gateway's provider-neutral contract. */
export function agentGatewayMetaToGenerateParams(
  meta: Pick<ResolvedAgentConfiguration, "model" | "effort">,
): Pick<GenerateRequest, "model" | "reasoning"> {
  const params: Pick<GenerateRequest, "model" | "reasoning"> = {};
  if (meta.model) params.model = meta.model;
  if (meta.effort === "disabled" || meta.effort === "none") params.reasoning = "disabled";
  else if (meta.effort === "adaptive") params.reasoning = "adaptive";
  else if (meta.effort)
    params.reasoning = { effort: meta.effort === "xhigh" ? "max" : meta.effort };
  return params;
}

export async function resolveAgentThreadTurnContext(
  input: ResolveAgentThreadTurnContextInput,
): Promise<AgentThreadTurnContext> {
  const revision = await input.agentRevisions.readThreadBinding(input.thread.id);
  if (!revision) throw new Error("Conversation has no retained Agent binding");
  const reasons = agentDefinitionUnsupportedReasons(revision.definition);
  if (reasons.length) throw new Error(reasons.join(" "));

  const policy = projectToolPolicy(revision.configuration);
  let tools = advertiseTools(input.baseTools, policy).map((tool) =>
    tool.type === "function" && tool.name === "spawn"
      ? {
          ...tool,
          description: spawnToolDescription(revision.configuration.namedTargets.length > 0),
        }
      : tool,
  );
  const report =
    input.thread.kind === "subagent"
      ? input.toolRegistry.getRegistration("return_result")?.definition
      : undefined;
  if (report && !tools.some((tool) => toolName(tool) === report.name)) tools = [...tools, report];
  return {
    agentSlug: revision.slug,
    gatewayParams: agentGatewayMetaToGenerateParams({
      model: revision.configuration.model,
      effort: revision.configuration.effort,
    }),
    tools,
    policy,
    agentBody:
      input.thread.kind === "subagent"
        ? `${revision.definition.systemPrompt}\n\nYou are a subagent. Finish by calling return_result with a report for your parent. If blocked or you need an answer, report that to your parent.`
        : revision.definition.systemPrompt,
  };
}

function toolName(tool: Tool): string {
  return tool.type === "function" ? tool.name : tool.kind;
}

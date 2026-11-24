import {
  GENERIC_AGENT_BODY,
  GENERIC_SUBAGENT_SLUG,
  projectToolPolicy,
  type ResolvedAgentConfiguration,
  type ToolPolicy,
} from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import type { GenerateRequest, Tool } from "@meridian-flow/runtime/gateway";
import type { AgentRevisionStore, BoundAgentCatalog } from "../../packages/index.js";
import type { ThreadRepository } from "../../threads/index.js";
import { agentDefinitionUnsupportedReasons } from "../agent-definition-support.js";
import { bindingNamesSkills } from "../loop/available-skills.js";
import { readChainPermission } from "../loop/permissions/agent-chain.js";
import { advertiseTools } from "../loop/permissions/tool-policy.js";
import { spawnToolDescription } from "./spawn-tools.js";
import type { ToolRegistry } from "./types.js";

export interface AgentThreadTurnContext {
  agentSlug: string;
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
  agentCatalog: Pick<BoundAgentCatalog, "followRemovedModel">;
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  toolRegistry: ToolRegistry;
  baseTools: Tool[] | undefined;
}

export const SUBAGENT_GUIDANCE =
  "You are a subagent. Do the task, making reasonable calls where it leaves choices open, and finish by calling return_result with a report for your parent that says what you assumed. If you can't do it, stop and report what is missing.";

const READ_PERMISSION_GUIDANCE =
  "Your permission is read: you can read every file, and edit only scratch://.";

export function agentGatewayMetaToGenerateParams(
  meta: Pick<ResolvedAgentConfiguration, "model" | "effort">,
): Pick<GenerateRequest, "model" | "reasoning"> {
  const params: Pick<GenerateRequest, "model" | "reasoning"> = {};
  if (meta.model) params.model = meta.model;
  if (meta.effort) params.reasoning = meta.effort;
  return params;
}

export async function resolveAgentThreadTurnContext(
  input: ResolveAgentThreadTurnContextInput,
): Promise<AgentThreadTurnContext> {
  const stored = await input.agentRevisions.readThreadBinding(input.thread.id);
  if (!stored) throw new Error("Conversation has no retained Agent binding");
  const binding = await input.agentCatalog.followRemovedModel(
    input.thread.userId,
    input.thread.projectId,
    input.thread,
    stored,
  );
  if (binding.revision) {
    const reasons = agentDefinitionUnsupportedReasons(binding.revision.definition);
    if (reasons.length) throw new Error(reasons.join(" "));
  }

  const policy = withoutSkillToolWhenNoSkills(
    projectToolPolicy(binding.configuration, input.thread.kind),
    binding,
  );
  const report = input.toolRegistry.getRegistration("return_result")?.definition;
  const tools = advertiseTools(
    [...(input.baseTools ?? []), ...(report ? [report] : [])],
    policy,
  ).map((tool) =>
    tool.name === "spawn"
      ? {
          ...tool,
          description: spawnToolDescription(binding.configuration.namedTargets.length > 0),
        }
      : tool,
  );
  const agentBody = binding.revision?.definition.systemPrompt ?? GENERIC_AGENT_BODY;
  return {
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

function withoutSkillToolWhenNoSkills(
  policy: ToolPolicy,
  binding: Parameters<typeof bindingNamesSkills>[0],
): ToolPolicy {
  if (!policy.has("skill") || bindingNamesSkills(binding)) return policy;
  return new Set([...policy].filter((tool) => tool !== "skill"));
}

async function chainIsReadOnly(
  input: ResolveAgentThreadTurnContextInput,
  own: ResolvedAgentConfiguration["permission"],
): Promise<boolean> {
  if (own === "read") return true;
  const parentId = input.thread.parentThreadId;
  return parentId != null && (await readChainPermission(input, parentId)) === "read";
}

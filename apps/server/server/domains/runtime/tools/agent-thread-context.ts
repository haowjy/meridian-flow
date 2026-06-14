// @ts-nocheck
/**
 * Agent-bound thread context: resolves package-backed gateway params and the
 * per-thread advertised tool set. Skills catalogs are baked into the frozen
 * system prompt on first attempt; invoke advertisement on frozen threads is
 * derived from the persisted baked skill slug set, not re-resolved per turn.
 */
import type { Thread } from "@meridian/contracts/threads";
import {
  type AgentEffort,
  extractAgentGatewayMeta,
  type PackageRepository,
  type ResolvedSkill,
} from "../../packages/index.js";
import type { FunctionTool, GenerateRequest, Tool } from "../gateway/index.js";
import { bakedSkillSetAdvertisesInvoke } from "../loop/composed-system-prompt.js";
import { INVOKE_TOOL_NAME, renderSkillsSystemPromptSection } from "./skill-tools.js";
import type { ToolRegistry } from "./types.js";

export interface AgentThreadTurnContext {
  gatewayParams: Pick<GenerateRequest, "model" | "reasoning">;
  tools: Tool[] | undefined;
  /** Resolved package skills for this iteration (empty when thread has no agent). */
  resolvedSkills: ResolvedSkill[];
  /** Agent body used when baking the system prompt on first attempt. */
  agentBody: string | undefined;
  /** Model-invocable skill catalog appended to the system prompt when present. */
  skillsSystemPromptSection: string | undefined;
}

export interface ResolveAgentThreadTurnContextInput {
  thread: Thread;
  packageRepository: PackageRepository;
  toolRegistry: ToolRegistry;
  baseTools: Tool[] | undefined;
}

/** Map typed agent metadata onto GenerateRequest fields consumed by the gateway. */
export function agentGatewayMetaToGenerateParams(meta: {
  model?: string;
  effort?: AgentEffort;
}): Pick<GenerateRequest, "model" | "reasoning"> {
  const params: Pick<GenerateRequest, "model" | "reasoning"> = {};
  if (meta.model) {
    params.model = meta.model;
  }
  if (meta.effort) {
    if (meta.effort === "disabled" || meta.effort === "adaptive") {
      params.reasoning = meta.effort;
    } else {
      params.reasoning = { effort: meta.effort };
    }
  }
  return params;
}

/** Resolve gateway params and advertised tools for an agent-bound thread turn. */
export async function resolveAgentThreadTurnContext(
  input: ResolveAgentThreadTurnContextInput,
): Promise<AgentThreadTurnContext> {
  const agentSlug = input.thread.currentAgent;
  if (!agentSlug) {
    return {
      gatewayParams: {},
      tools: input.baseTools,
      resolvedSkills: [],
      agentBody: undefined,
      skillsSystemPromptSection: undefined,
    };
  }

  const packageContext = await input.packageRepository.getAgentWithLinkedSkills(
    input.thread.projectId,
    input.thread.userId,
    agentSlug,
  );

  const gatewayParams = packageContext.agent
    ? agentGatewayMetaToGenerateParams(extractAgentGatewayMeta(packageContext.agent))
    : {};

  const modelInvocableSkills = packageContext.skills.filter((skill) => skill.modelInvocable);
  const skillsSystemPromptSection = renderSkillsSystemPromptSection(packageContext.skills);
  const invokeTool =
    modelInvocableSkills.length > 0 ? resolveInvokeTool(input.toolRegistry) : undefined;

  const baseTools = input.baseTools ?? [];
  let tools = input.baseTools;
  if (invokeTool) {
    tools = [...(tools ?? baseTools), invokeTool];
  }
  const spawnTools = resolveSpawnPrimitiveTools(
    input.toolRegistry,
    input.thread,
    packageContext.agent?.meta,
    tools ?? baseTools,
  );
  if (spawnTools.length > 0) {
    tools = [...(tools ?? []), ...spawnTools];
  }

  return {
    gatewayParams,
    tools,
    resolvedSkills: packageContext.skills,
    agentBody: packageContext.agent?.body,
    skillsSystemPromptSection,
  };
}

function resolveInvokeTool(registry: ToolRegistry): FunctionTool | undefined {
  const registration = registry.getRegistration(INVOKE_TOOL_NAME);
  return registration?.definition;
}

function toolName(tool: Tool): string {
  return tool.type === "function" ? tool.name : tool.kind;
}

/** Apply invoke advertisement from the persisted baked skill slug set. */
export function applyBakedInvokeAdvertisement(input: {
  tools: Tool[] | undefined;
  bakedSkillSlugs: string[] | null | undefined;
  toolRegistry: ToolRegistry;
}): Tool[] | undefined {
  const advertiseInvoke = bakedSkillSetAdvertisesInvoke(input.bakedSkillSlugs);
  const withoutInvoke =
    input.tools?.filter((tool) => toolName(tool) !== INVOKE_TOOL_NAME) ?? input.tools;
  if (!advertiseInvoke) {
    return withoutInvoke?.length ? withoutInvoke : undefined;
  }
  const invokeTool = resolveInvokeTool(input.toolRegistry);
  if (!invokeTool) {
    return withoutInvoke?.length ? withoutInvoke : undefined;
  }
  if (input.tools?.some((tool) => toolName(tool) === INVOKE_TOOL_NAME)) {
    return input.tools;
  }
  return [...(withoutInvoke ?? []), invokeTool];
}

function subagentsFromMeta(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.subagents;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function resolveSpawnPrimitiveTools(
  registry: ToolRegistry,
  thread: Thread,
  agentMeta: Record<string, unknown> | undefined,
  existingTools: Tool[] | undefined,
): FunctionTool[] {
  const existingNames = new Set((existingTools ?? []).map((tool) => toolName(tool)));
  const advertised: FunctionTool[] = [];
  const spawnRegistration = registry.getRegistration("spawn");
  const returnResultRegistration = registry.getRegistration("return_result");

  if (
    thread.currentAgent &&
    spawnRegistration &&
    subagentsFromMeta(agentMeta).length > 0 &&
    !existingNames.has("spawn")
  ) {
    advertised.push(spawnRegistration.definition);
  }
  if (
    thread.kind === "subagent" &&
    returnResultRegistration &&
    !existingNames.has("return_result")
  ) {
    advertised.push(returnResultRegistration.definition);
  }
  return advertised;
}

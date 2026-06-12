// @ts-nocheck
/**
 * Assembles a ModelRequestDebugRecord from the orchestrator's pre-stream state.
 */
import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";
import type { ResolvedSkill } from "../../packages/index.js";
import type { FunctionTool, GenerateRequest, Message, Tool } from "../gateway/index.js";
import { toJsonValue } from "../loop/streaming.js";
import type { ToolRegistry } from "../tools/index.js";

function textFromMessageContent(message: Message): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function extractSystemMessageTexts(messages: Message[]): string[] {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => textFromMessageContent(message))
    .filter((text) => text.length > 0);
}

function advertisedToolsMetadata(
  registry: ToolRegistry,
  tools: Tool[] | undefined,
): ModelRequestDebugRecord["tools"] {
  if (!tools) return [];
  return tools
    .filter((tool): tool is FunctionTool => tool.type === "function")
    .map((tool) => {
      const registration = registry.getRegistration(tool.name);
      return {
        name: tool.name,
        source: registration?.source ?? "unknown",
        capability: registration?.capability ?? null,
      };
    });
}

function skillsMetadata(resolvedSkills: ResolvedSkill[]): ModelRequestDebugRecord["skills"] {
  return resolvedSkills.map((resolved) => ({
    slug: resolved.skill.slug,
    layer: resolved.layer,
  }));
}

export function buildModelRequestDebugRecord(input: {
  threadId: string;
  turnId: string;
  iteration: number;
  agentSlug: string | null;
  request: GenerateRequest;
  resolvedSkills: ResolvedSkill[];
  toolRegistry: ToolRegistry;
}): ModelRequestDebugRecord {
  const nonSystemMessageCount = input.request.messages.filter(
    (message) => message.role !== "system",
  ).length;

  return {
    threadId: input.threadId,
    turnId: input.turnId,
    iteration: input.iteration,
    requestedAt: new Date().toISOString(),
    agentSlug: input.agentSlug,
    model: input.request.model ?? null,
    provider: input.request.provider ?? null,
    reasoning: input.request.reasoning != null ? toJsonValue(input.request.reasoning) : null,
    systemMessages: extractSystemMessageTexts(input.request.messages),
    skills: skillsMetadata(input.resolvedSkills),
    tools: advertisedToolsMetadata(input.toolRegistry, input.request.tools),
    messageCount: nonSystemMessageCount,
  };
}

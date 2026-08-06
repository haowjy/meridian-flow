/** Builds the complete provider-neutral request record captured before dispatch. */
import { createHash } from "node:crypto";
import type {
  JsonObject,
  ModelRequestDebugRecord,
  ModelRequestDebugRequest,
} from "@meridian/contracts/threads";
import type { ResolvedSkill } from "../../packages/index.js";
import type { FunctionTool, GenerateRequest, Tool } from "../gateway/index.js";
import { toJsonValue } from "../loop/streaming.js";
import type { ToolRegistry } from "../tools/index.js";

const UTF8_ENCODER = new TextEncoder();

function jsonObject(value: unknown): JsonObject {
  const serialized = toJsonValue(value);
  if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) {
    throw new Error("Model request debug capture expected a JSON object");
  }
  return serialized;
}

function canonicalRequest(request: GenerateRequest): ModelRequestDebugRequest {
  return jsonObject({
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.provider === undefined ? {} : { provider: request.provider }),
    messages: request.messages,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.stopSequences === undefined ? {} : { stopSequences: request.stopSequences }),
    ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
    ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
    ...(request.providerOptions === undefined ? {} : { providerOptions: request.providerOptions }),
  }) as ModelRequestDebugRequest;
}

function advertisedToolsMetadata(
  registry: ToolRegistry,
  tools: Tool[] | undefined,
): ModelRequestDebugRecord["toolRegistrations"] {
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
  gatewayCallId: string;
  threadId: string;
  turnId: string;
  iteration: number;
  agentSlug: string | null;
  request: GenerateRequest;
  resolvedSkills: ResolvedSkill[];
  toolRegistry: ToolRegistry;
}): ModelRequestDebugRecord {
  const request = canonicalRequest(input.request);
  const serializedRequest = JSON.stringify(request);

  return {
    schema: "meridian.model-request-debug.v1",
    gatewayCallId: input.gatewayCallId,
    threadId: input.threadId,
    turnId: input.turnId,
    iteration: input.iteration,
    requestedAt: new Date().toISOString(),
    agentSlug: input.agentSlug,
    requestDigest: createHash("sha256").update(serializedRequest).digest("hex"),
    requestBytes: UTF8_ENCODER.encode(serializedRequest).byteLength,
    capture: { status: "complete" },
    request,
    skills: skillsMetadata(input.resolvedSkills),
    toolRegistrations: advertisedToolsMetadata(input.toolRegistry, input.request.tools),
  };
}

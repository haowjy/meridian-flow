/** Builds the complete provider-neutral request record captured before dispatch. */
import { createHash } from "node:crypto";
import type {
  ModelRequestDebugRecord,
  ModelRequestDebugRequest,
} from "@meridian/contracts/threads";
import type { ResolvedSkill } from "../../packages/index.js";
import type { FunctionTool, GenerateRequest, Tool } from "../gateway/index.js";
import type { ToolRegistry } from "../tools/index.js";

function serializeCanonicalRequest(request: GenerateRequest): string {
  const { signal: _signal, correlation: _correlation, ...canonicalRequest } = request;
  const serialized = JSON.stringify(canonicalRequest);
  if (serialized === undefined) throw new Error("Model request debug capture expected an object");
  return serialized;
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

export type ModelRequestDebugCaptureInput = {
  gatewayCallId: string;
  threadId: string;
  turnId: string;
  iteration: number;
  agentSlug: string | null;
  request: GenerateRequest;
  resolvedSkills: ResolvedSkill[];
  toolRegistry: ToolRegistry;
};

export function buildModelRequestDebugRecord(
  input: ModelRequestDebugCaptureInput,
  maxRequestBytes: number,
): ModelRequestDebugRecord {
  const serializedRequest = serializeCanonicalRequest(input.request);
  const requestBytes = Buffer.byteLength(serializedRequest, "utf8");
  const request =
    requestBytes > maxRequestBytes
      ? null
      : (JSON.parse(serializedRequest) as ModelRequestDebugRequest);

  return {
    schema: "meridian.model-request-debug.v1",
    gatewayCallId: input.gatewayCallId,
    threadId: input.threadId,
    turnId: input.turnId,
    iteration: input.iteration,
    requestedAt: new Date().toISOString(),
    agentSlug: input.agentSlug,
    requestDigest: createHash("sha256").update(serializedRequest).digest("hex"),
    requestBytes,
    capture:
      request === null
        ? { status: "omitted", reason: "request_too_large", maxRequestBytes }
        : { status: "complete" },
    request,
    skills: skillsMetadata(input.resolvedSkills),
    toolRegistrations: advertisedToolsMetadata(input.toolRegistry, input.request.tools),
  };
}

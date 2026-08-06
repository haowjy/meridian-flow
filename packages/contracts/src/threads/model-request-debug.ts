/**
 * Purpose: shared dev-only model-request inspection contract and readable lens.
 * The canonical request is captured once by the server; UI and CLI project it
 * through the same pure functions so diagnostic evidence cannot drift.
 */
import type { JsonObject, JsonValue } from "./index.js";

export type ModelRequestDebugMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: JsonObject[];
  providerOptions?: JsonObject;
};

/** Provider-neutral GenerateRequest with signals and diagnostic correlation removed. */
export type ModelRequestDebugRequest = {
  model?: string;
  provider?: string;
  messages: ModelRequestDebugMessage[];
  tools?: JsonObject[];
  toolChoice?: JsonValue;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  responseFormat?: JsonObject;
  reasoning?: JsonValue;
  providerOptions?: JsonObject;
};

export type ModelRequestDebugCapture =
  | { status: "complete" }
  | { status: "omitted"; reason: "record_too_large"; maxRecordBytes: number };

/** One canonical request captured immediately before Gateway.stream(). */
export type ModelRequestDebugRecord = {
  schema: "meridian.model-request-debug.v1";
  gatewayCallId: string;
  threadId: string;
  /** Assistant turn the request belongs to. */
  turnId: string;
  /** 0-based tool-loop iteration within the turn. */
  iteration: number;
  /** ISO 8601 */
  requestedAt: string;
  /** thread.currentAgent at request time */
  agentSlug: string | null;
  /** SHA-256 of the complete canonical request, even when its body is omitted. */
  requestDigest: string;
  requestBytes: number;
  capture: ModelRequestDebugCapture;
  request: ModelRequestDebugRequest | null;
  skills: { slug: string; layer: string }[];
  toolRegistrations: { name: string; source: string; capability: string | null }[];
};

export type ModelRequestDebugRetention = {
  retainedRecords: number;
  retainedBytes: number;
  droppedRecords: number;
  droppedBytes: number;
};

export type ModelRequestPrefix = {
  status: "first" | "exact" | "changed" | "unavailable";
  previousRequestDigest: string | null;
  preservedMessageCount: number;
};

export type ModelRequestDebugView = {
  record: ModelRequestDebugRecord;
  prefix: ModelRequestPrefix;
  markdown: string;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function requestWithoutMessages(
  request: ModelRequestDebugRequest,
): Omit<ModelRequestDebugRequest, "messages"> {
  const { messages: _messages, ...rest } = request;
  return rest;
}

function prefixAgainst(
  current: ModelRequestDebugRecord,
  previous: ModelRequestDebugRecord | undefined,
): ModelRequestPrefix {
  if (!previous) {
    return {
      status: current.iteration === 0 ? "first" : "unavailable",
      previousRequestDigest: null,
      preservedMessageCount: 0,
    };
  }
  if (!current.request || !previous.request) {
    return {
      status: "unavailable",
      previousRequestDigest: previous.requestDigest,
      preservedMessageCount: 0,
    };
  }

  const staticRequestMatches =
    json(requestWithoutMessages(current.request)) ===
    json(requestWithoutMessages(previous.request));
  const enoughMessages = current.request.messages.length >= previous.request.messages.length;
  const messagesMatch =
    enoughMessages &&
    previous.request.messages.every(
      (message, index) => json(message) === json(current.request?.messages[index]),
    );

  return {
    status: staticRequestMatches && messagesMatch ? "exact" : "changed",
    previousRequestDigest: previous.requestDigest,
    preservedMessageCount: messagesMatch ? previous.request.messages.length : 0,
  };
}

function objectString(value: JsonObject, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function fencedJson(value: JsonValue): string {
  const body = JSON.stringify(value, null, 2);
  const longestRun = Math.max(0, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}json\n${body}\n${fence}`;
}

function readableMediaPart(part: JsonObject): JsonObject {
  const data = part.data;
  if (typeof data !== "string" || data.length <= 512) return part;
  return {
    ...part,
    data: `[${data.length} characters omitted from readable view; use the raw view for exact data]`,
  };
}

function readablePart(part: JsonObject, partIndex: number): string {
  const type = objectString(part, "type") ?? "unknown";
  if (type === "text") return objectString(part, "text") ?? "";
  if (type === "reasoning") {
    return `### Reasoning part ${partIndex}\n\n${objectString(part, "text") ?? ""}`;
  }
  if (type === "tool_use") {
    const toolName = objectString(part, "toolName") ?? "unknown tool";
    return `### Tool call: ${toolName}\n\n${fencedJson(part)}`;
  }
  if (type === "tool_result") {
    return `### Tool result\n\n${fencedJson(part)}`;
  }
  if (type === "image" || type === "file") {
    const mediaType = objectString(part, "mediaType") ?? "unknown media type";
    return `### ${type === "image" ? "Image" : "File"}\n\n${mediaType}\n\n${fencedJson(readableMediaPart(part))}`;
  }
  return `### ${type}\n\n${fencedJson(part)}`;
}

function readableRequest(record: ModelRequestDebugRecord, prefix: ModelRequestPrefix): string {
  const lines = [
    "# Model request",
    "",
    `- Gateway call: \`${record.gatewayCallId}\``,
    `- Turn: \`${record.turnId}\``,
    `- Iteration: ${record.iteration}`,
    `- Request digest: \`${record.requestDigest}\``,
    `- Request bytes: ${record.requestBytes}`,
    `- Previous request prefix: ${prefix.status}`,
  ];

  if (!record.request) {
    lines.push(
      "",
      `The canonical request exceeded the ${record.capture.status === "omitted" ? record.capture.maxRecordBytes : "configured"}-byte capture limit. Metadata and digest were retained.`,
    );
    return lines.join("\n");
  }

  record.request.messages.forEach((message, messageIndex) => {
    lines.push("", "---", "", `## Message ${messageIndex}: ${message.role}`);
    message.content.forEach((part, partIndex) => {
      lines.push("", readablePart(part, partIndex));
    });
  });

  if (record.request.tools?.length) {
    lines.push("", "---", "", "## Advertised tools");
    for (const tool of record.request.tools) {
      const name = objectString(tool, "name") ?? objectString(tool, "kind") ?? "unknown";
      lines.push("", `### ${name}`, "", fencedJson(tool));
    }
  }

  return lines.join("\n");
}

/**
 * Derive cache-prefix evidence and a readable Markdown lens from ordered records.
 * Prefix comparison resets at each assistant turn.
 */
export function deriveModelRequestDebugViews(
  records: readonly ModelRequestDebugRecord[],
): ModelRequestDebugView[] {
  const previousByTurn = new Map<string, ModelRequestDebugRecord>();
  return records.map((record) => {
    const prefix = prefixAgainst(record, previousByTurn.get(record.turnId));
    previousByTurn.set(record.turnId, record);
    return { record, prefix, markdown: readableRequest(record, prefix) };
  });
}

type AssertJsonValue<T extends JsonValue> = T;
type _ModelRequestDebugRecordIsJsonValue = AssertJsonValue<ModelRequestDebugRecord>;
type _ModelRequestDebugRetentionIsJsonValue = AssertJsonValue<ModelRequestDebugRetention>;

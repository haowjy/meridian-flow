/**
 * Purpose: shared dev-only model-request inspection contract and readable lens.
 * The canonical request is captured once by the server; UI and CLI project it
 * through the same pure functions so diagnostic evidence cannot drift.
 */
import type { JsonObject, JsonValue } from "./index.js";

const MAX_READABLE_PART_BYTES = 32 * 1024;
const MAX_READABLE_LABEL_BYTES = 256;

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
  | { status: "omitted"; reason: "request_too_large"; maxRequestBytes: number };

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
};

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index] as JsonValue))
    );
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) && jsonEqual(left[key] as JsonValue, right[key] as JsonValue),
    )
  );
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
  if (current.iteration === 0) {
    return {
      status: "first",
      previousRequestDigest: null,
      preservedMessageCount: 0,
    };
  }
  if (!previous || previous.iteration + 1 !== current.iteration) {
    return {
      status: "unavailable",
      previousRequestDigest: previous?.requestDigest ?? null,
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

  const staticRequestMatches = jsonEqual(
    requestWithoutMessages(current.request),
    requestWithoutMessages(previous.request),
  );
  const enoughMessages = current.request.messages.length >= previous.request.messages.length;
  const messagesMatch =
    enoughMessages &&
    previous.request.messages.every((message, index) =>
      jsonEqual(message, current.request?.messages[index] as JsonValue),
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safePrefix(value: string, length: number): string {
  const end =
    length > 0 && length < value.length && /[\uD800-\uDBFF]/.test(value[length - 1] ?? "")
      ? length - 1
      : length;
  return value.slice(0, end);
}

function boundedReadablePart(
  source: string,
  render: (visible: string, omittedBytes: number) => string,
): string {
  const complete = render(source, 0);
  if (utf8Bytes(complete) <= MAX_READABLE_PART_BYTES) return complete;

  const sourceBytes = utf8Bytes(source);
  let low = 0;
  let high = source.length;
  let best = render("", sourceBytes);
  if (utf8Bytes(best) > MAX_READABLE_PART_BYTES) {
    return "[Readable part omitted because its framing exceeds the display limit; use the raw view for exact data]";
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const visible = safePrefix(source, middle);
    const candidate = render(visible, sourceBytes - utf8Bytes(visible));
    if (utf8Bytes(candidate) <= MAX_READABLE_PART_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function readableLabel(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const source = normalized || fallback;

  const inlineCode = (label: string): string => {
    let longestRun = 0;
    for (const match of label.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
    const fence = "`".repeat(longestRun + 1);
    return `${fence} ${label} ${fence}`;
  };

  let label = "";
  let truncated = false;
  for (const character of source) {
    if (utf8Bytes(inlineCode(`${label}${character}…`)) > MAX_READABLE_LABEL_BYTES) {
      truncated = true;
      break;
    }
    label += character;
  }
  return inlineCode(truncated ? `${label}…` : label);
}

function fencedBody(body: string): string {
  let longestRun = 0;
  for (const match of body.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}json\n${body}\n${fence}`;
}

function fencedJson(value: JsonValue, heading = ""): string {
  const exactBody = JSON.stringify(value, null, 2);
  return boundedReadablePart(exactBody, (visible, omittedBytes) => {
    const body = omittedBytes
      ? `${visible}\n[${omittedBytes} bytes omitted from readable view; use the raw view for exact data]`
      : visible;
    return `${heading}${fencedBody(body)}`;
  });
}

function blockquote(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function quotedMarkdown(value: string, heading = ""): string {
  return boundedReadablePart(value, (visible, omittedBytes) => {
    const body = omittedBytes
      ? `${visible}\n\n[${omittedBytes} bytes omitted from readable view; use the raw view for exact text]`
      : visible;
    return `${heading}${blockquote(body)}`;
  });
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
  if (type === "text") return quotedMarkdown(objectString(part, "text") ?? "");
  if (type === "reasoning") {
    return quotedMarkdown(objectString(part, "text") ?? "", `### Reasoning part ${partIndex}\n\n`);
  }
  if (type === "tool_use") {
    const toolName = readableLabel(objectString(part, "toolName") ?? "", "unknown tool");
    return fencedJson(part, `### Tool call: ${toolName}\n\n`);
  }
  if (type === "tool_result") {
    return fencedJson(part, "### Tool result\n\n");
  }
  if (type === "image" || type === "file") {
    const mediaType = readableLabel(objectString(part, "mediaType") ?? "", "unknown media type");
    return fencedJson(
      readableMediaPart(part),
      `### ${type === "image" ? "Image" : "File"}\n\n${mediaType}\n\n`,
    );
  }
  return fencedJson(part, `### ${readableLabel(type, "unknown")}\n\n`);
}

export function renderModelRequestDebugMarkdown(view: ModelRequestDebugView): string {
  const { record, prefix } = view;
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
      `The canonical request exceeded the ${record.capture.status === "omitted" ? record.capture.maxRequestBytes : "configured"}-byte capture limit. Metadata and digest were retained.`,
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
      const name = readableLabel(
        objectString(tool, "name") ?? objectString(tool, "kind") ?? "",
        "unknown",
      );
      lines.push("", fencedJson(tool, `### ${name}\n\n`));
    }
  }

  return lines.join("\n");
}

/**
 * Derive cache-prefix evidence from ordered records.
 * Prefix comparison resets at each assistant turn.
 */
export function deriveModelRequestDebugViews(
  records: readonly ModelRequestDebugRecord[],
): ModelRequestDebugView[] {
  const previousByTurn = new Map<string, ModelRequestDebugRecord>();
  return records.map((record) => {
    const prefix = prefixAgainst(record, previousByTurn.get(record.turnId));
    previousByTurn.set(record.turnId, record);
    return { record, prefix };
  });
}

type AssertJsonValue<T extends JsonValue> = T;
type _ModelRequestDebugRecordIsJsonValue = AssertJsonValue<ModelRequestDebugRecord>;
type _ModelRequestDebugRetentionIsJsonValue = AssertJsonValue<ModelRequestDebugRetention>;

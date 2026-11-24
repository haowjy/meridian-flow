import type { UserId } from "@meridian/contracts";
import type {
  McpBakedConnection,
  McpCallOutcome,
  McpCallResult,
  McpDescribedItem,
  McpDescribeResult,
  McpFailureCode,
} from "@meridian/contracts/mcp";
import type { JsonObject, StoredMediaPart } from "@meridian/contracts/threads";
import {
  type CallOutcome,
  describeTool,
  type McpClient,
  type PinnedTool,
  toContent,
} from "@meridian-flow/runtime/mcp";
import type { CallStore, RecordedCall } from "../ports/call-store.js";
import type { ConnectionStore } from "../ports/connection-store.js";
import { answeredStatus, callLine, capLines, cut, textOf } from "./call-list.js";
import { connectionCatalogue, toolId } from "./connection-bake.js";
import type { McpConnections } from "./connection-service.js";

export const REPLY_CHARACTER_LIMIT = 24_000;
export const DO_NOT_REPEAT =
  "These calls ran and are not undone. Do not repeat answered calls: their effects already happened. Continue only with calls that failed or have not yet run.";
const CALL_TIMEOUT_MS = 60_000;

export interface ReplyStore {
  put(
    threadId: string,
    name: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ key: string }>;
  get(key: string): Promise<Uint8Array>;
}

export interface ConnectionToolsDeps {
  store: Pick<ConnectionStore, "find" | "findPin">;
  calls: CallStore;
  client: McpClient;
  service: Pick<McpConnections, "serverFor" | "checks">;
  replies: ReplyStore;
  warn(what: string, cause: unknown): void;
  now?: () => Date;
}

export interface CallRequest {
  thread: { id: string; userId: UserId };
  bake: { bakedConnections: readonly McpBakedConnection[] };
  id: string;
  arguments: JsonObject;
  signal: AbortSignal;
  opened?: (recordId: string) => void;
  origin: { turnId: string; modelResponseId: string; toolCallId: string; sequence: number };
}

export type ConnectionCall =
  | {
      kind: "refused";
      code: "unknown_tool" | "connection_removed";
      connection: string | null;
      tool: string | null;
    }
  | {
      kind: "called";
      connection: string;
      tool: PinnedTool;
      recordId: string;
      outcome: CallOutcome;
    };

const splitId = (id: string): { connection: string; tool: string } | null => {
  const at = id.indexOf("/");
  return at > 0 && at < id.length - 1
    ? { connection: id.slice(0, at), tool: id.slice(at + 1) }
    : null;
};

export function outcomeOf(outcome: CallOutcome): McpCallOutcome {
  switch (outcome.kind) {
    case "answered":
      return outcome.isError ? "tool_error" : "answered";
    case "unreachable":
      return outcome.reason === "unauthorized" ? "unauthorized" : "unreachable";
    default:
      return outcome.kind;
  }
}

export function createConnectionTools(deps: ConnectionToolsDeps) {
  const now = deps.now ?? (() => new Date());

  async function callConnectionTool(request: CallRequest): Promise<ConnectionCall> {
    const parts = splitId(request.id);
    const held = parts
      ? request.bake.bakedConnections.find((connection) => connection.name === parts.connection)
      : undefined;
    const pin = held ? await deps.store.findPin(held.pinId) : null;
    const tool = parts ? pin?.pin.tools.find((candidate) => candidate.name === parts.tool) : null;
    if (!parts || !held || !tool)
      return {
        kind: "refused",
        code: "unknown_tool",
        connection: held?.name ?? null,
        tool: null,
      };
    const stored = await deps.store.find(request.thread.userId, held.connectionId);
    if (!stored || stored.row.deletedAt)
      return {
        kind: "refused",
        code: "connection_removed",
        connection: held.name,
        tool: tool.name,
      };
    const loaded = await deps.service.serverFor(stored.row);
    const startedAt = now();
    const recordId = await deps.calls.open({
      threadId: request.thread.id,
      ...request.origin,
      connectionId: held.connectionId,
      pinId: held.pinId,
      toolName: tool.name,
      arguments: request.arguments,
    });
    request.opened?.(recordId);
    const outcome: CallOutcome =
      "problem" in loaded
        ? {
            kind: "unreachable",
            reason: "unauthorized",
            message: "The saved token could not be read.",
            sent: false,
            ms: 0,
          }
        : await deps.client.call(
            loaded.server,
            { tool, arguments: request.arguments },
            { signal: request.signal, timeoutMs: CALL_TIMEOUT_MS },
          );
    // keep: After a call answers, no later step may throw before the model receives its outcome
    const replyRef =
      outcome.kind === "answered" || outcome.kind === "rejected"
        ? await keepReply(request.thread.id, recordId, outcome.reply)
        : null;
    await bestEffort("complete the call record", () =>
      deps.calls.complete(recordId, {
        outcomeKind: outcomeOf(outcome),
        replyRef,
        finishedAt: now(),
      }),
    );
    await bestEffort("record the call for the connection's status", () =>
      deps.service.checks.recordCall(stored.row, { startedAt, loaded }, outcome),
    );
    return { kind: "called", connection: held.name, tool, recordId, outcome };
  }

  async function bestEffort(what: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (cause) {
      deps.warn(what, cause);
    }
  }

  async function keepReply(
    threadId: string,
    recordId: string,
    reply: JsonObject,
  ): Promise<JsonObject> {
    const bytes = new TextEncoder().encode(JSON.stringify(reply));
    try {
      const { key } = await deps.replies.put(
        threadId,
        `${recordId}.json`,
        bytes,
        "application/json",
      );
      return { key, bytes: bytes.byteLength };
    } catch (cause) {
      deps.warn("keep the reply", cause);
      return { notKept: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async function mcpCall(
    request: CallRequest,
  ): Promise<{ result: McpCallResult; isError: boolean }> {
    const call = await callConnectionTool(request);
    return shapeCall(request, call, {
      schema: true,
      reply: (recordId, reply) => shapeReply(request.thread.id, recordId, reply),
    });
  }

  async function shapeCall(
    request: Pick<CallRequest, "id" | "arguments" | "bake">,
    call: ConnectionCall,
    how: {
      schema: boolean;
      reply: (recordId: string, reply: JsonObject) => Promise<NonNullable<McpCallResult["reply"]>>;
    },
  ): Promise<{ result: McpCallResult; isError: boolean }> {
    const base = { id: request.id, arguments: request.arguments };
    if (call.kind === "refused")
      return {
        isError: true,
        result: {
          ...base,
          connection: call.connection,
          tool: call.tool,
          outcome: call.code,
          recordId: null,
          code: `mcp_${call.code}`,
          message:
            call.code === "connection_removed"
              ? `The connection ${call.connection} was removed, so ${request.id} cannot be called. Tell the writer.`
              : `This chat holds no tool ${JSON.stringify(request.id)}. ${await heldIds(request)}`,
        },
      };
    const { outcome, connection, tool, recordId } = call;
    const named = { ...base, connection, tool: tool.name, recordId };
    const kind = outcomeOf(outcome);
    const failure = (message: string, reply?: McpCallResult["reply"]): McpCallResult => ({
      ...named,
      outcome: kind,
      code: `mcp_${kind}` as McpFailureCode,
      message,
      ms: outcome.ms,
      ...(reply ? { reply } : {}),
    });
    const schema = how.schema ? { schema: describeTool(request.id, tool) } : {};
    switch (outcome.kind) {
      case "answered": {
        const reply = await how.reply(recordId, outcome.reply);
        return outcome.isError
          ? {
              isError: true,
              result: { ...failure("The tool reported a problem.", reply), ...schema },
            }
          : {
              isError: false,
              result: {
                ...named,
                outcome: "answered",
                ms: outcome.ms,
                reply,
              },
            };
      }
      case "rejected": {
        const message = `The server refused the request: ${outcome.message}`;
        return {
          isError: true,
          result: { ...failure(message, { text: message, cut: false }), ...schema },
        };
      }
      case "too_large":
        return {
          isError: true,
          result: failure(
            `The reply was over ${outcome.limit} bytes (${outcome.bytes} read), so it was not kept. Ask for less: a narrower query or fewer results.`,
          ),
        };
      case "aborted":
        return {
          isError: true,
          result: failure(
            outcome.sent
              ? "The call was cancelled after it was sent, so it may have run."
              : "The call was cancelled before it was sent.",
          ),
        };
      case "unreachable":
        return { isError: true, result: failure(unreachableMessage(connection, outcome)) };
    }
  }

  async function shapeReply(
    threadId: string,
    recordId: string,
    reply: JsonObject,
  ): Promise<NonNullable<McpCallResult["reply"]>> {
    const parts = toContent(reply);
    const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const cut = text.length > REPLY_CHARACTER_LIMIT;
    const media: StoredMediaPart[] = [];
    let lost = 0;
    for (const part of parts) {
      if (part.type !== "media") continue;
      const index = media.length;
      const bytes = Buffer.from(part.source.data, "base64");
      let key: string;
      try {
        ({ key } = await deps.replies.put(threadId, `${recordId}-${index}`, bytes, part.mediaType));
      } catch (cause) {
        deps.warn("keep a reply picture", cause);
        lost++;
        continue;
      }
      media.push({
        type: "media",
        ref: { documentId: recordId, uri: `mcp-call://${recordId}/${index}` },
        mediaType: part.mediaType,
        sizeBytes: bytes.byteLength,
        name: `reply-${index + 1}`,
        chatCopy: { key },
      });
    }
    const shown = cut
      ? `${text.slice(0, REPLY_CHARACTER_LIMIT)}\n\n[Reply cut: ${REPLY_CHARACTER_LIMIT} of ${text.length} characters shown. Ask for less: a narrower query or fewer results.]`
      : text;
    return {
      text: lost
        ? `${shown}\n\n[${lost} picture${lost === 1 ? "" : "s"} in the reply could not be kept, so ${lost === 1 ? "it is" : "they are"} not shown.]`
        : shown,
      cut,
      ...(media.length ? { media } : {}),
    };
  }

  async function heldIds(request: Pick<CallRequest, "bake">): Promise<string> {
    const lines = await catalogueLines(request.bake.bakedConnections);
    return lines.length
      ? `The tools it holds: ${lines.join(", ")}. A tool is called by its id, <connection>/<tool>.`
      : "It holds no connection tools.";
  }

  async function catalogueLines(baked: readonly McpBakedConnection[]): Promise<string[]> {
    const pins = await Promise.all(baked.map((connection) => deps.store.findPin(connection.pinId)));
    return baked.flatMap((connection, index) =>
      (pins[index]?.pin.tools ?? []).map((tool) => toolId(connection.name, tool.name)),
    );
  }

  async function describe(request: {
    bake: { bakedConnections: readonly McpBakedConnection[] };
    names: readonly string[];
  }): Promise<{ result: McpDescribeResult; isError: boolean }> {
    const items: McpDescribedItem[] = [];
    const texts: string[] = [];
    for (const name of request.names) {
      const parts = splitId(name);
      const held = request.bake.bakedConnections.find(
        (connection) => connection.name === (parts ? parts.connection : name),
      );
      const pin = held ? await deps.store.findPin(held.pinId) : null;
      const tool = parts ? pin?.pin.tools.find((candidate) => candidate.name === parts.tool) : null;
      if (held && pin && parts && tool) {
        items.push({ name, kind: "tool", connection: held.name, tool: tool.name });
        texts.push(describeTool(name, tool));
      } else if (held && pin && !parts) {
        items.push({
          name,
          kind: "connection",
          connection: held.name,
          tool: null,
          tools: pin.pin.tools.map((candidate) => candidate.name),
        });
        texts.push(connectionCatalogue(held.name, pin.pin) || `${name} has no tools.`);
      } else {
        items.push({ name, kind: "unknown", connection: held?.name ?? null, tool: null });
        texts.push(
          `This chat holds no ${parts ? "tool" : "connection"} ${JSON.stringify(name)}. ${await heldIds(request)}`,
        );
      }
    }
    return {
      isError: items.some((item) => item.kind === "unknown"),
      result: { items, text: texts.join("\n\n---\n\n") },
    };
  }

  async function recordedCalls(
    threadId: string,
    turnIds: readonly string[],
    baked: readonly McpBakedConnection[],
  ) {
    const calls = await deps.calls.listForTurns(threadId, turnIds);
    const lines = await Promise.all(
      calls.map(async (call) => {
        const connection = baked.find((held) => held.connectionId === call.connectionId)?.name;
        const id = connection ? toolId(connection, call.toolName) : call.toolName;
        return callLine(id, call.arguments, await endOf(call));
      }),
    );
    const byStub = new Map<string, { turnId: string; toolCallId: string; lines: string[] }>();
    calls.forEach((call, index) => {
      const key = `${call.turnId}\u0000${call.toolCallId}`;
      const stub = byStub.get(key) ?? {
        turnId: call.turnId,
        toolCallId: call.toolCallId,
        lines: [],
      };
      stub.lines.push(`- ${lines[index]}`);
      byStub.set(key, stub);
    });
    return [...byStub.values()].flatMap(({ turnId, toolCallId, lines }) =>
      capLines(lines).map((line) => ({ turnId, toolCallId, line })),
    );
  }

  async function endOf(call: RecordedCall): Promise<string> {
    if (!call.outcomeKind) return "sent, and its end was not recorded, so it may have run";
    if (!call.reply) return call.outcomeKind;
    if ("notKept" in call.reply) return `${call.outcomeKind}; its reply was not kept`;
    try {
      const reply = JSON.parse(new TextDecoder().decode(await deps.replies.get(call.reply.key)));
      return call.outcomeKind === "answered"
        ? answeredStatus(textOf(reply))
        : `${call.outcomeKind}: ${cut(textOf(reply))}`;
    } catch (cause) {
      deps.warn("read a kept reply", cause);
      return `${call.outcomeKind}; its reply was kept but could not be read`;
    }
  }

  return { callConnectionTool, mcpCall, shapeCall, describe, recordedCalls };
}

export type ConnectionTools = ReturnType<typeof createConnectionTools>;

function unreachableMessage(
  connection: string,
  outcome: Extract<CallOutcome, { kind: "unreachable" }>,
): string {
  const may = outcome.sent ? " The call may have run." : "";
  switch (outcome.reason) {
    case "start_failed":
    case "connect_timeout":
    case "disconnected":
      return `${connection} could not be reached (${outcome.message}). Calling it again now will not help: tell the writer.${may}`;
    case "call_timeout":
      return `${connection} did not answer in time.${may}`;
    case "unauthorized":
      return `${connection} refused its token (HTTP 401). The writer has to sign in to it again in Settings, under Connections.`;
    case "forbidden":
      return `${connection} refused the request (HTTP 403).${may}`;
    case "rate_limited":
      return `${connection} is limiting requests (HTTP 429).${may}`;
    case "server_error":
      return `${connection} returned an error${outcome.httpStatus ? ` (HTTP ${outcome.httpStatus})` : ""}.${may}`;
    case "bad_reply":
      return `${connection} answered with something that is not MCP.${may}`;
  }
}

/**
 * What the two connection tools do. `callConnectionTool` is the one function that calls a
 * connection's tool: it finds the pinned tool through the bake, writes the call's record before
 * the client is called and completes it after, and keeps the full reply. It never runs inside
 * another transaction (the record has to be there the moment the call leaves), so a caller
 * holds none. `mcp_call` shapes its outcome for the model; `mcp_run` will shape the same
 * outcome for a script.
 */
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
import type { CallStore } from "../ports/call-store.js";
import type { ConnectionStore } from "../ports/connection-store.js";
import { connectionCatalogue, toolId } from "./connection-bake.js";
import type { McpConnections } from "./connection-service.js";

/** Characters of a reply the model reads; the full reply stays in the call's record. */
export const REPLY_CHARACTER_LIMIT = 24_000;
/** One call's limit, passed to the client: a slow server is `call_timeout`, never also the executor's timeout. */
const CALL_TIMEOUT_MS = 60_000;

/** Where a call's full reply and its media are kept: the chat's own storage, which goes with the chat. */
export interface ReplyStore {
  put(
    threadId: string,
    name: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ key: string }>;
}

export interface ConnectionToolsDeps {
  store: Pick<ConnectionStore, "find" | "findPin">;
  calls: CallStore;
  client: McpClient;
  service: Pick<McpConnections, "serverFor" | "checks">;
  replies: ReplyStore;
  now?: () => Date;
}

export interface CallRequest {
  thread: { id: string; userId: UserId };
  bake: { bakedConnections: readonly McpBakedConnection[] };
  /** What the model sent: `<connection>/<tool>`. */
  id: string;
  arguments: JsonObject;
  signal: AbortSignal;
  /** Called once the call's record is written, as the call leaves. */
  opened?: (recordId: string) => void;
  /** Which tool call made this one: `mcp_call` is sequence 0, a script's calls count up from 0. */
  origin: { turnId: string; modelResponseId: string; toolCallId: string; sequence: number };
}

export type ConnectionCall =
  /** Made without calling the server: the chat holds no such tool, or its connection is gone. */
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

/** The first `/` splits a tool id: connection names hold no `/`. */
const splitId = (id: string): { connection: string; tool: string } | null => {
  const at = id.indexOf("/");
  return at > 0 && at < id.length - 1
    ? { connection: id.slice(0, at), tool: id.slice(at + 1) }
    : null;
};

/** The one word for how a call ended, stored in the record and carried on the typed result. */
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
    // A token that no longer opens is a sign-in problem the check reports; no call leaves.
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
    const replyRef =
      outcome.kind === "answered" || outcome.kind === "rejected"
        ? await keepReply(request.thread.id, recordId, outcome.reply)
        : null;
    await deps.calls.complete(recordId, {
      outcomeKind: outcomeOf(outcome),
      replyRef,
      finishedAt: now(),
    });
    await deps.service.checks.recordCall(stored.row, { startedAt }, outcome);
    return { kind: "called", connection: held.name, tool, recordId, outcome };
  }

  async function keepReply(threadId: string, recordId: string, reply: JsonObject) {
    const bytes = new TextEncoder().encode(JSON.stringify(reply));
    const { key } = await deps.replies.put(threadId, `${recordId}.json`, bytes, "application/json");
    return { key, bytes: bytes.byteLength };
  }

  /** `mcp_call`: the call, shaped for the model and for the app's row. */
  async function mcpCall(
    request: CallRequest,
  ): Promise<{ result: McpCallResult; isError: boolean }> {
    const call = await callConnectionTool(request);
    return shapeCall(request, call, {
      schema: true,
      reply: (recordId, reply) => shapeReply(request.thread.id, recordId, reply),
    });
  }

  /**
   * One call's outcome as the typed result both tools carry. `reply` shapes an answered call's
   * reply (`mcp_call` stores its pictures, a script leaves them out); `schema` sets the tool's
   * schema on a failed call, which `mcp_call` follows its words with and a script's failure text
   * gives once per tool.
   */
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
    // The tool's schema follows a failed call's words for the model; the row shows the server's reply alone.
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

  /** What the model reads of a reply: its text, cut to the limit, and its pictures as stored media. */
  async function shapeReply(
    threadId: string,
    recordId: string,
    reply: JsonObject,
  ): Promise<NonNullable<McpCallResult["reply"]>> {
    const parts = toContent(reply);
    const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const cut = text.length > REPLY_CHARACTER_LIMIT;
    const media: StoredMediaPart[] = [];
    for (const part of parts) {
      if (part.type !== "media") continue;
      const index = media.length;
      const bytes = Buffer.from(part.source.data, "base64");
      const { key } = await deps.replies.put(
        threadId,
        `${recordId}-${index}`,
        bytes,
        part.mediaType,
      );
      media.push({
        type: "media",
        ref: { documentId: recordId, uri: `mcp-call://${recordId}/${index}` },
        mediaType: part.mediaType,
        sizeBytes: bytes.byteLength,
        name: `reply-${index + 1}`,
        chatCopy: { key },
      });
    }
    return {
      text: cut
        ? `${text.slice(0, REPLY_CHARACTER_LIMIT)}\n\n[Reply cut: ${REPLY_CHARACTER_LIMIT} of ${text.length} characters shown. Ask for less: a narrower query or fewer results.]`
        : text,
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

  /** `mcp_describe`: each name is a tool id (its description and schema) or a connection (its tools), from the pins the chat holds. Never calls a server. */
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

  /** One line for each recorded call of these turns: what was sent and how far it got. */
  async function recordedCalls(threadId: string, turnIds: readonly string[]) {
    return (await deps.calls.listForTurns(threadId, turnIds)).map((call) => {
      const sent = JSON.stringify(call.arguments);
      const arguments_ = sent.length > 300 ? `${sent.slice(0, 300)}…` : sent;
      const ended = call.outcomeKind
        ? `ended as ${call.outcomeKind}, but its result was not stored`
        : "sent, and its end was not recorded, so it may have run";
      return {
        turnId: call.turnId,
        toolCallId: call.toolCallId,
        line: `- ${call.toolName} with ${arguments_}: ${ended}`,
      };
    });
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

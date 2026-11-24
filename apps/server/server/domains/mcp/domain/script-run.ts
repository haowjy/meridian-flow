import type { UserId } from "@meridian/contracts";
import type { McpBakedConnection, McpRunResult, McpScriptCall } from "@meridian/contracts/mcp";
import type { JsonObject } from "@meridian/contracts/threads";
import { describeTool, toContent } from "@meridian-flow/runtime/mcp";
import {
  type HostFunction,
  HostFunctionError,
  type Json,
  type ScriptResult,
  type ScriptRunner,
} from "@meridian-flow/runtime/script";
import { answeredStatus, callLine, capLines, cut, textOf } from "./call-list.js";
import { type ConnectionCall, type ConnectionTools, DO_NOT_REPEAT } from "./connection-tools.js";
import { createLimiter, type Limiter } from "./limiter.js";
import { prepareScript } from "./script-code.js";

export const SCRIPT_LIMITS = {
  wallMs: 60_000,
  cpuMs: 2_000,
  maxCalls: 50,
  maxCallBytes: 1_000_000,
  maxValueBytes: 64_000,
  maxLogBytes: 8_000,
  inFlight: 8,
  replyBytes: 2_000_000,
  totalReplyBytes: 8_000_000,
  scriptsPerAccount: 2,
};
export type ScriptLimits = typeof SCRIPT_LIMITS;

const REJECTION_CHARS = 8_192;
const ROW_ARGUMENT_BYTES = 2_000;
const ROW_REPLY_CHARS = 1_000;

const MEDIA_LEFT_OUT = (count: number) =>
  `[${count} picture or audio part${count === 1 ? "" : "s"} left out of a script's reply. Call this tool with mcp_call to see ${count === 1 ? "it" : "them"}.]`;

export interface ScriptRunRequest {
  thread: { id: string; userId: UserId };
  bake: { bakedConnections: readonly McpBakedConnection[] };
  code: string;
  signal: AbortSignal;
  origin: { turnId: string; modelResponseId: string; toolCallId: string };
  emit(event: { sequence: number; id: string; arguments: JsonObject; call?: McpScriptCall }): void;
}

const mediaCount = (reply: JsonObject) =>
  toContent(reply).filter((part) => part.type === "media").length;

function scriptValue(reply: JsonObject): Json {
  const media = mediaCount(reply);
  if (media) return `${textOf(reply)}\n${MEDIA_LEFT_OUT(media)}`.trim();
  const structured = reply.structuredContent;
  if (structured && typeof structured === "object") return structured as Json;
  const text = textOf(reply);
  if (!/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

export function createScriptRuns(deps: {
  runner: ScriptRunner;
  tools: Pick<ConnectionTools, "callConnectionTool" | "shapeCall">;
  limits?: ScriptLimits;
}) {
  const limits = deps.limits ?? SCRIPT_LIMITS;
  const accounts = new Map<string, Limiter>();

  async function run(
    request: ScriptRunRequest,
  ): Promise<{ result: McpRunResult; isError: boolean }> {
    const prepared = prepareScript(request.code);
    if (!prepared.ok) return finish({ ended: "rejected_code", error: prepared.error, calls: [] });

    const gate = accounts.get(request.thread.userId) ?? createLimiter(limits.scriptsPerAccount);
    accounts.set(request.thread.userId, gate);
    try {
      return await gate.run(() => runScript(request, prepared.code), request.signal);
    } catch (cause) {
      if (request.signal.aborted) return finish({ ended: "aborted", calls: [] });
      throw cause;
    } finally {
      if (gate.idle) accounts.delete(request.thread.userId);
    }
  }

  async function runScript(request: ScriptRunRequest, code: string) {
    const inFlight = createLimiter(limits.inFlight);
    const calls = new Map<number, McpScriptCall>();
    const pending = new Set<Promise<unknown>>();
    const schemas = new Map<string, string>();
    let sequence = 0;
    let replyBytes = 0;

    const hostCall: HostFunction = async ([id, args], signal) => {
      if (typeof id !== "string" || !id)
        throw new HostFunctionError(
          'call needs the tool id first: call("<connection>/<tool>", { ...arguments })',
          { kind: "bad_arguments" },
        );
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args)))
        throw new HostFunctionError(`The arguments of ${id} must be an object.`, {
          kind: "bad_arguments",
          tool: id,
        });
      const sent = (args ?? {}) as JsonObject;
      const mine = sequence++;
      const settled = inFlight.run(async () => {
        const call = await deps.tools.callConnectionTool({
          thread: request.thread,
          bake: request.bake,
          id,
          arguments: sent,
          signal,
          origin: { ...request.origin, sequence: mine },
          opened: () => request.emit({ sequence: mine, id, arguments: sent }),
        });
        return conclude(call, mine, id, sent);
      }, signal);
      pending.add(settled);
      settled.then(
        () => pending.delete(settled),
        () => pending.delete(settled),
      );
      return settled;
    };

    async function conclude(call: ConnectionCall, mine: number, id: string, sent: JsonObject) {
      const shaped = await deps.tools.shapeCall({ id, arguments: sent, bake: request.bake }, call, {
        schema: false,
        reply: async (_recordId, reply) => {
          const text = textOf(reply);
          return { text: cut(text, ROW_REPLY_CHARS), cut: text.length > ROW_REPLY_CHARS };
        },
      });
      let { result } = shaped;
      let value: Json = null;
      let tooLarge: string | null = null;
      if (call.kind === "called" && call.outcome.kind === "answered" && !call.outcome.isError) {
        value = scriptValue(call.outcome.reply);
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (bytes > limits.replyBytes || replyBytes + bytes > limits.totalReplyBytes) {
          tooLarge = `The reply was ${bytes} bytes, over what a script may take in (${limits.replyBytes} bytes a reply, ${limits.totalReplyBytes} bytes in all). Ask for less: a narrower query or fewer results.`;
          result = { ...result, outcome: "too_large", code: "mcp_too_large", message: tooLarge };
        } else replyBytes += bytes;
      }
      if (
        call.kind === "called" &&
        (result.outcome === "tool_error" || result.outcome === "rejected")
      )
        schemas.set(id, describeTool(id, call.tool));
      const row: McpScriptCall = {
        ...result,
        arguments: rowArguments(sent),
        sequence: mine,
      };
      calls.set(mine, row);
      request.emit({ sequence: mine, id, arguments: row.arguments, call: row });
      if (tooLarge || shaped.isError)
        throw new HostFunctionError(
          cut(
            tooLarge ??
              (result.outcome === "tool_error" ? (result.reply?.text ?? "") : result.message) ??
              "",
            REJECTION_CHARS,
          ),
          { kind: result.outcome, tool: id },
        );
      return value;
    }

    const ran = await deps.runner.run(
      {
        code,
        globals: { call: hostCall },
        wallMs: limits.wallMs,
        cpuMs: limits.cpuMs,
        maxCalls: limits.maxCalls,
        maxCallBytes: limits.maxCallBytes,
        maxValueBytes: limits.maxValueBytes,
        maxLogBytes: limits.maxLogBytes,
      },
      request.signal,
    );
    await Promise.allSettled([...pending]);
    return finish(
      resultOf(
        ran,
        [...calls.values()].sort((a, b) => a.sequence - b.sequence),
        code,
      ),
      schemas,
    );
  }

  function resultOf(
    ran: ScriptResult,
    calls: McpScriptCall[],
    code: string,
  ): Omit<McpRunResult, "text"> {
    const logs = ran.logs.text || ran.logs.cutBytes ? { logs: ran.logs } : {};
    const base = { calls, ...logs };
    switch (ran.kind) {
      case "returned":
        return ran.value === null && !/\breturn\b/.test(code)
          ? { ended: "returned", ...base }
          : { ended: "returned", value: ran.value, ...base };
      case "threw":
        return {
          ended: "threw",
          error: {
            name: ran.name,
            message: ran.message,
            ...(ran.line !== undefined ? { line: ran.line } : {}),
            ...(ran.column !== undefined ? { column: ran.column } : {}),
          },
          ...base,
        };
      case "timed_out":
        return {
          ended: "timed_out",
          limit: ran.limit,
          limitMs: ran.limit === "cpu" ? limits.cpuMs : limits.wallMs,
          ...base,
        };
      case "too_large":
        return { ended: "too_large", bytes: ran.bytes, ...base };
      case "aborted":
        return { ended: "aborted", ...base };
      case "unavailable":
        return {
          ended: "unavailable",
          error: { name: "ScriptUnavailable", message: ran.message },
          ...base,
        };
    }
  }

  function finish(
    typed: Omit<McpRunResult, "text">,
    schemas: ReadonlyMap<string, string> = new Map(),
  ): { result: McpRunResult; isError: boolean } {
    return {
      isError: typed.ended !== "returned",
      result: { ...typed, text: modelText(typed, schemas) },
    };
  }

  function modelText(typed: Omit<McpRunResult, "text">, schemas: ReadonlyMap<string, string>) {
    const sections = [headline(typed), callList(typed), ...schemas.values()];
    if (typed.logs?.text)
      sections.push(
        `Logs${typed.logs.cutBytes ? ` (${typed.logs.cutBytes} bytes cut from the middle)` : ""}:\n${typed.logs.text}`,
      );
    return sections.filter(Boolean).join("\n\n");
  }

  function headline(typed: Omit<McpRunResult, "text">): string {
    const at = typed.error?.line !== undefined ? ` (line ${typed.error.line})` : "";
    const none = typed.calls.length ? "" : " No call had been made.";
    switch (typed.ended) {
      case "returned":
        return typed.value === undefined
          ? "The script returned nothing. End it with `return` and the value you want."
          : JSON.stringify(typed.value);
      case "threw":
        return `The script threw ${typed.error?.name}: ${typed.error?.message?.replace(/\.$/, "")}${at}.${none}`;
      case "rejected_code":
        return `The code could not be parsed: ${typed.error?.message?.replace(/\.$/, "")}${at}. Nothing ran.`;
      case "timed_out":
        return typed.limit === "cpu"
          ? `The script ran out of time: its own running time is limited to ${limits.cpuMs / 1000} seconds (waiting on calls is not counted).${none}`
          : `The script ran out of time: a run is limited to ${limits.wallMs / 1000} seconds, calls included.${none}`;
      case "too_large":
        return `The script returned ${typed.bytes} bytes; the limit is ${limits.maxValueBytes}. Return less.`;
      case "aborted":
        return `The writer stopped the script.${none}`;
      case "unavailable":
        return `The script runner failed (${typed.error?.message}). That is Flow's failure, not the script's, and it is not known how far the script got.${none}`;
    }
  }

  function callList(typed: Omit<McpRunResult, "text">): string {
    const ran = typed.calls.filter((call) => call.recordId !== null);
    const refused = typed.calls.filter((call) => call.recordId === null);
    return [listRan(typed, ran), listRefused(refused)].filter(Boolean).join("\n\n");
  }

  function listRefused(refused: McpScriptCall[]): string {
    if (!refused.length) return "";
    const lines = refused.map(
      (call) => `${call.sequence + 1}. ${call.id}: ${cut(call.message ?? call.outcome)}`,
    );
    return `Refused before they were sent (nothing ran):\n${lines.join("\n")}`;
  }

  function listRan(typed: Omit<McpRunResult, "text">, ran: McpScriptCall[]): string {
    if (!ran.length) return "";
    const full = typed.ended !== "returned";
    const lines = capLines(
      ran.map((call) => `${call.sequence + 1}. ${scriptCallLine(call, full)}`),
    );
    return `${full ? DO_NOT_REPEAT : "Calls made:"}\n${lines.join("\n")}`;
  }

  function scriptCallLine(call: McpScriptCall, full: boolean): string {
    if (!full) return `${call.id}: ${call.outcome}`;
    if (call.outcome === "answered")
      return callLine(call.id, call.arguments, answeredStatus(call.reply?.text ?? ""));
    const why = cut(call.reply?.text || call.message || "");
    const unknown =
      call.outcome === "aborted" ? " (outcome not known: it was cancelled and may have run)" : "";
    return callLine(call.id, call.arguments, `failed, ${call.outcome}${unknown}: ${why}`);
  }

  return { run };
}

function rowArguments(sent: JsonObject): JsonObject {
  return JSON.stringify(sent).length > ROW_ARGUMENT_BYTES
    ? { note: "Arguments over 2 KB; the call's record has them whole." }
    : sent;
}

export type ScriptRuns = ReturnType<typeof createScriptRuns>;

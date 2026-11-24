/**
 * Guards the order of a connection call: its record exists before the client is called and is
 * completed after, so a call that leaves is never missing from `mcp_calls`; once the server has
 * answered, a failing store, record or status write never keeps the outcome from the model; and
 * exact result text keeps model coaching from creeping back into MCP outcomes.
 *
 * Pins implementation decisions: model-facing MCP result text states facts without coaching.
 */

import type { CallOutcome } from "@meridian-flow/runtime/mcp";
import type { ScriptRequest, ScriptResult } from "@meridian-flow/runtime/script";
import { describe, expect, it } from "vitest";
import {
  type ConnectionCall,
  createConnectionTools,
  REPLY_CHARACTER_LIMIT,
} from "./connection-tools.js";
import { createScriptRuns, SCRIPT_LIMITS } from "./script-run.js";

const request = {
  thread: { id: "t1", userId: "u1" as never },
  bake: {
    bakedConnections: [{ name: "art", connectionId: "c1", pinId: "p1", listing: "full" as const }],
  },
  id: "art/draw",
  arguments: {},
  signal: new AbortController().signal,
  origin: { turnId: "t", modelResponseId: "r", toolCallId: "c", sequence: 0 },
};

function build(
  order: string[],
  failing = false,
  outcome: CallOutcome = {
    kind: "answered",
    isError: false,
    ms: 1,
    reply: { content: [{ type: "text", text: "hi" }] },
  },
) {
  const tool = { name: "draw", listed: { name: "draw", inputSchema: { type: "object" } } };
  const fail = (what: string) => async () => {
    throw new Error(`${what} failed`);
  };
  return createConnectionTools({
    store: {
      find: async () =>
        ({ row: { id: "c1", deletedAt: null }, pin: null, tokenSet: false }) as never,
      findPin: async () => ({ id: "p1", connectionId: "c1", pin: { tools: [tool] } }) as never,
    },
    calls: {
      open: async () => {
        await Promise.resolve();
        order.push("open");
        return "rec1";
      },
      complete: failing
        ? fail("complete")
        : async (_id, done) => void order.push(`complete:${done.outcomeKind}`),
      listForTurns: async () => [],
    },
    client: {
      call: async () => {
        order.push("call");
        return outcome;
      },
    } as never,
    service: {
      serverFor: async () => ({
        server: { key: "k", spec: { transport: "http", url: "https://x" } },
      }),
      checks: { recordCall: failing ? fail("status") : async () => void order.push("status") },
    } as never,
    replies: {
      put: failing ? fail("store") : async (_t, name) => ({ key: name }),
      get: fail("read"),
    },
    warn: () => order.push("warned"),
  });
}

const shapeText = async (call: ConnectionCall) => {
  const { result } = await build([]).shapeCall(request, call, {
    schema: false,
    reply: async () => ({ text: "reply", cut: false }),
  });
  return result.message ?? result.reply?.text ?? "";
};

const runText = async (
  result: ScriptResult,
  invoke?: (request: ScriptRequest) => Promise<void>,
) => {
  const tools = build([]);
  const runs = createScriptRuns({
    runner: {
      run: async (scriptRequest) => {
        await invoke?.(scriptRequest);
        return result;
      },
      close: async () => {},
    },
    tools,
  });
  return (await runs.run({ ...request, code: "const value = 1", emit: () => {} })).result.text;
};

const runCall = async (outcome: CallOutcome, limits = SCRIPT_LIMITS) => {
  const tools = build([], false, outcome);
  const runs = createScriptRuns({
    runner: {
      run: async (scriptRequest) => {
        const call = scriptRequest.globals.call;
        if (typeof call !== "function") throw new Error("Expected call global");
        try {
          const value = await call(["art/draw", {}], new AbortController().signal);
          return { kind: "returned" as const, value, logs: { text: "", cutBytes: 0 } };
        } catch (cause) {
          return {
            kind: "threw" as const,
            name: cause instanceof Error ? cause.name : "Error",
            message: cause instanceof Error ? cause.message : String(cause),
            logs: { text: "", cutBytes: 0 },
          };
        }
      },
      close: async () => {},
    },
    tools,
    limits,
  });
  return (await runs.run({ ...request, code: "return await call('art/draw', {})", emit: () => {} }))
    .result.text;
};

describe("callConnectionTool", () => {
  it("orders persistence around the call and returns the answer past later failures", async () => {
    const order: string[] = [];
    await build(order).callConnectionTool(request);
    expect(order).toEqual(["open", "call", "complete:answered", "status"]);

    const failingOrder: string[] = [];
    const { result, isError } = await build(failingOrder, true).mcpCall(request);
    expect(isError).toBe(false);
    expect(result.reply?.text).toBe("hi");
    expect(failingOrder.filter((step) => step === "warned")).toHaveLength(3);
  });
});

describe("model-facing MCP result text", () => {
  const called = (outcome: CallOutcome): ConnectionCall => ({
    kind: "called",
    connection: "art",
    tool: { name: "draw", listed: { name: "draw", inputSchema: { type: "object" } } },
    recordId: "rec1",
    outcome,
  });
  const logs = { text: "", cutBytes: 0 };

  const cases = [
    {
      name: "removed connection",
      read: () =>
        shapeText({
          kind: "refused" as const,
          code: "connection_removed" as const,
          connection: "art",
          tool: "draw",
        }),
      expected: "The connection art was removed, so art/draw cannot be called.",
    },
    {
      name: "reply over the call limit",
      read: () => shapeText(called({ kind: "too_large", bytes: 120, limit: 100, ms: 2 })),
      expected: "The reply was over 100 bytes (120 read), so it was not kept.",
    },
    ...(["start_failed", "connect_timeout", "disconnected"] as const).map((reason) => ({
      name: `unreachable connection: ${reason}`,
      read: () =>
        shapeText(
          called({ kind: "unreachable", reason, message: "network down", sent: false, ms: 2 }),
        ),
      expected: "art could not be reached (network down). Calling it again now will not help.",
    })),
    {
      name: "unreachable connection after a call may have run",
      read: () =>
        shapeText(
          called({
            kind: "unreachable",
            reason: "disconnected",
            message: "network down",
            sent: true,
            ms: 2,
          }),
        ),
      expected:
        "art could not be reached (network down). Calling it again now will not help. The call may have run.",
    },
    {
      name: "connection needs sign-in",
      read: () =>
        shapeText(
          called({
            kind: "unreachable",
            reason: "unauthorized",
            message: "no",
            sent: false,
            ms: 2,
          }),
        ),
      expected:
        "art refused its token (HTTP 401). The connection needs the writer to sign in again.",
    },
    {
      name: "cut reply",
      read: async () => {
        const text = "x".repeat(REPLY_CHARACTER_LIMIT + 1);
        const { result } = await build([], false, {
          kind: "answered",
          isError: false,
          ms: 1,
          reply: { content: [{ type: "text", text }] },
        }).mcpCall(request);
        return result.reply?.text ?? "";
      },
      expected: `${"x".repeat(REPLY_CHARACTER_LIMIT)}\n\n[Reply cut: ${REPLY_CHARACTER_LIMIT} of ${REPLY_CHARACTER_LIMIT + 1} characters shown.]`,
    },
    {
      name: "script returned no value",
      read: () => runText({ kind: "returned", value: null, logs }),
      expected: "The script returned nothing.",
    },
    {
      name: "script return over the limit",
      read: () => runText({ kind: "too_large", bytes: 70_000, logs }),
      expected: `The script returned 70000 bytes; the limit is ${SCRIPT_LIMITS.maxValueBytes}.`,
    },
    {
      name: "media left out of a script reply",
      read: () =>
        runCall({
          kind: "answered",
          isError: false,
          ms: 1,
          reply: {
            content: [
              { type: "text", text: "caption" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
          },
        }),
      expected:
        '"caption\\n[1 picture or audio part left out of a script\'s reply. The left-out parts are available through `mcp_call`.]"\n\nCalls made:\n1. art/draw: answered',
    },
    {
      name: "multiple media parts left out of a script reply",
      read: () =>
        runCall({
          kind: "answered",
          isError: false,
          ms: 1,
          reply: {
            content: [
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
              { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
            ],
          },
        }),
      expected:
        '"[2 picture or audio parts left out of a script\'s reply. The left-out parts are available through `mcp_call`.]"\n\nCalls made:\n1. art/draw: answered',
    },
    {
      name: "reply over the script input limit",
      read: () =>
        runCall(
          {
            kind: "answered",
            isError: false,
            ms: 1,
            reply: { content: [{ type: "text", text: "hello" }] },
          },
          { ...SCRIPT_LIMITS, replyBytes: 2, totalReplyBytes: 8 },
        ),
      expected:
        "The script threw HostFunctionError: The reply was 7 bytes, over what a script may take in (2 bytes a reply, 8 bytes in all).\n\nThese calls ran and are not undone.\n1. art/draw({}): failed, too_large: hello",
    },
    {
      name: "failed script call list",
      read: () =>
        runText(
          { kind: "threw", name: "Error", message: "after call", line: 2, logs },
          async (scriptRequest) => {
            const call = scriptRequest.globals.call;
            if (typeof call !== "function") throw new Error("Expected call global");
            await call(["art/draw", {}], new AbortController().signal);
          },
        ),
      expected:
        "The script threw Error: after call (line 2).\n\nThese calls ran and are not undone.\n1. art/draw({}): answered hi",
    },
  ];

  it("states facts only in every changed result variant", async () => {
    for (const { name, read, expected } of cases) expect(await read(), name).toBe(expected);
  });
});

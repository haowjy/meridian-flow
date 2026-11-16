/**
 * Guards the order of a connection call: its record exists before the client is called and is
 * completed after, so a call that leaves is never missing from `mcp_calls`; and once the server
 * has answered, a failing store, record or status write never keeps the outcome from the model.
 *
 * Pins implementation decisions: none.
 */
import { describe, expect, it } from "vitest";
import { createConnectionTools } from "./connection-tools.js";

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

function build(order: string[], failing = false) {
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
        return {
          kind: "answered",
          isError: false,
          ms: 1,
          reply: { content: [{ type: "text", text: "hi" }] },
        };
      },
    } as never,
    service: {
      serverFor: async () => ({
        server: { key: "k", spec: { transport: "http", url: "https://x" } },
      }),
      checks: { recordCall: failing ? fail("status") : async () => void order.push("status") },
    } as never,
    replies: { put: failing ? fail("store") : async (_t, name) => ({ key: name }) },
    warn: () => order.push("warned"),
  });
}

describe("callConnectionTool", () => {
  it("opens the record before the client is called and completes it after", async () => {
    const order: string[] = [];
    await build(order).callConnectionTool(request);
    expect(order).toEqual(["open", "call", "complete:answered", "status"]);
  });

  it("returns the answered reply when the store, the record and the status all fail", async () => {
    const order: string[] = [];
    const { result, isError } = await build(order, true).mcpCall(request);
    expect(isError).toBe(false);
    expect(result.reply?.text).toBe("hi");
    expect(order.filter((step) => step === "warned")).toHaveLength(3);
  });
});

/**
 * Guards the order of a connection call: its record exists before the client is called and is
 * completed after, so a call that leaves is never missing from `mcp_calls`.
 *
 * Pins implementation decisions: none.
 */
import { describe, expect, it } from "vitest";
import { createConnectionTools } from "./connection-tools.js";

describe("callConnectionTool", () => {
  it("opens the record before the client is called and completes it after", async () => {
    const order: string[] = [];
    const tool = { name: "draw", listed: { name: "draw", inputSchema: { type: "object" } } };
    const tools = createConnectionTools({
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
        complete: async (_id, done) => void order.push(`complete:${done.outcomeKind}`),
        listForTurns: async () => [],
      },
      client: {
        call: async () => {
          order.push("call");
          return { kind: "answered", isError: false, ms: 1, reply: {} };
        },
      } as never,
      service: {
        serverFor: async () => ({
          server: { key: "k", spec: { transport: "http", url: "https://x" } },
        }),
        checks: { recordCall: async () => void order.push("status") },
      } as never,
      replies: { put: async (_t, name) => ({ key: name }) },
    });
    await tools.callConnectionTool({
      thread: { id: "t1", userId: "u1" as never },
      bake: {
        bakedConnections: [{ name: "art", connectionId: "c1", pinId: "p1", listing: "full" }],
      },
      id: "art/draw",
      arguments: {},
      signal: new AbortController().signal,
      origin: { turnId: "t", modelResponseId: "r", toolCallId: "c", sequence: 0 },
    });
    expect(order).toEqual(["open", "call", "complete:answered", "status"]);
  });
});

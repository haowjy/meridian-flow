/** Contract tests for metadata-only thread WebSocket EventRecord mapping. */

import type { EventRecord } from "@meridian/contracts/observability";
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import { createThreadWireTap, createThreadWireTapState } from "./thread-wire-tap";

describe("createThreadWireTap", () => {
  it("classifies sequenced agent events without retaining their content", () => {
    const records: EventRecord[] = [];
    const tap = createThreadWireTap((record) => records.push(record), vi.fn());
    const data = JSON.stringify({
      type: "event",
      threadId: "thread-1",
      seq: "42",
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "agent-content-must-never-egress",
      },
      error: {
        message: "error-content-must-never-egress",
        details: { output: "tool-content-must-never-egress" },
      },
    });

    tap.onStringFrame("server_to_client", data, 3);

    expect(records).toEqual([
      expect.objectContaining({
        level: "trace",
        source: "wire.thread",
        name: "event",
        sensitivity: "safe",
        correlation: { threadId: "thread-1" },
        stream: {
          streamId: "thread:thread-1",
          transport: "thread",
          direction: "server_to_client",
          observedAt: "client",
          messageClass: "event",
          bytes: data.length,
          observerSeq: 1,
        },
        payload: {
          socketEpoch: 3,
          seq: "42",
          eventType: EventType.TEXT_MESSAGE_CONTENT,
        },
      }),
    ]);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("agent-content-must-never-egress");
    expect(serialized).not.toContain("error-content-must-never-egress");
    expect(serialized).not.toContain("tool-content-must-never-egress");
    expect(serialized).not.toContain("message-1");
  });

  it("classifies client frames and exposes only top-level thread metadata", () => {
    const records: EventRecord[] = [];
    const tap = createThreadWireTap((record) => records.push(record), vi.fn());
    const data = JSON.stringify({
      type: "interrupt.respond",
      threadId: "thread-2",
      turnId: "turn-content-must-never-egress",
      interruptId: "interrupt-content-must-never-egress",
      value: { answer: "user-content-must-never-egress" },
    });

    tap.onStringFrame("client_to_server", data, 8);

    expect(records[0]).toMatchObject({
      name: "interrupt.respond",
      correlation: { threadId: "thread-2" },
      stream: {
        streamId: "thread:thread-2",
        messageClass: "interrupt.respond",
        direction: "client_to_server",
      },
      payload: { socketEpoch: 8 },
    });
    expect(JSON.stringify(records[0])).not.toContain("content-must-never-egress");
  });

  it("measures UTF-8 bytes rather than UTF-16 code units", () => {
    const records: EventRecord[] = [];
    const tap = createThreadWireTap((record) => records.push(record), vi.fn());
    const data = JSON.stringify({ type: "unknown", content: "𐌍" });

    tap.onStringFrame("server_to_client", data, 1);

    expect(records[0]?.stream?.bytes).toBe(new TextEncoder().encode(data).byteLength);
  });

  it("never traverses catchup events or copies unrecognized classifications", () => {
    const records: EventRecord[] = [];
    const tap = createThreadWireTap((record) => records.push(record), vi.fn());
    const subscribed = JSON.stringify({
      type: "subscribed",
      threadId: "thread-3",
      catchup: [
        {
          seq: "99",
          event: {
            type: EventType.TOOL_CALL_RESULT,
            content: "catchup-content-must-never-egress",
          },
        },
      ],
    });
    const unrecognized = JSON.stringify({
      type: "classification-content-must-never-egress",
      event: { type: "event-type-content-must-never-egress" },
    });

    tap.onStringFrame("server_to_client", subscribed, 1);
    tap.onStringFrame("server_to_client", unrecognized, 1);

    expect(records[0]).toMatchObject({
      name: "subscribed",
      correlation: { threadId: "thread-3" },
      stream: { messageClass: "subscribed" },
      payload: { socketEpoch: 1 },
    });
    expect(records[1]).toMatchObject({
      name: "unknown",
      stream: {
        streamId: "thread:socket",
        messageClass: "unknown",
      },
      payload: { socketEpoch: 1 },
    });
    expect(JSON.stringify(records)).not.toContain("content-must-never-egress");
  });

  it("keeps observer sequence across hot replacement and strips lifecycle text", () => {
    const records: EventRecord[] = [];
    const state = createThreadWireTapState();
    const firstTap = createThreadWireTap((record) => records.push(record), vi.fn(), state);

    firstTap.onSocketOpen(1);
    firstTap.onSocketClose(1, 4403, true);

    const replacementTap = createThreadWireTap((record) => records.push(record), vi.fn(), state);
    replacementTap.onStringFrame("client_to_server", JSON.stringify({ type: "pong" }), 2);

    expect(records.map((record) => record.stream?.observerSeq)).toEqual([1, 2, 3]);
    expect(records[1]).toMatchObject({
      name: "socket.close",
      payload: { socketEpoch: 1, code: 4403, wasClean: true },
    });
  });

  it("routes parse and sink failures to safe error accounting", () => {
    const onError = vi.fn(() => {
      throw new Error("error counter unavailable");
    });
    const records: EventRecord[] = [];
    const tap = createThreadWireTap((record) => records.push(record), onError);

    expect(() => tap.onStringFrame("server_to_client", "not-json", 1)).not.toThrow();
    expect(records[0]).toMatchObject({
      name: "unknown",
      stream: { messageClass: "unknown" },
    });

    const failingTap = createThreadWireTap(() => {
      throw new Error("sink unavailable");
    }, onError);
    expect(() =>
      failingTap.onStringFrame("client_to_server", JSON.stringify({ type: "pong" }), 1),
    ).not.toThrow();
    expect(() => failingTap.onSocketOpen(1)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

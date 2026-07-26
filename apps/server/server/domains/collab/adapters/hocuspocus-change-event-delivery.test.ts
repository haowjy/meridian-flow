/** Contract coverage for recipient-targeted live-room change-event delivery. */

import type { Connection, Hocuspocus } from "@hocuspocus/server";
import { describe, expect, it, vi } from "vitest";
import { createHocuspocusChangeEventDelivery } from "./hocuspocus-change-event-delivery.js";

const message = {
  documentId: "00000000-0000-4000-8000-000000000001",
  threadId: "thread-1",
  trailId: "trail-1",
  projectionRevision: 1,
  author: { kind: "agent" as const, threadId: "thread-1", turnId: "turn-1" },
  changes: [
    {
      admittedByUserId: null,
      changeId: "change-1",
      kind: "delete" as const,
      navigation: { kind: "unavailable" as const, reason: "test" },
      swept: false,
      excerpt: "Removed prose",
      pureDeletionOffset: null,
    },
  ],
  truncated: false,
};

function connection(userId: string): Connection {
  return { context: { userId } } as Connection;
}

describe("Hocuspocus change-event delivery", () => {
  it("targets each connected writer with only that writer's sweep classification", () => {
    const writerA = connection("writer-a");
    const writerB = connection("writer-b");
    const unidentified = { context: {} } as Connection;
    const liveConnections = [writerA, writerB, unidentified];
    const deliveries = new Map<Connection, unknown>();
    const liveBroadcast = vi.fn((payload: string, filter: (connection: Connection) => boolean) => {
      for (const candidate of liveConnections) {
        if (filter(candidate)) {
          deliveries.set(candidate, JSON.parse(payload));
        }
      }
    });
    const branchBroadcast = vi.fn();
    const disconnectedBroadcast = vi.fn();
    const documents = new Map<string, unknown>([
      [
        message.documentId,
        { getConnections: () => liveConnections, broadcastStateless: liveBroadcast },
      ],
      [
        `branch:${message.documentId}:gen:1`,
        { getConnections: () => [connection("writer-a")], broadcastStateless: branchBroadcast },
      ],
      [
        "00000000-0000-4000-8000-000000000002",
        { getConnections: () => [], broadcastStateless: disconnectedBroadcast },
      ],
    ]);
    const delivery = createHocuspocusChangeEventDelivery({
      hocuspocus: () => ({ documents }) as unknown as Hocuspocus,
    });

    delivery.deliver(message, new Map([["writer-a" as never, new Set(["change-1"])]]));
    delivery.deliver({ ...message, documentId: "00000000-0000-4000-8000-000000000002" }, new Map());

    expect(liveBroadcast).toHaveBeenCalledTimes(2);
    expect(deliveries.get(writerA)).toMatchObject({
      type: "change_event",
      documentId: message.documentId,
      changes: [{ changeId: "change-1", swept: true }],
    });
    expect(deliveries.get(writerB)).toMatchObject({
      changes: [{ changeId: "change-1", swept: false }],
    });
    expect(deliveries.has(unidentified)).toBe(false);
    expect(branchBroadcast).not.toHaveBeenCalled();
    expect(disconnectedBroadcast).not.toHaveBeenCalled();
  });
});

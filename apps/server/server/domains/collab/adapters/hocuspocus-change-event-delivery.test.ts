/** Contract coverage for live-room-only change-event delivery. */

import type { Hocuspocus } from "@hocuspocus/server";
import { describe, expect, it, vi } from "vitest";
import { createHocuspocusChangeEventDelivery } from "./hocuspocus-change-event-delivery.js";

const message = {
  documentId: "00000000-0000-4000-8000-000000000001",
  threadId: "thread-1",
  trailId: "trail-1",
  projectionRevision: 1,
  author: { kind: "agent" as const, threadId: "thread-1", turnId: "turn-1" },
  admittedByUserId: null,
  changes: [],
  truncated: false,
};

describe("Hocuspocus change-event delivery", () => {
  it("targets only the connected bare-document room", () => {
    const liveBroadcast = vi.fn();
    const branchBroadcast = vi.fn();
    const disconnectedBroadcast = vi.fn();
    const documents = new Map<string, unknown>([
      [message.documentId, { getConnectionsCount: () => 1, broadcastStateless: liveBroadcast }],
      [
        `branch:${message.documentId}:gen:1`,
        { getConnectionsCount: () => 1, broadcastStateless: branchBroadcast },
      ],
      [
        "00000000-0000-4000-8000-000000000002",
        { getConnectionsCount: () => 0, broadcastStateless: disconnectedBroadcast },
      ],
    ]);
    const delivery = createHocuspocusChangeEventDelivery({
      hocuspocus: () => ({ documents }) as unknown as Hocuspocus,
    });

    delivery.deliver(message);
    delivery.deliver({ ...message, documentId: "00000000-0000-4000-8000-000000000002" });

    expect(liveBroadcast).toHaveBeenCalledOnce();
    expect(JSON.parse(liveBroadcast.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "change_event",
      documentId: message.documentId,
    });
    expect(branchBroadcast).not.toHaveBeenCalled();
    expect(disconnectedBroadcast).not.toHaveBeenCalled();
  });
});

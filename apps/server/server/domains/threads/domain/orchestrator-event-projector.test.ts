/**
 * Projector wire contracts: the client-facing custom event names and payloads
 * for durable block lifecycle facts. Pins the names the app reducer reads.
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { projectOrchestratorEvents } from "./orchestrator-event-projector.js";

describe("orchestrator event projector", () => {
  it("maps a pruned block to the client prune frame", () => {
    const events = projectOrchestratorEvents([{ type: "block.pruned", blockId: "block-1" }]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "meridian.block.pruned",
      value: { blockId: "block-1" },
    });
  });

  it("maps the pending inbox to the client inbox.changed frame", () => {
    const pending = {
      items: [
        {
          id: "message-1",
          seq: 1,
          intent: "message" as const,
          provenance: { kind: "writer" as const, actorId: "user-1" },
          summary: "queued",
          enqueuedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const events = projectOrchestratorEvents([
      { type: "inbox.changed", threadId: "thread-1", pending },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "meridian.inbox.changed",
      value: pending,
    });
  });
});

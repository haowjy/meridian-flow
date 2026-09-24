/**
 * Projector wire contracts: the client-facing custom event names and payloads
 * for durable block lifecycle facts. Pins the names the app reducer reads.
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  createOrchestratorEventProjector,
  projectOrchestratorEvents,
} from "./orchestrator-event-projector.js";

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
          deliveryState: "waiting" as const,
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

describe("historical card replacement", () => {
  it("projects a replacement without closing active text or advancing its frontier", () => {
    const projector = createOrchestratorEventProjector();
    const started = projector.project({
      type: "turn.created",
      turn: {
        id: "active-turn",
        threadId: "thread-1",
        role: "assistant",
        blocks: [],
        writeMode: "direct",
      } as never,
    });
    expect(started.some((event) => event.type === EventType.RUN_STARTED)).toBe(true);
    const first = projector.project({ type: "stream.delta", kind: "text", text: "before" });
    const replacement = projector.project({
      type: "block.updated",
      block: {
        id: "card-1",
        turnId: "historical-turn",
        blockType: "custom",
        sequence: 99,
        content: { component: "helper-result" },
        status: "complete",
      },
    });
    const after = projector.project({ type: "stream.delta", kind: "text", text: "after" });
    expect(replacement).toMatchObject([
      {
        type: EventType.CUSTOM,
        name: "meridian.block.upserted",
        value: { block: { id: "card-1", turnId: "historical-turn", sequence: 99 } },
      },
    ]);
    expect(replacement.some((event) => event.type === EventType.TEXT_MESSAGE_END)).toBe(false);
    expect(after.some((event) => event.type === EventType.TEXT_MESSAGE_START)).toBe(false);
    expect(first.find((event) => event.type === EventType.TEXT_MESSAGE_START)).toMatchObject({
      messageId: "active-turn::0",
    });
  });
});

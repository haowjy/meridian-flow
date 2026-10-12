/**
 * Projector wire contracts: the client-facing custom event names and payloads
 * for durable block lifecycle facts. Pins the names the app reducer reads.
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { createOrchestratorEventProjector } from "./orchestrator-event-projector.js";

describe("tool results", () => {
  it("sends the typed result beside the model's text", () => {
    const projector = createOrchestratorEventProjector();
    projector.project({
      type: "turn.created",
      turn: {
        id: "turn-1",
        threadId: "thread-1",
        role: "assistant",
        blocks: [],
        writeMode: "direct",
      } as never,
    });
    const result = { schema: "meridian.agent-edit.v1", command: "read", status: "success" };
    const events = projector.project({
      type: "tool.result",
      toolCallId: "call-1",
      output: "status: success; path: ch1.md",
      result,
    });

    expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
      toolCallId: "call-1",
      content: "status: success; path: ch1.md",
      result,
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

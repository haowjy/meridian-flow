/**
 * Projector wire contracts: the client-facing custom event names and payloads
 * for durable block lifecycle facts. Pins the names the app reducer reads.
 */
import {
  EventType,
  EXECUTION_ENDED_EVENT,
  MESSAGES_DELIVERED_EVENT,
} from "@meridian/contracts/protocol";
import { SIMPLE_TEXT_TURN_AGUI, SIMPLE_TEXT_TURN_ORCHESTRATOR } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  createOrchestratorEventProjector,
  projectOrchestratorEvents,
} from "./orchestrator-event-projector.js";

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

describe("run identity", () => {
  it("projects the golden send: start, delivery, finish, execution end", () => {
    expect(projectOrchestratorEvents(SIMPLE_TEXT_TURN_ORCHESTRATOR)).toEqual(SIMPLE_TEXT_TURN_AGUI);
  });

  it("names each split reply's execution and reservation, and ends the execution once", () => {
    const projector = createOrchestratorEventProjector();
    const turn = (id: string, position: number, reservedForUserTurnIds: string[]) =>
      ({
        id,
        position,
        threadId: "thread-1",
        role: "assistant",
        blocks: [],
        writeMode: "direct",
        executionId: "e1",
        reservedForUserTurnIds,
      }) as never;
    projector.project({ type: "turn.created", turn: turn("a", 2, ["m1"]) });
    const finish = projector.project({ type: "turn.completed", turn: turn("a", 2, ["m1"]) });
    const start = projector.project({ type: "turn.created", turn: turn("b", 4, ["m2"]) });
    const delivered = projector.project({
      type: "messages.delivered",
      byTurnId: "b",
      byTurnPosition: 4,
      executionId: "e1",
      userTurnIds: ["m2"],
    });
    const ended = projector.project({ type: "execution.ended", executionId: "e1" });

    expect(finish.find((event) => event.type === EventType.RUN_FINISHED)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "a",
    });
    expect(start).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "b",
        rawEvent: {
          writeMode: "direct",
          executionId: "e1",
          reservedForUserTurnIds: ["m2"],
          position: 4,
        },
      },
    ]);
    expect(delivered).toEqual([
      {
        type: EventType.CUSTOM,
        name: MESSAGES_DELIVERED_EVENT,
        value: { byTurnId: "b", byTurnPosition: 4, executionId: "e1", userTurnIds: ["m2"] },
      },
    ]);
    expect(ended).toEqual([
      { type: EventType.CUSTOM, name: EXECUTION_ENDED_EVENT, value: { executionId: "e1" } },
    ]);
  });

  it("reads a reply journaled before run identity as unknown", () => {
    const projector = createOrchestratorEventProjector();
    const [start] = projector.project({
      type: "turn.created",
      turn: {
        id: "old",
        threadId: "thread-1",
        role: "assistant",
        blocks: [],
        writeMode: null,
      } as never,
    });
    expect(start).toMatchObject({
      rawEvent: { writeMode: null, executionId: null, reservedForUserTurnIds: [], position: null },
    });
    const [delivered] = projector.project({
      type: "messages.delivered",
      byTurnId: "old",
      executionId: null,
      userTurnIds: ["m1"],
    } as never);
    expect(delivered).toMatchObject({ value: { byTurnId: "old", byTurnPosition: null } });
  });
});

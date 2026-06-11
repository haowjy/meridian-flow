import { EventType } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createOrchestratorEventProjector } from "./event-projector.js";

describe("createOrchestratorEventProjector", () => {
  it("projects a complete assistant text turn into AG-UI lifecycle frames", () => {
    const threadId = "thread-smoke" as ThreadId;
    const turnId = "turn-assistant" as TurnId;
    const projector = createOrchestratorEventProjector();

    const started = projector.project({
      type: "turn.created",
      turn: {
        id: turnId,
        threadId,
        role: "assistant",
        status: "complete",
        blocks: [],
        createdAt: new Date().toISOString(),
        completedAt: null,
      },
    });
    const delta = projector.project({
      type: "stream.delta",
      threadId,
      turnId,
      kind: "text",
      text: "Acknowledged: hello",
    });
    const completed = projector.project({
      type: "turn.completed",
      turn: {
        id: turnId,
        threadId,
        role: "assistant",
        status: "complete",
        blocks: [],
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });

    expect(started.map((event) => event.type)).toEqual([EventType.RUN_STARTED]);
    expect(delta.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect(completed.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it("ignores user turn.created events", () => {
    const projector = createOrchestratorEventProjector();
    const events = projector.project({
      type: "turn.created",
      turn: {
        id: "turn-user" as TurnId,
        threadId: "thread-smoke" as ThreadId,
        role: "user",
        status: "complete",
        blocks: [],
        createdAt: new Date().toISOString(),
        completedAt: null,
      },
    });
    expect(events).toEqual([]);
  });
});

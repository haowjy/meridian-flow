import { EventType } from "@meridian/contracts/protocol";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";

import { createOrchestratorEventProjector } from "./orchestrator-event-projector.js";

const PARENT_THREAD_ID = "parent-thread-1";

function project(event: OrchestratorEvent) {
  return createOrchestratorEventProjector().project(event);
}

describe("orchestrator event projector background lifecycle", () => {
  it("maps background.started to meridian.background.started with its payload", () => {
    expect(
      project({
        type: "background.started",
        parentThreadId: PARENT_THREAD_ID,
        parentTurnId: "turn-1",
        childThreadId: "child-1",
        agentSlug: "code-reviewer",
        description: "Review the chapter",
      }),
    ).toEqual([
      {
        type: EventType.CUSTOM,
        name: "meridian.background.started",
        value: {
          parentThreadId: PARENT_THREAD_ID,
          parentTurnId: "turn-1",
          childThreadId: "child-1",
          agentSlug: "code-reviewer",
          description: "Review the chapter",
        },
      },
    ]);
  });

  it("maps background.completed to meridian.background.completed with its payload", () => {
    const result = {
      status: "completed",
      report: {
        handle: "c1",
        threadId: "child-1",
        summary: "Done",
        costMillicredits: 0,
      },
    } as const;

    expect(
      project({
        type: "background.completed",
        parentThreadId: PARENT_THREAD_ID,
        parentTurnId: "turn-1",
        childThreadId: "child-1",
        agentSlug: "code-reviewer",
        result,
      }),
    ).toEqual([
      {
        type: EventType.CUSTOM,
        name: "meridian.background.completed",
        value: {
          parentThreadId: PARENT_THREAD_ID,
          parentTurnId: "turn-1",
          childThreadId: "child-1",
          agentSlug: "code-reviewer",
          result,
        },
      },
    ]);
  });

  it("maps background.failed to meridian.background.failed with its payload", () => {
    expect(
      project({
        type: "background.failed",
        parentThreadId: PARENT_THREAD_ID,
        parentTurnId: "turn-1",
        childThreadId: "child-1",
        agentSlug: "code-reviewer",
        error: "boom",
      }),
    ).toEqual([
      {
        type: EventType.CUSTOM,
        name: "meridian.background.failed",
        value: {
          parentThreadId: PARENT_THREAD_ID,
          parentTurnId: "turn-1",
          childThreadId: "child-1",
          agentSlug: "code-reviewer",
          error: "boom",
        },
      },
    ]);
  });
});

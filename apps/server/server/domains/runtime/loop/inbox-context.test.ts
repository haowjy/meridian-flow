/** Notice batches never create empty history. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { Notice } from "../../notices/index.js";
import { planMessageTurns } from "./inbox-context.js";

function notice(id: number, message: string): Notice {
  return {
    id,
    kind: "other",
    scope: { kind: "thread", threadId: "thread-1" },
    message,
    data: {},
    createdAt: new Date(id),
  };
}

function plan(notices: Notice[]) {
  return planMessageTurns({
    threadId: "thread-1" as ThreadId,
    batch: [],
    notices,
    prevTurnId: "previous-turn" as TurnId,
    prevTurnPosition: 1,
    knownTurnIds: new Set<TurnId>(),
  });
}

describe("notice materialization", () => {
  it("does not append history for empty or whitespace-only notices", () => {
    expect(plan([notice(1, " \n ")]).turns).toEqual([]);
  });

  it("delivers a notice with content", () => {
    expect(plan([notice(1, " \n "), notice(2, "The Work changed.")]).blocks[0]?.content).toBe(
      "<system_update>\nThe Work changed.\n</system_update>",
    );
  });
});

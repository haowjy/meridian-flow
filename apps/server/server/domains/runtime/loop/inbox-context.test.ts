/** Notice batches preserve net reversal meaning without creating empty history. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { Notice } from "../../notices/index.js";
import { planMessageTurns } from "./inbox-context.js";

function reversal(id: number, direction: "undo" | "redo", handle = "w1"): Notice {
  return {
    id,
    kind: "undo",
    scope: { kind: "thread", threadId: "thread-1" },
    message: "",
    data: { uri: "manuscript://Scene", turnId: handle, direction },
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
  it("does not append history when undo then redo cancel before delivery", () => {
    expect(plan([reversal(1, "undo"), reversal(2, "redo")])).toEqual({
      turns: [],
      blocks: [],
      events: [],
      leafTurnId: "previous-turn",
      noticesTurnId: null,
    });
  });

  it("does not append history for empty or whitespace-only notices", () => {
    const empty = { ...reversal(1, "undo"), kind: "other", message: " \n " };
    expect(plan([empty]).turns).toEqual([]);
  });

  it("still reports undo alone", () => {
    expect(plan([reversal(1, "undo")]).blocks[0]?.content).toContain(
      "The user reversed the following edits before this message:\n- Scene",
    );
  });

  it("reports restoration when the undo was delivered in an earlier batch", () => {
    expect(plan([reversal(2, "redo")]).blocks[0]?.content).toContain(
      "The user restored the following edits before this message:\n- Scene",
    );
  });

  it("keeps unrelated notices when reversals cancel", () => {
    const work = { ...reversal(3, "undo"), kind: "other", message: "The Work changed." };
    expect(plan([reversal(1, "undo"), reversal(2, "redo"), work]).blocks[0]?.content).toBe(
      "<system_update>\nThe Work changed.\n</system_update>",
    );
  });

  it("reports only the edits still undone", () => {
    expect(
      plan([reversal(1, "undo"), reversal(2, "redo"), reversal(3, "undo", "w2")]).blocks[0]
        ?.content,
    ).toContain("- Scene");
  });
});

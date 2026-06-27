/** Unit coverage for undo-notification coalescing semantics. */
import { describe, expect, it } from "vitest";

import { coalesceUndoNotifications, type PendingUndoNotification } from "./index.js";

const base = {
  id: "notification-1",
  threadId: "00000000-0000-4000-8000-000000000001" as never,
  turnId: "00000000-0000-4000-8000-000000000002" as never,
  uri: "manuscript://chapter-1.md",
  createdAt: new Date("2026-06-27T00:00:00.000Z"),
};

function notification(
  writeHandle: string,
  direction: PendingUndoNotification["direction"],
  uri = base.uri,
): PendingUndoNotification {
  return { ...base, id: `${uri}-${writeHandle}-${direction}`, uri, writeHandle, direction };
}

describe("coalesceUndoNotifications", () => {
  it("uses last direction per write and reports only net undone edits", () => {
    expect(
      coalesceUndoNotifications([
        notification("w1", "undo"),
        notification("w1", "redo"),
        notification("w2", "redo"),
        notification("w2", "undo"),
        notification("w3", "undo"),
      ]).map((row) => ({ writeHandle: row.writeHandle, direction: row.direction })),
    ).toEqual([
      { writeHandle: "w2", direction: "undo" },
      { writeHandle: "w3", direction: "undo" },
    ]);
  });

  it("keeps same write handles independent across documents", () => {
    expect(
      coalesceUndoNotifications([
        notification("w1", "undo", "manuscript://doc-a.md"),
        notification("w1", "undo", "manuscript://doc-b.md"),
      ]).map((row) => ({ uri: row.uri, writeHandle: row.writeHandle, direction: row.direction })),
    ).toEqual([
      { uri: "manuscript://doc-a.md", writeHandle: "w1", direction: "undo" },
      { uri: "manuscript://doc-b.md", writeHandle: "w1", direction: "undo" },
    ]);
  });
});

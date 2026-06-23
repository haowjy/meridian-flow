// Mutation commit contracts at the journal/live projection seam.
import { describe, expect, it } from "vitest";

import type { UndoManagerRegistry } from "../undo/manager-registry.js";
import { createMutationCommit } from "./mutation-commit.js";
import { MemoryJournal } from "./test-support/recording-journal.js";
import { codec, MemoryCoordinator, model, THREAD_ID } from "./test-support/write-tool-harness.js";

describe("mutation commit", () => {
  it("surfaces committed w-id attachment drift through the invariant hook", async () => {
    const invariantMessages: string[] = [];
    const turnId = "turn-attach-drift";
    const registry = {
      attachNextWId: () => false,
      getState: () => ({
        docId: "chapter.md",
        threadId: THREAD_ID,
        undoStack: [{ turnId }],
        redoStack: [],
      }),
    } as unknown as UndoManagerRegistry;

    const mutationCommit = createMutationCommit({
      journal: new MemoryJournal(),
      registry,
      coordinator: new MemoryCoordinator({}),
      model,
      codec,
      onInvariantViolation: (message) => {
        invariantMessages.push(message);
      },
    });

    await mutationCommit.commitJournalBatch([
      {
        docId: "chapter.md",
        update: new Uint8Array([1, 2, 3]),
        meta: { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 },
        mutation: { threadId: THREAD_ID, turnId },
      },
    ]);

    expect(invariantMessages).toHaveLength(1);
    expect(invariantMessages[0]).toContain("Failed to attach committed w-id 1");
    expect(invariantMessages[0]).toContain("turn-attach-drift");
  });
});

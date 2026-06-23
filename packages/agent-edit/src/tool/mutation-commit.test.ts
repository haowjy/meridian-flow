// Mutation commit contracts at the journal/live projection seam.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { UpdateJournal } from "../ports/update-journal.js";
import { createUndoManagerRegistry, type UndoManagerRegistry } from "../undo/manager-registry.js";
import { createMutationCommit } from "./mutation-commit.js";
import { blockTexts, humanText } from "./test-support/assertions.js";
import { MemoryJournal } from "./test-support/recording-journal.js";
import {
  cloneDoc,
  codec,
  MemoryCoordinator,
  model,
  THREAD_ID,
} from "./test-support/write-tool-harness.js";

describe("mutation commit", () => {
  it("commits an immediate update to the journal and projects it to the live document once", async () => {
    const coordinator = new MemoryCoordinator({ "chapter.md": "Alpha." });
    const journal = new MemoryJournal();
    const mutationCommit = createMutationCommit({
      journal,
      registry: createUndoManagerRegistry(),
      coordinator,
      model,
      codec,
    });
    const runtimeDoc = cloneDoc(coordinator.require("chapter.md"));
    const beforeVector = Y.encodeStateVector(runtimeDoc);
    humanText(runtimeDoc, 0, { from: 0, to: 5 }, "Beta");
    const update = Y.encodeStateAsUpdate(runtimeDoc, beforeVector);
    let liveProjectionCount = 0;
    coordinator.require("chapter.md").on("update", () => {
      liveProjectionCount += 1;
    });

    const committed = await mutationCommit.commitImmediate({
      docId: "chapter.md",
      commandName: "replace",
      updates: [
        {
          update,
          meta: { origin: "agent:turn-immediate", actorTurnId: "turn-immediate", seq: 0 },
          mutation: { threadId: THREAD_ID, turnId: "turn-immediate" },
        },
      ],
      afterOwnVector: Y.encodeStateVector(runtimeDoc),
      liveOrigin: { type: "agent", actorTurnId: "turn-immediate" },
    });

    expect(committed.ok).toBe(true);
    expect((await journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(coordinator.require("chapter.md"))).toEqual(["Beta."]);
    expect(liveProjectionCount).toBe(1);
  });

  it("attaches committed batch w-ids returned by the journal to the hot undo registry", async () => {
    const attached: Array<{ docId: string; threadId: string; turnId: string; wId: number }> = [];
    const registry = {
      attachNextWId: (docId: string, threadId: string, turnId: string, wId: number) => {
        attached.push({ docId, threadId, turnId, wId });
        return true;
      },
      getState: () => null,
    } as unknown as UndoManagerRegistry;
    const mutationCommit = createMutationCommit({
      journal: journalReturningWIds(41, 42),
      registry,
      coordinator: new MemoryCoordinator({}),
      model,
      codec,
    });

    await mutationCommit.commitJournalBatch([
      journalEntry("chapter.md", "turn-batch-1"),
      journalEntry("chapter.md", "turn-batch-2"),
    ]);

    expect(attached).toEqual([
      { docId: "chapter.md", threadId: THREAD_ID, turnId: "turn-batch-1", wId: 41 },
      { docId: "chapter.md", threadId: THREAD_ID, turnId: "turn-batch-2", wId: 42 },
    ]);
  });

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
      journal: journalReturningWIds(41),
      registry,
      coordinator: new MemoryCoordinator({}),
      model,
      codec,
      onInvariantViolation: (message) => {
        invariantMessages.push(message);
      },
    });

    await mutationCommit.commitJournalBatch([journalEntry("chapter.md", turnId)]);

    expect(invariantMessages).toHaveLength(1);
    expect(invariantMessages[0]).toContain("Failed to attach committed w-id 41");
    expect(invariantMessages[0]).toContain("turn-attach-drift");
  });
});

function journalEntry(docId: string, turnId: string) {
  return {
    docId,
    update: new Uint8Array([1, 2, 3]),
    meta: { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 },
    mutation: { threadId: THREAD_ID, turnId },
  };
}

function journalReturningWIds(...wIds: number[]): UpdateJournal {
  return {
    appendBatch: async () => wIds.map((wId, index) => ({ seq: index + 1, wId })),
  } as unknown as UpdateJournal;
}

import { describe, expect, it } from "vitest";
import { InMemoryAgentEditJournal } from "./in-memory-agent-edit.js";

describe("InMemoryAgentEditJournal.documentsForTurn", () => {
  it("returns distinct document ids touched by a thread turn", async () => {
    const journal = new InMemoryAgentEditJournal();

    await journal.appendBatch([
      mutation("doc-b", "thread-1", "turn-1", "write-b1"),
      mutation("doc-a", "thread-1", "turn-1", "write-a1"),
      mutation("doc-a", "thread-1", "turn-1", "write-a2"),
      mutation("doc-c", "thread-1", "turn-2", "write-c1"),
      mutation("doc-d", "thread-2", "turn-1", "write-d1"),
    ]);

    await expect(journal.documentsForTurn("thread-1", "turn-1")).resolves.toEqual([
      "doc-a",
      "doc-b",
    ]);
  });
});

function mutation(docId: string, threadId: string, turnId: string, writeId: string) {
  return {
    docId,
    update: new Uint8Array([1, 1]),
    meta: { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 },
    mutation: { threadId, turnId, writeId },
  };
}

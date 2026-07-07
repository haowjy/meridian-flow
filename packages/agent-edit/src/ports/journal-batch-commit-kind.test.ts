import { describe, expect, it } from "vitest";
import { InMemoryAgentEditJournal } from "../test-support/in-memory-agent-edit.js";

describe("appendBatch journalCommitKind", () => {
  it("reports durable for the in-memory live journal adapter", async () => {
    const journal = new InMemoryAgentEditJournal();
    const [result] = await journal.appendBatch([
      {
        docId: "chapter.md",
        update: new Uint8Array([1, 2]),
        meta: { origin: "agent:turn-1", seq: 1 },
        mutation: {
          mode: "live",
          threadId: "thread-1",
          turnId: "turn-1",
          writeId: "thread-1:turn-1:1",
          wId: 1,
        },
      },
    ]);
    expect(result.journalCommitKind).toBe("durable");
  });
});

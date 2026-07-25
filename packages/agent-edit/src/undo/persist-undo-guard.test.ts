import { describe, expect, it } from "vitest";

import { InMemoryAgentEditJournal } from "../test-support/in-memory-agent-edit.js";
import { guardPersistUndo } from "./persist-undo-guard.js";

describe("guardPersistUndo", () => {
  it("blocks a later writer row that races before persistence", async () => {
    const journal = new InMemoryAgentEditJournal();
    journal.setCheckpoint("chapter.md", new Uint8Array());
    await journal.appendBatch([
      {
        docId: "chapter.md",
        update: new Uint8Array([1, 2, 3]),
        meta: { origin: "agent:turn-race", seq: 1 },
        mutation: {
          actorKind: "agent",
          threadId: "thread-a",
          turnId: "turn-race",
          writeId: "thread-a:turn-race:1",
          wId: 1,
          mode: "live",
        },
      },
    ]);
    await journal.append("chapter.md", new Uint8Array([4, 5, 6]), {
      origin: "human:user-a",
      seq: 0,
    });

    const blocked = await guardPersistUndo(journal, "chapter.md", [
      {
        documentId: "chapter.md",
        threadId: "thread-a",
        turnId: "turn-race",
        writeIds: ["w1"],
        status: "reversed",
        undoUpdateSeq: 0,
        persistGuardWatermark: 1,
      },
    ]);

    expect(blocked).toMatchObject({ persisted: false, status: "cant_undo_dependent" });
  });

  it.each([
    "system",
    "agent:turn-bookkeeping",
  ])("allows a later %s row that races before persistence", async (origin) => {
    const journal = new InMemoryAgentEditJournal();
    journal.setCheckpoint("chapter.md", new Uint8Array());
    await journal.append("chapter.md", new Uint8Array([1]), {
      origin: "agent:turn-target",
      seq: 0,
    });
    await journal.append("chapter.md", new Uint8Array([2]), { origin, seq: 0 });

    await expect(
      guardPersistUndo(journal, "chapter.md", [
        {
          documentId: "chapter.md",
          threadId: "thread-a",
          turnId: "turn-target",
          writeIds: ["w1"],
          status: "reversed",
          undoUpdateSeq: 0,
          persistGuardWatermark: 1,
        },
      ]),
    ).resolves.toBeNull();
  });
});

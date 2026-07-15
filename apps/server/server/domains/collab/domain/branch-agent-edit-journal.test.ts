import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import {
  createBranchAgentEditJournal,
  createBranchPendingJournalEntries,
} from "./branch-agent-edit.js";
import { runResponseTransaction } from "./response-transaction.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000003" as ThreadId;

describe("branch agent-edit journal appendBatch", () => {
  it("reports staged for thread-peer branch writes", async () => {
    const liveJournal = createInMemoryJournal();
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal,
    });
    const [result] = await branchJournal.appendBatch([
      {
        docId: "chapter.md",
        update: new Uint8Array([1, 2]),
        meta: { origin: "agent:turn-1", seq: 1 },
        mutation: {
          actorKind: "agent",
          mode: "threadPeer",
          threadId: THREAD_ID,
          turnId: "turn-1",
          branchGeneration: 1,
          writeId: "thread-peer-1:turn-1:1",
          wId: 1,
        },
      },
    ]);
    expect(result.journalCommitKind).toBe("staged");
  });

  it("seals v2 lineage only when response finalization succeeds", async () => {
    const pending = createBranchPendingJournalEntries();
    const journal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal: createInMemoryJournal(),
      pendingJournalEntries: pending,
    });
    const entry = {
      docId: "chapter.md",
      update: new Uint8Array([1]),
      meta: { origin: "agent:turn-1", authoringResponseId: "response-1", seq: 1 },
      mutation: {
        actorKind: "agent" as const,
        mode: "threadPeer" as const,
        threadId: THREAD_ID,
        turnId: "turn-1",
        authoringResponseId: "response-1",
        branchGeneration: 1,
      },
    };
    const token = {
      version: 2 as const,
      documentId: "chapter.md",
      ranges: [{ clientID: 1, clock: 2, length: 3 }],
    };

    await runResponseTransaction(
      async (operation) => operation(),
      async () => {
        await journal.appendBatch([entry]);
        await journal.recordSealedWriterLineage?.({
          docId: "chapter.md",
          responseId: "response-1",
          token,
        });
      },
    );
    expect(pending.shiftBatch("chapter.md")).toEqual([
      expect.objectContaining({ meta: expect.objectContaining({ sealedWriterLineage: token }) }),
    ]);

    await expect(
      runResponseTransaction(
        async (operation) => operation(),
        async () => {
          await journal.appendBatch([{ ...entry, update: new Uint8Array([2]) }]);
          await journal.recordSealedWriterLineage?.({
            docId: "chapter.md",
            responseId: "response-1",
            token,
          });
          throw new Error("response failed");
        },
      ),
    ).rejects.toThrow("response failed");
    expect(pending.shiftBatch("chapter.md")).toEqual([]);
  });
});

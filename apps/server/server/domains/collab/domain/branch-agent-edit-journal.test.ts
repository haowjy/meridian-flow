import { toDocHandle } from "@meridian/agent-edit";
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import {
  createBranchAgentEditJournal,
  createBranchPendingJournalEntries,
} from "./branch-agent-edit.js";
import { activeBranchAgentWriteRows } from "./branch-reversal-history.js";
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

  it("single-flights grouped ordinal reservation for concurrent writes", async () => {
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal: createInMemoryJournal(),
    });

    await expect(
      Promise.all([
        branchJournal.reserveWriteOrdinal("chapter.md", THREAD_ID, "response-1"),
        branchJournal.reserveWriteOrdinal("chapter.md", THREAD_ID, "response-1"),
      ]),
    ).resolves.toEqual([1, 1]);
  });

  it("classifies roots absent from live authority as agent-owned branch content", async () => {
    const liveJournal = createInMemoryJournal();
    const materialize = vi.fn(async (input: { fallbackProvenance?: string }) => ({
      before: [],
      afterCandidate: [],
      fallback: input.fallbackProvenance,
    }));
    liveJournal.materializeDestructiveProvenance = materialize;
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal,
    });
    const doc = new Y.Doc({ gc: false });

    await branchJournal.materializeDestructiveProvenance?.({
      docId: "chapter.md",
      before: toDocHandle(doc),
      afterCandidate: toDocHandle(doc),
    });

    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackProvenance: "agent" }),
    );
    doc.destroy();
  });

  it("falls back to live reversal history after Apply advances to an empty branch generation", async () => {
    const liveJournal = createInMemoryJournal();
    await liveJournal.appendBatch([
      {
        docId: "chapter.md",
        update: new Uint8Array([1, 2]),
        meta: { origin: "agent:turn-1", seq: 0 },
        mutation: {
          actorKind: "agent",
          mode: "live",
          threadId: THREAD_ID,
          turnId: "turn-1",
          writeId: "applied-write",
          wId: 1,
        },
      },
    ]);
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal,
      branches: {
        resolveThreadBranch: async () => ({
          branchId: "peer",
          doc: new Y.Doc({ gc: false }),
          generation: 2,
        }),
        ensureThreadPeerBranch: async () => {
          throw new Error("not used");
        },
        ensureWorkDraftBranch: async () => {
          throw new Error("not used");
        },
        listActiveWorkDraftBranchIds: async () => ["work"],
        getBranch: async (branchId) =>
          branchId === "peer"
            ? { upstreamBranchId: "work", generation: 2 }
            : { upstreamBranchId: null, generation: 2 },
      },
      branchRows: {
        listJournalRowsForBranch: async () => [
          {
            id: 1,
            branchId: "work",
            generation: 2,
            wId: 1,
            source: "agent",
            threadId: THREAD_ID,
            turnId: null,
            actorUserId: null,
            updateData: new Uint8Array([1, 2]),
            draftBaseUpdateSeq: 1,
            status: "pushed",
          },
        ],
      },
    });

    await expect(branchJournal.latestActiveWrite("chapter.md", THREAD_ID)).resolves.toMatchObject({
      handle: "w1",
    });
  });

  it("fails closed when branch mode lacks reversal history access", async () => {
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal: createInMemoryJournal(),
      branches: {
        resolveThreadBranch: async () => ({
          branchId: "peer",
          doc: new Y.Doc({ gc: false }),
          generation: 1,
        }),
        ensureThreadPeerBranch: async () => {
          throw new Error("not used");
        },
        ensureWorkDraftBranch: async () => {
          throw new Error("not used");
        },
        listActiveWorkDraftBranchIds: async () => ["work"],
        getBranch: async () => ({ upstreamBranchId: "work", generation: 1 }),
      },
    });

    await expect(branchJournal.activeWriteSummary("chapter.md", THREAD_ID)).rejects.toThrow(
      "Branch reversal history is unavailable",
    );
  });

  it("stages the planning watermark rather than resampling branch history at persistence", async () => {
    const pending = createBranchPendingJournalEntries();
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal: createInMemoryJournal(),
      pendingJournalEntries: pending,
      branches: {
        resolveThreadBranch: async () => ({
          branchId: "peer",
          doc: new Y.Doc({ gc: false }),
          generation: 1,
        }),
        ensureThreadPeerBranch: async () => {
          throw new Error("not used");
        },
        ensureWorkDraftBranch: async () => {
          throw new Error("not used");
        },
        listActiveWorkDraftBranchIds: async () => ["work"],
        getBranch: async (branchId) =>
          branchId === "peer"
            ? { upstreamBranchId: "work", generation: 1 }
            : { upstreamBranchId: null, generation: 1 },
      },
      branchRows: {
        listJournalRowsForBranch: async () => [
          {
            id: 1,
            branchId: "work",
            generation: 1,
            wId: 1,
            source: "agent",
            threadId: THREAD_ID,
            turnId: "turn-1",
            actorUserId: null,
            updateData: new Uint8Array([1]),
            draftBaseUpdateSeq: 0,
            status: "active",
          },
          {
            id: 2,
            branchId: "work",
            generation: 1,
            wId: null,
            source: "writer",
            threadId: null,
            turnId: null,
            actorUserId: null,
            updateData: new Uint8Array([2]),
            draftBaseUpdateSeq: 0,
            status: "active",
          },
        ],
      },
    });

    await branchJournal.persistUndo("chapter.md", new Uint8Array([3]), [
      {
        documentId: "chapter.md",
        threadId: THREAD_ID,
        turnId: "turn-1",
        writeIds: ["w1"],
        status: "reversed",
        undoUpdateSeq: 0,
        persistGuardWatermark: 1,
      },
    ]);

    expect(pending.shiftBatch("chapter.md")[0]?.mutation).toMatchObject({
      branchGeneration: 1,
      branchJournalWatermark: 1,
    });

    await branchJournal.persistRedoBatch("chapter.md", [
      {
        update: new Uint8Array([4]),
        ref: { threadId: THREAD_ID, undoUpdateSeq: 3 },
        meta: { origin: "system", seq: 0 },
        persistGuardWatermark: 1,
      },
    ]);
    expect(pending.shiftBatch("chapter.md")[0]?.mutation).toMatchObject({
      branchGeneration: 1,
      branchJournalWatermark: 1,
    });
  });

  it("squashes undone handles and retains redone handles when projecting Apply history", () => {
    const row = (id: number, wId: number | null, updateMeta?: unknown) => ({
      id,
      branchId: "work",
      generation: 1,
      wId,
      source: "agent" as const,
      threadId: THREAD_ID,
      turnId: null,
      actorUserId: null,
      updateData: new Uint8Array([id]),
      draftBaseUpdateSeq: 1,
      status: "pushed" as const,
      updateMeta,
    });
    const forward = [row(1, 1), row(2, 2)];
    const undo = row(3, null, {
      origin: "system",
      seq: 0,
      branchReversal: {
        direction: "undo",
        records: [
          {
            documentId: "chapter.md",
            threadId: THREAD_ID,
            turnId: null,
            writeIds: ["w1"],
            status: "reversed",
          },
        ],
      },
    });

    expect(activeBranchAgentWriteRows([...forward, undo]).map(({ wId }) => wId)).toEqual([2]);
    expect(activeBranchAgentWriteRows([undo, ...forward]).map(({ wId }) => wId)).toEqual([2]);
    expect(
      activeBranchAgentWriteRows([
        ...forward,
        undo,
        row(4, null, {
          origin: "system",
          seq: 0,
          branchReversal: {
            direction: "redo",
            refs: [{ threadId: THREAD_ID, undoUpdateSeq: 3 }],
          },
        }),
      ]).map(({ wId }) => wId),
    ).toEqual([1, 2]);
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
      version: 3 as const,
      documentId: "chapter.md",
      protectedRoots: [{ clientID: 1, clock: 2, length: 3 }],
      responseCausalCutId: "cut-1",
    };

    await runResponseTransaction(
      async (operation) => operation(),
      async () => {
        await journal.appendBatch([entry]);
        await journal.recordWriterProtectionScope?.({
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
          await journal.recordWriterProtectionScope?.({
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

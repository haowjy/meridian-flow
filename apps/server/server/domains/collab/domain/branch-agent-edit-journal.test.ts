import { toDocHandle } from "@meridian/agent-edit";
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import {
  createBranchAgentEditJournal,
  createBranchPendingJournalEntries,
} from "./branch-agent-edit.js";

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

  it("classifies roots absent from the live document as agent-owned branch content", async () => {
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
            ? { upstreamBranchId: "work", generation: 2, state: new Uint8Array() }
            : { upstreamBranchId: null, generation: 2, state: new Uint8Array() },
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
        getBranch: async () => ({
          upstreamBranchId: "work",
          generation: 1,
          state: new Uint8Array(),
        }),
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
            ? { upstreamBranchId: "work", generation: 1, state: new Uint8Array() }
            : { upstreamBranchId: null, generation: 1, state: new Uint8Array() },
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
      branchJournalRevision: "1:active,2:active",
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
      branchJournalRevision: "1:active,2:active",
    });
  });

  it("reconciles replayed rows to the authoritative branch state after selective discard", async () => {
    const branchDoc = new Y.Doc({ gc: false });
    const content = branchDoc.getMap<string>("content");
    let before = Y.encodeStateVector(branchDoc);
    content.set("discarded", "A");
    const discardedUpdate = Y.encodeStateAsUpdate(branchDoc, before);
    before = Y.encodeStateVector(branchDoc);
    content.set("active", "B");
    const activeUpdate = Y.encodeStateAsUpdate(branchDoc, before);
    content.delete("discarded");
    const branchState = Y.encodeStateAsUpdate(branchDoc);

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
        getBranch: async (branchId) =>
          branchId === "peer"
            ? { upstreamBranchId: "work", generation: 1, state: branchState }
            : { upstreamBranchId: null, generation: 1, state: branchState },
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
            updateData: discardedUpdate,
            draftBaseUpdateSeq: 0,
            status: "discarded",
          },
          {
            id: 2,
            branchId: "work",
            generation: 1,
            wId: 2,
            source: "agent",
            threadId: THREAD_ID,
            turnId: "turn-2",
            actorUserId: null,
            updateData: activeUpdate,
            draftBaseUpdateSeq: 0,
            status: "active",
          },
        ],
      },
    });

    const snapshot = await branchJournal.readForReconstruction("chapter.md");
    const reconstructed = new Y.Doc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(reconstructed, snapshot.checkpoint);
    for (const update of snapshot.updates) Y.applyUpdate(reconstructed, update.update);

    expect([...reconstructed.getMap<string>("content").entries()]).toEqual([["active", "B"]]);
    expect(snapshot.persistenceWatermark).toBe(2);
    reconstructed.destroy();
    branchDoc.destroy();
  });

  it("pins branch reversal authority from planning through persistence", async () => {
    const pending = createBranchPendingJournalEntries();
    const liveJournal = createInMemoryJournal();
    const livePersistUndo = vi.spyOn(liveJournal, "persistUndo");
    const branchDoc = new Y.Doc({ gc: false });
    branchDoc.getMap("content").set("active", "B");
    const branchState = Y.encodeStateAsUpdate(branchDoc);
    const activeRow = {
      id: 1,
      branchId: "work",
      generation: 1,
      wId: 1,
      source: "agent" as const,
      threadId: THREAD_ID,
      turnId: "turn-1",
      actorUserId: null,
      updateData: branchState,
      draftBaseUpdateSeq: 0,
      status: "active" as const,
    };
    const listRows = vi.fn().mockResolvedValueOnce([activeRow]).mockResolvedValue([]);
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal,
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
            ? { upstreamBranchId: "work", generation: 1, state: branchState }
            : { upstreamBranchId: null, generation: 1, state: branchState },
      },
      branchRows: { listJournalRowsForBranch: listRows },
    });

    await branchJournal.withReversalScope?.("chapter.md", async () => {
      await expect(branchJournal.latestActiveWrite("chapter.md", THREAD_ID)).resolves.toMatchObject(
        {
          handle: "w1",
        },
      );
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
    });

    expect(listRows).toHaveBeenCalledOnce();
    expect(livePersistUndo).not.toHaveBeenCalled();
    expect(pending.shiftBatch("chapter.md")).toEqual([
      expect.objectContaining({
        mutation: expect.objectContaining({ branchJournalRevision: "1:active" }),
      }),
    ]);
    branchDoc.destroy();
  });
});

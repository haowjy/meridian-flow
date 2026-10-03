/** Pool routing per document (D19), the reply's one save (D42), and read-version checks (D41). */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createFakeThreadPeerCores,
  inProcessResponseTransactions,
} from "../test-support/thread-peer-pool-fakes.js";
import { type AgentEditDestination, asLiveAgentEditCore } from "./agent-edit-cores.js";
import { createThreadPeerCorePool } from "./thread-peer-core-pool.js";

const THREAD_ID = "thread-1" as ThreadId;
const live: AgentEditDestination = { kind: "live" };
const draftA: AgentEditDestination = { kind: "draft", workId: "work-a" as WorkId, workSlug: "a" };
const draftB: AgentEditDestination = { kind: "draft", workId: "work-b" as WorkId, workSlug: "b" };
function createPool() {
  const { history, liveCore, threadCore } = createFakeThreadPeerCores();
  const afterLiveCommit = vi.fn();
  const atomic = { calls: 0 };
  const pool = createThreadPeerCorePool({
    liveUtilityCore: asLiveAgentEditCore(liveCore.asCore()),
    createThreadCore: () => threadCore.asCore(),
    reversalHistory: history.reader,
    discardThreadPeerBranches: async () => {},
    pullThreadPeer: history.pullThreadPeer,
    afterLiveCommit,
    commitThreadResponseAtomically: async (operation) => {
      atomic.calls += 1;
      return operation();
    },
    ...inProcessResponseTransactions,
  });
  return {
    pool,
    liveCore,
    threadCore,
    pullThreadPeer: history.pullThreadPeer,
    afterLiveCommit,
    atomic,
  };
}

const context = (destination: AgentEditDestination, responseId?: string) => ({
  sessionId: THREAD_ID,
  threadId: THREAD_ID,
  turnId: "turn-1",
  destination,
  ...(responseId ? { responseId } : {}),
});
const readCh12 = { file: "ch12.md", documentId: "ch12" };
const insertCh12 = {
  command: "insert",
  file: "ch12.md",
  documentId: "ch12",
  content: "x",
} as const;

describe("thread-peer pool read versions (D41)", () => {
  it.each([
    [
      "a live read followed by a drafted write",
      live,
      draftA,
      "You last read ch12.md live, but your writes now go to @a's draft. Read it again before editing.",
    ],
    [
      "a draft read followed by a switch to auto-apply",
      draftA,
      live,
      "You last read ch12.md in @a's draft, but your writes now go live. Read it again before editing.",
    ],
    [
      "a draft read followed by a work switch",
      draftA,
      draftB,
      "You last read ch12.md in @a's draft, but your writes now go to @b's draft. Read it again before editing.",
    ],
  ])("refuses %s and touches no core", async (_case, read, write, message) => {
    const { pool, liveCore, threadCore, pullThreadPeer } = createPool();
    await pool.read(readCh12, context(read));
    pullThreadPeer.mockClear();

    const refused = await pool.write(insertCh12, context(write));

    expect(refused).toMatchObject({ status: "read_required", isError: true });
    expect(refused.result).toMatchObject({ status: "read_required", path: "ch12.md", message });
    expect(pullThreadPeer).not.toHaveBeenCalled();
    expect(liveCore.write).not.toHaveBeenCalled();
    expect(threadCore.write).not.toHaveBeenCalled();
  });

  it("lets the write through after a re-read in the new version", async () => {
    const { pool, liveCore } = createPool();
    await pool.read(readCh12, context(draftA));
    await pool.read(readCh12, context(live));

    await expect(pool.write(insertCh12, context(live))).resolves.toMatchObject({
      status: "success",
    });
    expect(liveCore.write).toHaveBeenCalledOnce();
  });

  it("passes writes with no prior read, or in the version last read", async () => {
    const { pool, threadCore } = createPool();
    await expect(pool.write(insertCh12, context(draftA))).resolves.toMatchObject({
      status: "success",
    });
    await expect(pool.write(insertCh12, context(draftA))).resolves.toMatchObject({
      status: "success",
    });
    expect(threadCore.write).toHaveBeenCalledTimes(2);
  });

  it("reports the version a read actually used", async () => {
    const { pool } = createPool();
    const read = await pool.read(readCh12, context(draftA));
    expect(read.result.read).toEqual({ format: "full", version: "draft" });
  });

  it("reads a document this reply drafted as published when the read asks for live", async () => {
    const { pool, liveCore, threadCore } = createPool();
    await pool.write(insertCh12, context(draftA, "response-1"));
    expect(pool.responseDestination("response-1", "ch12")).toEqual(draftA);

    // A default read follows the reply's pin even after the Work left draft mode.
    const pinned = await pool.read(readCh12, context(live, "response-1"));
    expect(pinned.result.read?.version).toBe("draft");
    expect(threadCore.read).toHaveBeenCalledOnce();

    const published = await pool.read(readCh12, {
      ...context(live, "response-1"),
      published: true,
    });
    expect(published.result.read?.version).toBe("live");
    expect(liveCore.read).toHaveBeenCalledOnce();
  });

  it("never checks undo and redo against the last read", async () => {
    const { pool } = createPool();
    await pool.read(readCh12, context(live));
    await expect(
      pool.write({ command: "undo", file: "ch12.md", documentId: "ch12" }, context(draftA)),
    ).resolves.toMatchObject({ status: "success" });
  });
});

describe("thread-peer pool undo and redo routing", () => {
  const undoCh12 = { command: "undo", file: "ch12.md", documentId: "ch12" } as const;

  it("sends undo to the live core for a thread that only wrote live", async () => {
    const { pool, liveCore, threadCore } = createPool();
    await pool.write(insertCh12, context(live));
    liveCore.write.mockClear();

    await pool.write(undoCh12, context(draftA));

    expect(liveCore.write).toHaveBeenCalledOnce();
    expect(threadCore.write).not.toHaveBeenCalled();
  });

  it("sends undo to the thread core for a thread that drafted the document", async () => {
    const { pool, liveCore, threadCore } = createPool();
    await pool.write(insertCh12, context(draftA));
    threadCore.write.mockClear();

    await pool.write(undoCh12, context(live));

    expect(threadCore.write).toHaveBeenCalledOnce();
    expect(liveCore.write).not.toHaveBeenCalled();
  });

  it("keeps undo live for a thread that pulled a peer but never drafted", async () => {
    const { pool, liveCore, threadCore, pullThreadPeer } = createPool();
    await pullThreadPeer({ documentId: "ch12" as DocumentId, threadId: THREAD_ID });

    await pool.write(undoCh12, context(draftA));

    expect(liveCore.write).toHaveBeenCalledOnce();
    expect(threadCore.write).not.toHaveBeenCalled();
  });
});

describe("thread-peer pool destinations (D19, D42)", () => {
  it("routes each document by its destination and never pulls a peer for live", async () => {
    const { pool, liveCore, threadCore, pullThreadPeer } = createPool();
    await pool.write(
      { ...insertCh12, file: "notes.md", documentId: "notes" },
      context(live, "reply-1"),
    );
    await pool.write(insertCh12, context(draftA, "reply-1"));

    expect(liveCore.write).toHaveBeenCalledOnce();
    expect(threadCore.write).toHaveBeenCalledOnce();
    expect(pullThreadPeer).toHaveBeenCalledOnce();
    expect(pullThreadPeer).toHaveBeenCalledWith({ documentId: "ch12", threadId: THREAD_ID });
  });

  it("keeps a document's first destination for the rest of the reply", async () => {
    const { pool, liveCore, threadCore } = createPool();
    await pool.write(insertCh12, context(draftA, "reply-1"));
    await pool.write(insertCh12, context(live, "reply-1"));

    expect(threadCore.write).toHaveBeenCalledTimes(2);
    expect(liveCore.write).not.toHaveBeenCalled();
  });

  it("reads a document from the core holding the reply's writes to it", async () => {
    const { pool, liveCore, threadCore } = createPool();
    await pool.write(
      { ...insertCh12, file: "notes.md", documentId: "notes" },
      context(live, "reply-1"),
    );
    await pool.write(insertCh12, context(draftA, "reply-1"));

    liveCore.hasResponseDocument.mockReturnValue(true);
    expect(pool.hasResponseDocument("reply-1", "notes")).toBe(true);
    expect(pool.hasResponseDocument("reply-1", "ch12")).toBe(false);
    await expect(
      pool.withResponseDocument("reply-1", "notes", null, async () => "unused"),
    ).resolves.toBe("live");
    await expect(
      pool.withResponseDocument("reply-1", "ch12", null, async () => "unused"),
    ).resolves.toBe("thread");
    expect(liveCore.withResponseDocument).toHaveBeenCalledOnce();
    expect(threadCore.withResponseDocument).toHaveBeenCalledOnce();
  });

  it("saves every destination in one transaction and reports which documents were drafted", async () => {
    const { pool, liveCore, threadCore, atomic, afterLiveCommit } = createPool();
    await pool.write(
      { ...insertCh12, file: "notes.md", documentId: "notes" },
      context(live, "reply-1"),
    );
    await pool.write(insertCh12, context(draftA, "reply-1"));
    liveCore.commitResponse.mockImplementationOnce(async (responseId, options) => {
      options?.deferFinalization?.({ commit() {}, abort() {} });
      return {
        status: "committed",
        responseId,
        documentCount: 1,
        updateCount: 1,
        documents: [{ documentId: "notes", updateCount: 1, receipts: [] }],
        stagedCreates: { committed: [], discarded: [] },
      };
    });
    threadCore.commitResponse.mockImplementationOnce(async (responseId, options) => {
      options?.deferFinalization?.({ commit() {}, abort() {} });
      return {
        status: "committed",
        responseId,
        documentCount: 1,
        updateCount: 1,
        documents: [{ documentId: "ch12", updateCount: 1, receipts: [] }],
        stagedCreates: { committed: [], discarded: [] },
      };
    });

    const saved = await pool.commitResponse("reply-1");

    expect(atomic.calls).toBe(1);
    expect(saved.documents.map((document) => document.documentId).sort()).toEqual([
      "ch12",
      "notes",
    ]);
    expect(saved.draftedDocumentIds).toEqual(["ch12" as DocumentId]);
    expect(afterLiveCommit).toHaveBeenCalledWith("notes");
    expect(afterLiveCommit).not.toHaveBeenCalledWith("ch12");
  });

  it("schedules the live-to-draft merge after an immediate live write", async () => {
    const { pool, afterLiveCommit } = createPool();
    await pool.write(insertCh12, context(live));
    expect(afterLiveCommit).toHaveBeenCalledWith("ch12");
  });
});

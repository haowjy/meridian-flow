/** Consolidated test contracts; each block retains its original fixture scope. */

import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe as __mergedSuite, expect, it, vi } from "vitest";
import { harness } from "../../../../../../packages/agent-edit/src/tool/test-support/write-tool-harness.js";
import { observeLeases } from "../../../test-support/lease-observer.js";
import type { FileDestination } from "../../file-policy/index.js";
import {
  createFakeBranchTable,
  createFakeDrafts,
  createFakeFileAccess,
  createFakeThreadPeerCores,
  FAKE_DRAFT_ID,
  FAKE_UPSTREAM_ID,
  fakeEditGrant,
  inProcessResponseTransactions,
} from "../test-support/thread-peer-pool-fakes.js";
import { asLiveAgentEditCore } from "./agent-edit-cores.js";
import { createBranchCriticalSections } from "./branch-critical-sections.js";
import { createReplySaveFences, type ReplyRecord } from "./reply-save-fences.js";
import { enlistResponseParticipant, runResponseTransaction } from "./response-transaction.js";
import { createThreadPeerCorePool } from "./thread-peer-core-pool.js";

__mergedSuite("reply-save-fences.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/reply-save-fences.test.ts.
  const DOCUMENT = "ch12" as DocumentId;

  const THREAD = "thread-1" as ThreadId;

  const WORK = "work-a" as WorkId;

  function scenario() {
    const { liveCore, threadCore } = createFakeThreadPeerCores();
    const live = asLiveAgentEditCore(liveCore.asCore());
    const branches = createFakeBranchTable({ documentId: DOCUMENT, threadId: THREAD });
    const drafts = {
      shareActive: vi.fn(async (_id: DraftId) => ({ id: FAKE_DRAFT_ID }) as never),
    };
    const fileAccess = createFakeFileAccess();
    const criticalSections = createBranchCriticalSections();
    const diagnostics = { replyPinMismatch: vi.fn() };
    const fences = createReplySaveFences({
      liveUtilityCore: live,
      branches,
      criticalSections,
      drafts,
      diagnostics,
      fileAccess,
      lockWorks: async () => {},
      lockLiveDocuments: async () => {},
    });
    const core = threadCore.asCore();
    const record: ReplyRecord = {
      responseId: "reply-1",
      threadId: THREAD,
      participants: new Set([core]),
      receipting: new Set(),
      documents: new Map([
        [
          DOCUMENT,
          {
            core,
            grant: fakeEditGrant({ kind: "draft", workId: WORK, workSlug: "a" }),
            linkView: { kind: "draft", draftId: FAKE_DRAFT_ID },
            pin: {
              draftId: FAKE_DRAFT_ID,
              peerBranchId: "peer-1",
              upstreamBranchId: FAKE_UPSTREAM_ID,
            },
          },
        ],
      ]),
    };
    return {
      fences,
      record,
      branches,
      drafts,
      fileAccess,
      threadCore,
      criticalSections,
      diagnostics,
    };
  }

  __mergedSuite("reply save fence", () => {
    it("admits a pin whose draft, upstream and peer all stand", async () => {
      const { fences, record, threadCore } = scenario();
      await expect(fences.confirm(record)).resolves.toEqual([]);
      expect(threadCore.refuseStaged).not.toHaveBeenCalled();
      expect(record.documents.has(DOCUMENT)).toBe(true);
    });
    it("admits a pin after the upstream's generation moved: a pin authorizes identity only", async () => {
      const { fences, record, branches } = scenario();
      branches.set(FAKE_UPSTREAM_ID, {
        ...(await branches.getBranch(FAKE_UPSTREAM_ID))!,
        generation: 9,
      } as never);
      await expect(fences.confirm(record)).resolves.toEqual([]);
    });
    it.each([
      [
        "draft closed",
        (s: ReturnType<typeof scenario>) => s.drafts.shareActive.mockResolvedValue(null as never),
        "discarded_draft",
      ],
      [
        "upstream closed",
        (s: ReturnType<typeof scenario>) => s.branches.close(FAKE_UPSTREAM_ID),
        "discarded_document",
      ],
      [
        "peer closed",
        (s: ReturnType<typeof scenario>) => s.branches.close("peer-1"),
        "discarded_edit",
      ],
    ] as const)("refuses with the reason branch state names: %s", async (_name, arrange, reason) => {
      const s = scenario();
      arrange(s);
      const refused = await s.fences.confirm(s.record);
      expect(refused).toEqual([{ documentId: DOCUMENT, reason }]);
      expect(s.threadCore.refuseStaged).toHaveBeenCalledWith("reply-1", DOCUMENT, reason, "peer-1");
      expect(s.record.documents.has(DOCUMENT)).toBe(false);
      expect(s.record.receipting.size).toBe(1);
      expect(s.record.participants.size).toBe(1);
    });
    it("a vanished upstream or peer refuses with the reason a closed one does", async () => {
      const gone = scenario();
      gone.branches.set(FAKE_UPSTREAM_ID, null);
      await expect(gone.fences.confirm(gone.record)).resolves.toEqual([
        { documentId: DOCUMENT, reason: "discarded_document" },
      ]);
      const lost = scenario();
      lost.branches.set("peer-1", null);
      await expect(lost.fences.confirm(lost.record)).resolves.toEqual([
        { documentId: DOCUMENT, reason: "discarded_edit" },
      ]);
    });
    it("the draft's closure outranks a closed upstream and a closed peer", async () => {
      const s = scenario();
      s.drafts.shareActive.mockResolvedValue(null as never);
      s.branches.close(FAKE_UPSTREAM_ID);
      s.branches.close("peer-1");
      await expect(s.fences.confirm(s.record)).resolves.toEqual([
        { documentId: DOCUMENT, reason: "discarded_draft" },
      ]);
    });
    it("reports an invariant break and refuses as integration for a peer of another draft", async () => {
      const s = scenario();
      s.branches.set("peer-1", {
        ...(await s.branches.getBranch("peer-1"))!,
        draftId: "another-draft" as DraftId,
      } as never);
      await expect(s.fences.confirm(s.record)).resolves.toEqual([
        { documentId: DOCUMENT, reason: "integration" },
      ]);
      expect(s.diagnostics.replyPinMismatch).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: DOCUMENT, threadId: THREAD }),
      );
    });
    it("a denied grant drops the document's writes with the policy's copy and keeps no receipt owner", async () => {
      const s = scenario();
      const denial = { target: { kind: "document", documentId: DOCUMENT }, reason: "archived" };
      s.fileAccess.confirmEdit = vi.fn(async () => [denial]) as never;
      const refused = await s.fences.confirm(s.record);
      expect(refused).toEqual([{ documentId: DOCUMENT, denial }]);
      expect(s.threadCore.invalidateThreadDocument).toHaveBeenCalledWith(DOCUMENT, THREAD);
      expect(s.threadCore.refuseStaged).not.toHaveBeenCalled();
      expect(s.record.participants.size).toBe(0);
    });
    it("holds one sorted lease over every pinned peer and upstream through the save", async () => {
      const { fences, record } = scenario();
      let covered: string[] = [];
      await fences.withLeases(record, async (lease) => {
        covered = ["peer-1", FAKE_UPSTREAM_ID, "other"].filter((id) => lease?.covers(id));
      });
      expect(covered).toEqual(["peer-1", FAKE_UPSTREAM_ID]);
    });
    it("runs a reply with no pinned document without a lease", async () => {
      const { fences, record } = scenario();
      record.documents.get(DOCUMENT)!.pin = undefined;
      await fences.withLeases(record, async (lease) => expect(lease).toBeUndefined());
    });
  });
});

__mergedSuite("response-transaction.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/response-transaction.test.ts.
  __mergedSuite("ResponseTransaction", () => {
    it("aborts every participant in reverse order and tolerates idempotent aborts", async () => {
      const events: string[] = [];
      const abort = vi.fn(() => void events.push("first"));
      await expect(
        runResponseTransaction(
          async (operation) => operation(),
          async () => {
            enlistResponseParticipant({ commit: vi.fn(), abort });
            enlistResponseParticipant({
              commit: vi.fn(),
              abort: () => void events.push("second"),
            });
            throw new Error("fail");
          },
        ),
      ).rejects.toThrow("fail");
      expect(events).toEqual(["second", "first"]);
      expect(abort).toHaveBeenCalledOnce();
    });
    it("keeps durable success total when one commit participant fails", async () => {
      const events: string[] = [];
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          runResponseTransaction(
            async (operation) => operation(),
            async () => {
              enlistResponseParticipant({
                commit() {
                  events.push("failed");
                  throw new Error("publish failed");
                },
                abort: vi.fn(),
              });
              enlistResponseParticipant({
                commit: () => void events.push("remaining"),
                abort: vi.fn(),
              });
              return "committed";
            },
          ),
        ).resolves.toBe("committed");
      } finally {
        consoleError.mockRestore();
      }
      expect(events).toEqual(["failed", "remaining"]);
    });
  });
});

__mergedSuite("thread-peer-core-pool.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/thread-peer-core-pool.test.ts.
  const THREAD_ID = "thread-1" as ThreadId;

  const live: FileDestination = { kind: "live" };

  const draftA: FileDestination = {
    kind: "draft",
    workId: "work-a" as WorkId,
    workSlug: "a",
  };

  /** The drafts and reply fences every pool takes, over fake branch rows. */
  function poolPorts(liveUtilityCore: ReturnType<typeof asLiveAgentEditCore>) {
    const drafts = createFakeDrafts();
    const branches = createFakeBranchTable({ documentId: "ch12", threadId: THREAD_ID });
    const fileAccess = createFakeFileAccess();
    const leases = observeLeases();
    const criticalSections = leases.sections;
    const fences = createReplySaveFences({
      liveUtilityCore,
      branches,
      criticalSections,
      drafts,
      fileAccess,
      lockWorks: async () => {},
      lockLiveDocuments: async () => {},
    });
    return { drafts, branches, fences, leases, fileAccess };
  }

  function createPool() {
    const { pullThreadPeer, liveCore, threadCore } = createFakeThreadPeerCores();
    const liveUtilityCore = asLiveAgentEditCore(liveCore.asCore());
    const ports = poolPorts(liveUtilityCore);
    const pool = createThreadPeerCorePool({
      drafts: ports.drafts,
      branches: { getBranch: async () => null },
      fences: ports.fences,
      liveUtilityCore,
      createThreadCore: () => threadCore.asCore(),
      pullThreadPeer: pullThreadPeer,
      afterLiveCommit: () => {},
      commitThreadResponseAtomically: (operation) => operation(),
      ...inProcessResponseTransactions,
      fileAccess: createFakeFileAccess(),
      lockWorks: async () => {},
      lockLiveDocuments: async () => {},
    });
    return { pool, liveCore, threadCore, pullThreadPeer, ...ports };
  }

  const context = (destination: FileDestination, responseId?: string) => ({
    sessionId: THREAD_ID,
    threadId: THREAD_ID,
    turnId: "turn-1",
    grant: fakeEditGrant(destination),
    ...(responseId
      ? { responseIdentity: { providerResponseId: responseId, editScopeId: responseId } }
      : {}),
  });

  const readCh12 = { file: "ch12.md", documentId: "ch12" };

  const insertCh12 = {
    command: "insert",
    file: "ch12.md",
    documentId: "ch12",
    content: "x",
  } as const;

  __mergedSuite("thread-peer pool", () => {
    it("refuses a write in a version other than the last read until a re-read (D41)", async () => {
      const { pool, liveCore, threadCore } = createPool();
      await pool.read(readCh12, context(live));
      const refused = await pool.write(insertCh12, context(draftA));
      expect(refused).toMatchObject({ status: "read_required", isError: true });
      expect(threadCore.write).not.toHaveBeenCalled();
      await pool.read(readCh12, context(draftA));
      await expect(pool.write(insertCh12, context(draftA))).resolves.toMatchObject({
        status: "success",
      });
      expect(liveCore.write).not.toHaveBeenCalled();
    });
    // History cannot silently move an inverse command to a different destination.
    it("routes model undo to the current destination, even after a peer pull", async () => {
      const { pool, liveCore, threadCore, pullThreadPeer } = createPool();
      await pullThreadPeer({ documentId: "ch12" as DocumentId, threadId: THREAD_ID });
      await pool.write({ command: "undo", file: "ch12.md", documentId: "ch12" }, context(draftA));
      expect(threadCore.write).toHaveBeenCalledOnce();
      expect(liveCore.write).not.toHaveBeenCalled();
    });
    it("keeps a document's first destination for the rest of the reply (D19, D42)", async () => {
      const { pool, liveCore, threadCore } = createPool();
      await pool.write(insertCh12, context(draftA, "reply-1"));
      await pool.write(insertCh12, context(live, "reply-1"));
      expect(threadCore.write).toHaveBeenCalledTimes(2);
      expect(liveCore.write).not.toHaveBeenCalled();
      // Closing a reply must reach its first owner even before acquisition settles.
      const lateWrites = [];
      for (const pausedEviction of [true, false]) {
        const liveHarness = harness({ "alpha.md": "red" });
        const acquired: ReturnType<typeof harness>[] = [];
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const reached = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const closingPorts = poolPorts(asLiveAgentEditCore(liveHarness.core));
        const closingPool = createThreadPeerCorePool({
          drafts: closingPorts.drafts,
          branches: { getBranch: async () => null },
          fences: closingPorts.fences,
          liveUtilityCore: asLiveAgentEditCore(liveHarness.core),
          createThreadCore: () => {
            const owner = harness({ "alpha.md": "red" });
            acquired.push(owner);
            if (pausedEviction && acquired.length === 1) {
              const invalidate = owner.core.evictThread.bind(owner.core);
              let first = true;
              owner.core.evictThread = async (...args) => {
                if (first) {
                  first = false;
                  entered();
                  await gate;
                }
                return invalidate(...args);
              };
            }
            return owner.core;
          },
          pullThreadPeer: async () =>
            pausedEviction
              ? undefined
              : {
                  peerBranchId: "peer-1",
                  upstreamBranchId: "upstream-1",
                  branchGeneration: 1,
                  attributionBaseline: new Uint8Array(),
                },
          commitThreadResponseAtomically: (operation) => operation(),
          ...inProcessResponseTransactions,
          fileAccess: createFakeFileAccess(),
          lockWorks: async () => {},
          lockLiveDocuments: async () => {},
          maxThreadCores: 1,
        });
        if (pausedEviction) {
          await closingPool.read(
            { file: "alpha.md", documentId: "alpha.md" },
            {
              ...context(draftA),
              threadId: "idle",
            },
          );
        }
        const write = closingPool.write(
          {
            command: "insert",
            file: "alpha.md",
            documentId: "alpha.md",
            content: "added",
          },
          context(draftA, "closing"),
        );
        if (pausedEviction) await reached;
        await expect(closingPool.rollbackResponse("closing")).resolves.toMatchObject({
          status: "rolledBack",
        });
        release();
        const outcome = await write;
        lateWrites.push({
          status: outcome.status,
          isError: outcome.isError,
          poolHas: closingPool.hasResponseDocument("closing", "alpha.md"),
          coreHas: acquired.at(-1)?.core.hasResponseDocument("closing", "alpha.md"),
        });
      }
      expect(lateWrites).toEqual([
        { status: "invalid_write", isError: true, poolHas: false, coreHas: false },
        { status: "invalid_write", isError: true, poolHas: false, coreHas: false },
      ]);
    });
  });

  __mergedSuite("reasoned refusal and retirement through the pool", () => {
    const replyContext = (responseId: string, threadId = THREAD_ID) => ({
      ...context(draftA, responseId),
      threadId,
    });
    it("refuseStaged evicts the response's entry so a later write ensures a fresh draft and peer (U2)", async () => {
      const { pool, threadCore, drafts, pullThreadPeer } = createPool();
      await pool.write(insertCh12, context(draftA, "reply-1"));
      expect(drafts.ensureActiveForWrite).toHaveBeenCalledTimes(1);
      pool.refuseStaged("reply-1", "ch12", "discarded_draft");
      expect(threadCore.refuseStaged).toHaveBeenCalledWith(
        "reply-1",
        "ch12",
        "discarded_draft",
        undefined,
      );
      expect(pool.responseDestination("reply-1", "ch12")).toBeUndefined();
      await pool.write(insertCh12, context(draftA, "reply-1"));
      expect(drafts.ensureActiveForWrite).toHaveBeenCalledTimes(2);
      expect(pullThreadPeer).toHaveBeenCalledTimes(2);
      expect(pool.responseDestination("reply-1", "ch12")).toMatchObject({
        kind: "draft",
      });
    });
    it("rolls a reply back inside its leases without touching a branch (U5)", async () => {
      const { pool, threadCore, branches, leases } = createPool();
      await pool.write(insertCh12, context(draftA, "reply-1"));
      branches.getBranch.mockClear();
      let heldDuringRollback: string[][] = [];
      threadCore.rollbackResponse.mockImplementation(async (responseId: string) => {
        heldDuringRollback = leases.holding();
        return {
          status: "rolledBack" as const,
          responseId,
          stagedCreates: { committed: [], discarded: [] },
        };
      });
      const before = leases.entered();
      await pool.rollbackResponse("reply-1");
      expect(heldDuringRollback).toEqual([["peer-1", "upstream-1"]]);
      expect(leases.entered() - before).toBe(1);
      expect(leases.holding()).toEqual([]);
      expect(branches.getBranch).not.toHaveBeenCalled();
    });
    it("retires one peer without touching the replacement peer's entry or lastSeen (U6)", async () => {
      const { pool, threadCore } = createPool();
      // Reply 1 stages on peer-1; reply 2, in the same thread, on its replacement peer-2.
      await pool.write(insertCh12, replyContext("reply-1"));
      await pool.write(insertCh12, replyContext("reply-2"));
      await pool.retireThreadPeers("ch12", [
        { threadId: THREAD_ID, peerBranchId: "peer-1", reason: "discarded_edit" },
      ]);
      expect(threadCore.retirePeer).toHaveBeenCalledWith({
        documentId: "ch12",
        threadId: THREAD_ID,
        peerBranchId: "peer-1",
        reason: "discarded_edit",
      });
      expect(pool.responseDestination("reply-1", "ch12")).toBeUndefined();
      expect(pool.responseDestination("reply-2", "ch12")).toMatchObject({
        kind: "draft",
      });
      // The replacement peer's read still stands: a write to another version needs a re-read.
      await expect(pool.write(insertCh12, context(live))).resolves.toMatchObject({
        status: "read_required",
      });
      await pool.retireThreadPeers("ch12", [
        { threadId: THREAD_ID, peerBranchId: "peer-2", reason: "discarded_edit" },
      ]);
      expect(pool.responseDestination("reply-2", "ch12")).toBeUndefined();
    });
    it("reaches a response-pinned owner the cache evicted (U6)", async () => {
      const { pullThreadPeer, liveCore } = createFakeThreadPeerCores();
      const cores = new Map<string, ReturnType<typeof createFakeThreadPeerCores>["threadCore"]>();
      const live = asLiveAgentEditCore(liveCore.asCore());
      const ports = poolPorts(live);
      const pool = createThreadPeerCorePool({
        drafts: ports.drafts,
        branches: { getBranch: async () => null },
        fences: ports.fences,
        liveUtilityCore: live,
        createThreadCore: (threadId) => {
          const core = createFakeThreadPeerCores().threadCore;
          cores.set(threadId, core);
          return core.asCore();
        },
        pullThreadPeer,
        commitThreadResponseAtomically: (operation) => operation(),
        ...inProcessResponseTransactions,
        fileAccess: createFakeFileAccess(),
        lockWorks: async () => {},
        lockLiveDocuments: async () => {},
        maxThreadCores: 1,
      });
      await pool.write(insertCh12, replyContext("reply-a", "thread-a" as ThreadId));
      // A second thread crowds thread A out of the cache; its open reply still owns its core.
      await pool.write(insertCh12, replyContext("reply-b", "thread-b" as ThreadId));
      await pool.evictThread("thread-a" as ThreadId);
      await pool.retireThreadPeers("ch12", [
        { threadId: "thread-a", peerBranchId: "peer-1", reason: "discarded_document" },
      ]);
      expect(cores.get("thread-a")?.retirePeer).toHaveBeenCalledWith(
        expect.objectContaining({ peerBranchId: "peer-1", reason: "discarded_document" }),
      );
      expect(cores.get("thread-b")?.retirePeer).not.toHaveBeenCalled();
    });
  });
});

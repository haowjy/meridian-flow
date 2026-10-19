/** Pool routing per document (D19, D42), live undo routing, and read-version checks (D41). */

import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { harness } from "../../../../../../packages/agent-edit/src/tool/test-support/write-tool-harness.js";
import type { FileDestination } from "../../file-policy/index.js";
import {
  createFakeBranches,
  createFakeDraftTable,
  createFakeFileAccess,
  createFakeThreadPeerCores,
  fakeEditGrant,
  fakeWorkDrafts,
  inProcessResponseTransactions,
} from "../test-support/thread-peer-pool-fakes.js";
import { asLiveAgentEditCore } from "./agent-edit-cores.js";
import { createReplySaveFences } from "./reply-save-fences.js";
import { createThreadPeerCorePool } from "./thread-peer-core-pool.js";

const THREAD_ID = "thread-1" as ThreadId;
const live: FileDestination = { kind: "live" };
const draftA: FileDestination = { kind: "draft", workId: "work-a" as WorkId, workSlug: "a" };

/** The branches and reply fences every pool takes, over fake branch and draft rows. */
function poolPorts(liveUtilityCore: ReturnType<typeof asLiveAgentEditCore>) {
  const branches = createFakeBranches();
  const drafts = createFakeDraftTable({ documentId: "ch12", threadId: THREAD_ID });
  const fileAccess = createFakeFileAccess();
  const fences = createReplySaveFences({
    liveUtilityCore,
    drafts,
    branches,
    fileAccess,
    lockWorks: async () => {},
    lockLiveDocuments: async () => {},
  });
  return { branches, drafts, fences, fileAccess };
}

function createPool() {
  const { ensureThreadPeer, liveCore, threadCore } = createFakeThreadPeerCores();
  const liveUtilityCore = asLiveAgentEditCore(liveCore.asCore());
  const ports = poolPorts(liveUtilityCore);
  const pool = createThreadPeerCorePool({
    branches: ports.branches,
    drafts: fakeWorkDrafts,
    fences: ports.fences,
    liveUtilityCore,
    createThreadCore: () => threadCore.asCore(),
    ensureThreadPeer,
    afterLiveCommit: () => {},
    commitThreadResponseAtomically: (operation) => operation(),
    attemptScope: (operation) => operation(),
    ...inProcessResponseTransactions,
    fileAccess: createFakeFileAccess(),
    lockWorks: async () => {},
    lockLiveDocuments: async () => {},
  });
  return { pool, liveCore, threadCore, ensureThreadPeer, ...ports };
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

describe("thread-peer pool", () => {
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
  it("routes model undo to the current destination, even after a peer ensure", async () => {
    const { pool, liveCore, threadCore, ensureThreadPeer } = createPool();
    await ensureThreadPeer({ documentId: "ch12" as DocumentId, threadId: THREAD_ID });

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
    for (const pausedEnsure of [true, false]) {
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
        branches: closingPorts.branches,
        drafts: fakeWorkDrafts,
        fences: closingPorts.fences,
        liveUtilityCore: asLiveAgentEditCore(liveHarness.core),
        createThreadCore: () => {
          const owner = harness({ "alpha.md": "red" });
          acquired.push(owner);
          return owner.core;
        },
        ensureThreadPeer: async () => {
          if (pausedEnsure) {
            entered();
            await gate;
          }
          return { peerDraftId: "peer-1", upstreamDraftId: "upstream-1" };
        },
        commitThreadResponseAtomically: (operation) => operation(),
        attemptScope: (operation) => operation(),
        ...inProcessResponseTransactions,
        fileAccess: createFakeFileAccess(),
        lockWorks: async () => {},
        lockLiveDocuments: async () => {},
        maxThreadCores: 1,
      });
      const write = closingPool.write(
        {
          command: "insert",
          file: "alpha.md",
          documentId: "alpha.md",
          content: "added",
        },
        context(draftA, "closing"),
      );
      if (pausedEnsure) await reached;
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

describe("reasoned refusal and retirement through the pool", () => {
  const replyContext = (responseId: string, threadId = THREAD_ID) => ({
    ...context(draftA, responseId),
    threadId,
  });

  it("refuseStaged evicts the response's entry so a later write ensures a fresh branch and peer (U2)", async () => {
    const { pool, threadCore, branches, ensureThreadPeer } = createPool();
    await pool.write(insertCh12, context(draftA, "reply-1"));
    expect(branches.ensureActiveForWrite).toHaveBeenCalledTimes(1);

    pool.refuseStaged("reply-1", "ch12", "discarded_draft");
    expect(threadCore.refuseStaged).toHaveBeenCalledWith(
      "reply-1",
      "ch12",
      "discarded_draft",
      undefined,
    );
    expect(pool.responseDestination("reply-1", "ch12")).toBeUndefined();

    await pool.write(insertCh12, context(draftA, "reply-1"));
    expect(branches.ensureActiveForWrite).toHaveBeenCalledTimes(2);
    expect(ensureThreadPeer).toHaveBeenCalledTimes(2);
    expect(pool.responseDestination("reply-1", "ch12")).toMatchObject({ kind: "draft" });
  });

  it("retires one peer without touching the replacement peer's entry or lastSeen (U6)", async () => {
    const { pool, threadCore } = createPool();
    // Reply 1 stages on peer-1; reply 2, in the same thread, on its replacement peer-2.
    await pool.write(insertCh12, replyContext("reply-1"));
    await pool.write(insertCh12, replyContext("reply-2"));

    await pool.retireThreadPeers("ch12", [
      { threadId: THREAD_ID, peerDraftId: "peer-1", reason: "discarded_edit" },
    ]);

    expect(threadCore.retirePeer).toHaveBeenCalledWith({
      documentId: "ch12",
      threadId: THREAD_ID,
      peerDraftId: "peer-1",
      reason: "discarded_edit",
    });
    expect(pool.responseDestination("reply-1", "ch12")).toBeUndefined();
    expect(pool.responseDestination("reply-2", "ch12")).toMatchObject({ kind: "draft" });
    // The replacement peer's read still stands: a write to another version needs a re-read.
    await expect(pool.write(insertCh12, context(live))).resolves.toMatchObject({
      status: "read_required",
    });

    await pool.retireThreadPeers("ch12", [
      { threadId: THREAD_ID, peerDraftId: "peer-2", reason: "discarded_edit" },
    ]);
    expect(pool.responseDestination("reply-2", "ch12")).toBeUndefined();
  });

  it("reaches a response-pinned owner the cache evicted (U6)", async () => {
    const { ensureThreadPeer, liveCore } = createFakeThreadPeerCores();
    const cores = new Map<string, ReturnType<typeof createFakeThreadPeerCores>["threadCore"]>();
    const live = asLiveAgentEditCore(liveCore.asCore());
    const ports = poolPorts(live);
    const pool = createThreadPeerCorePool({
      branches: ports.branches,
      drafts: fakeWorkDrafts,
      fences: ports.fences,
      liveUtilityCore: live,
      createThreadCore: (threadId) => {
        const core = createFakeThreadPeerCores().threadCore;
        cores.set(threadId, core);
        return core.asCore();
      },
      ensureThreadPeer,
      commitThreadResponseAtomically: (operation) => operation(),
      attemptScope: (operation) => operation(),
      ...inProcessResponseTransactions,
      fileAccess: createFakeFileAccess(),
      lockWorks: async () => {},
      lockLiveDocuments: async () => {},
      maxThreadCores: 1,
    });
    await pool.write(insertCh12, replyContext("reply-a", "thread-a" as ThreadId));
    // A second thread crowds thread A out of the cache; its open reply still owns its core.
    await pool.write(insertCh12, replyContext("reply-b", "thread-b" as ThreadId));

    await pool.retireThreadPeers("ch12", [
      { threadId: "thread-a", peerDraftId: "peer-1", reason: "discarded_document" },
    ]);

    expect(cores.get("thread-a")?.retirePeer).toHaveBeenCalledWith(
      expect.objectContaining({ peerDraftId: "peer-1", reason: "discarded_document" }),
    );
    expect(cores.get("thread-b")?.retirePeer).not.toHaveBeenCalled();
  });
});

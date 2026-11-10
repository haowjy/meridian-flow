/** Pool routing per document (D19, D42), live undo routing, and peer-cache lifecycle.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Reply destination pins
 */

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
const draftA: FileDestination = {
  kind: "draft",
  owner: { kind: "work", workId: "work-a" as WorkId },
  ownerHandle: "a",
};

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
    removals: { lookup: async () => new Map() },
    lockOwners: async () => {},
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
    removals: { lookup: async () => new Map() },
    fences: ports.fences,
    liveUtilityCore,
    createThreadCore: () => threadCore.asCore(),
    ensureThreadPeer,
    afterLiveCommit: () => {},
    commitThreadResponseAtomically: (operation) => operation(),
    attemptScope: (operation) => operation(),
    ...inProcessResponseTransactions,
    fileAccess: createFakeFileAccess(),
    lockOwners: async () => {},
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
const insertCh12 = {
  command: "insert",
  file: "ch12.md",
  documentId: "ch12",
  content: "x",
} as const;

describe("thread-peer pool", () => {
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
        removals: { lookup: async () => new Map() },
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
          return { peerDraftId: "peer-1", upstreamDraftId: "upstream-1", seed: null };
        },
        commitThreadResponseAtomically: (operation) => operation(),
        attemptScope: (operation) => operation(),
        ...inProcessResponseTransactions,
        fileAccess: createFakeFileAccess(),
        lockOwners: async () => {},
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

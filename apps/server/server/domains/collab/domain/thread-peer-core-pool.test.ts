/** Pool routing per document (D19, D42), live undo routing, and read-version checks (D41). */

import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { harness } from "../../../../../../packages/agent-edit/src/tool/test-support/write-tool-harness.js";
import { createAllowAllFileAccess } from "../../../domains/file-policy/index.js";
import { testFileGrant } from "../../../test-support/file-grants.js";
import type { FileDestination } from "../../file-policy/index.js";
import {
  createFakeThreadPeerCores,
  inProcessResponseTransactions,
} from "../test-support/thread-peer-pool-fakes.js";
import { asLiveAgentEditCore } from "./agent-edit-cores.js";
import { createThreadPeerCorePool } from "./thread-peer-core-pool.js";

const THREAD_ID = "thread-1" as ThreadId;
const live: FileDestination = { kind: "live" };
const draftA: FileDestination = { kind: "draft", workId: "work-a" as WorkId, workSlug: "a" };
function createPool() {
  const { history, liveCore, threadCore } = createFakeThreadPeerCores();
  const pool = createThreadPeerCorePool({
    liveUtilityCore: asLiveAgentEditCore(liveCore.asCore()),
    createThreadCore: () => threadCore.asCore(),
    reversalHistory: history.reader,
    liveHistory: history.liveHistory,
    discardThreadPeerBranches: async () => {},
    pullThreadPeer: history.pullThreadPeer,
    afterLiveCommit: () => {},
    commitThreadResponseAtomically: (operation) => operation(),
    ...inProcessResponseTransactions,
    fileAccess: createAllowAllFileAccess(),
    lockWorks: async () => {},
    lockLiveDocuments: async () => {},
  });
  return { pool, liveCore, threadCore, pullThreadPeer: history.pullThreadPeer };
}

const context = (destination: FileDestination, responseId?: string) => ({
  sessionId: THREAD_ID,
  threadId: THREAD_ID,
  turnId: "turn-1",
  grant: testFileGrant(destination),
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
      const history = createFakeThreadPeerCores().history;
      const closingPool = createThreadPeerCorePool({
        liveUtilityCore: asLiveAgentEditCore(liveHarness.core),
        createThreadCore: () => {
          const owner = harness({ "alpha.md": "red" });
          acquired.push(owner);
          if (pausedEviction && acquired.length === 1) {
            const invalidate = owner.core.invalidateThread.bind(owner.core);
            let first = true;
            owner.core.invalidateThread = async (...args) => {
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
        reversalHistory: history.reader,
        liveHistory: history.liveHistory,
        discardThreadPeerBranches: async () => {},
        pullThreadPeer: async () =>
          pausedEviction
            ? undefined
            : { branchGeneration: 1, attributionBaseline: new Uint8Array() },
        commitThreadResponseAtomically: (operation) => operation(),
        ...inProcessResponseTransactions,
        fileAccess: createAllowAllFileAccess(),
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

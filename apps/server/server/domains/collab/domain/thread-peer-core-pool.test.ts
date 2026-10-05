/** Pool routing per document (D19, D42), live undo routing, and read-version checks (D41). */

import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createAllowAllFileAccess } from "../../../domains/file-policy/index.js";
import { testFileGrant } from "../../../test-support/file-grants.js";
import {
  createFakeThreadPeerCores,
  inProcessResponseTransactions,
} from "../test-support/thread-peer-pool-fakes.js";
import { type AgentEditDestination, asLiveAgentEditCore } from "./agent-edit-cores.js";
import { createThreadPeerCorePool } from "./thread-peer-core-pool.js";

const THREAD_ID = "thread-1" as ThreadId;
const live: AgentEditDestination = { kind: "live" };
const draftA: AgentEditDestination = { kind: "draft", workId: "work-a" as WorkId, workSlug: "a" };
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
    lockLiveDocuments: async () => {},
  });
  return { pool, liveCore, threadCore, pullThreadPeer: history.pullThreadPeer };
}

const context = (destination: AgentEditDestination, responseId?: string) => ({
  sessionId: THREAD_ID,
  threadId: THREAD_ID,
  turnId: "turn-1",
  grant: testFileGrant(destination),
  ...(responseId ? { responseId } : {}),
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

  // The stray .manifest peer made every live undo throw BranchNotFoundError.
  it("keeps undo live for a thread that pulled a peer but never drafted", async () => {
    const { pool, liveCore, threadCore, pullThreadPeer } = createPool();
    await pullThreadPeer({ documentId: "ch12" as DocumentId, threadId: THREAD_ID });

    await pool.write({ command: "undo", file: "ch12.md", documentId: "ch12" }, context(draftA));

    expect(liveCore.write).toHaveBeenCalledOnce();
    expect(threadCore.write).not.toHaveBeenCalled();
  });

  it("keeps a document's first destination for the rest of the reply (D19, D42)", async () => {
    const { pool, liveCore, threadCore } = createPool();
    await pool.write(insertCh12, context(draftA, "reply-1"));
    await pool.write(insertCh12, context(live, "reply-1"));

    expect(threadCore.write).toHaveBeenCalledTimes(2);
    expect(liveCore.write).not.toHaveBeenCalled();
  });
});

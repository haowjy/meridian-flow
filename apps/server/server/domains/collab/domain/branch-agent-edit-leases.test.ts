/**
 * A thread core's document access takes its peer's and its draft branch's leases in one
 * ordered acquisition, the order a reply's save and a whole-draft close use (contract
 * §14), so an immediate write and a close never wait on each other in a cycle.
 */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import { unimplementedBranchMutations } from "../test-support/unimplemented-branch-mutations.js";
import { createBranchAgentEditCoordinator } from "./branch-agent-edit.js";
import { type BranchSnapshot, createBranchCoordinator } from "./branch-coordinator.js";
import { createBranchCriticalSections } from "./branch-critical-sections.js";

const threadId = "thread-1" as ThreadId;
const documentId = "document-1" as DocumentId;
// The draft branch's id sorts before its peer's: the order a peer-first access inverts.
const UPSTREAM = "branch_a";
const PEER = "branch_z";

function snapshot(branchId: string): BranchSnapshot {
  const doc = createCollabYDoc({ gc: false });
  return {
    branchId,
    documentId,
    kind: branchId === PEER ? "thread_peer" : "work_draft",
    upstreamBranchId: branchId === PEER ? UPSTREAM : null,
    draftId: "draft-1",
    workId: "work-1",
    threadId: branchId === PEER ? threadId : null,
    status: "active",
    generation: 1,
    state: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc),
    schemaVersion: COLLAB_SCHEMA_VERSION,
  };
}

describe("thread-core branch leases", () => {
  it("an immediate access holding its leases and an ordered close queued behind it both finish", async () => {
    const mutex = new KeyedMutex();
    const held: string[] = [];
    const run = mutex.run.bind(mutex);
    mutex.run = (key, fn) =>
      run(key, () => {
        held.push(key);
        return fn();
      });
    const sections = createBranchCriticalSections(mutex);
    // The edit's own update, journaled as the staged write the access commits.
    const edit: { update: Uint8Array } = { update: new Uint8Array() };
    const store = {
      getBranch: async (id: string) => snapshot(id),
      updateBranchSnapshot: async () => true,
      deferUntilCommit: () => false,
      ...unimplementedBranchMutations(),
      commitBranchMutation: async () => true,
    };
    const branchCoordinator = createBranchCoordinator({ store, criticalSections: sections });
    const coordinator = createBranchAgentEditCoordinator({
      threadId,
      branchCoordinator,
      branches: {
        getBranch: store.getBranch,
        resolveThreadBranch: async () => ({
          branchId: PEER,
          generation: 1,
          doc: createCollabYDoc({ gc: false }),
        }),
        ensureThreadPeerBranch: async () => {
          throw new Error("an access never makes a peer");
        },
        listActiveWorkDraftBranchIds: async () => [UPSTREAM],
      },
      // The staged write the access commits to the draft branch, fenced at its generation.
      pendingJournalEntries: {
        push() {},
        shiftBatch: () => [
          {
            docId: documentId,
            update: edit.update,
            meta: { origin: "agent:turn-1", seq: 0 },
            mutation: { mode: "threadPeer", branchGeneration: 1, threadId, wId: 1 },
          } as never,
        ],
      },
      afterCommit: (callback) => void callback(),
      enlistResponseParticipant: () => false,
      model: undefined as never,
      codec: undefined as never,
    });

    let inside!: () => void;
    const entered = new Promise<void>((resolve) => {
      inside = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The one order run: the immediate edit holds its leases at the gate, the close queues behind.
    const immediate = coordinator.withDocument(documentId, async (doc) => {
      inside();
      await gate;
      doc.once("update", (update: Uint8Array) => {
        edit.update = update;
      });
      doc.getText("probe").insert(0, "edit");
      return "edited";
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered;
      const close = sections.withBranches([PEER, UPSTREAM], async () => "closed");
      release();
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("the edit and the close wait in a cycle")),
          1_000,
        );
      });
      await expect(Promise.race([Promise.all([immediate, close]), timeout])).resolves.toEqual([
        "edited",
        "closed",
      ]);
    } finally {
      clearTimeout(deadline);
      release();
    }

    expect(held.slice(0, 2), "the access took both leases, draft branch first").toEqual([
      UPSTREAM,
      PEER,
    ]);
  });
});

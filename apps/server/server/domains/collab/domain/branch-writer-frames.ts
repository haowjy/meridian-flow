/**
 * Writer-frame admission over the branch runtime: a frame judged on a private candidate of the
 * committed replica (admissibility, the room, the cheap echo exit, authorship as an early
 * rejection) and appended once, sequenced by the branch row's lock and finalized there against
 * what is committed (design §2), and the background tail fold a committed frame can trigger.
 * The runtime (`branch-coordinator.ts`) owns the replicas, candidates and publication; this
 * module owns only what a frame decides before the lock.
 */
import type * as Y from "yjs";
import type {
  BranchRuntime,
  PublishedReplica,
  RoomReconcileTrigger,
} from "./branch-coordinator.js";
import { BranchStaleUpdateError } from "./branch-store.js";
import { collabHook } from "./collab-test-hooks.js";
import { admitWriterUpdate } from "./document-mutation-policy.js";

/** A tail past either bound is folded into a new checkpoint in the background (D10). */
const COMPACT_TAIL_ROWS = 512;
const COMPACT_TAIL_BYTES = 2 * 1024 * 1024;

export type WriterFrameInput = {
  branchId: string;
  expectedGeneration: number;
  updateData: Uint8Array;
  actorUserId?: string;
  roomDocument: Y.Doc;
};

export type WriterFrameDiagnostics = {
  /** The background tail fold failed; the tail stays until the next frame crosses the bound. */
  compactionFailed(input: { branchId: string; cause: unknown }): void;
  /** A room lacked committed content and was brought up to the replica (decision D26). */
  roomReconciled(input: {
    branchId: string;
    generation: number;
    revision: number;
    trigger: RoomReconcileTrigger;
    bytes: number;
  }): void;
  /**
   * An update reached the row lock before the update it depends on reached the journal: not
   * sequenced, and its socket resyncs. Repeated on one branch, it is a server defect.
   */
  appendPrefixMissing(input: {
    branchId: string;
    clocks: readonly { client: number; clock: number }[];
  }): void;
  /** A projection run failed; the branch is retried on its backoff and never dropped. */
  projectionFailed(input: { branchId: string; cause: unknown }): void;
  /**
   * A legacy branch's baseline cannot be established: its document has a terminally blocked
   * settlement. Once per process; the branch waits for its next append or a restart.
   */
  projectionBaselineBlocked(input: { branchId: string; documentId: string }): void;
};

export function createWriterFrames(
  runtime: BranchRuntime,
  input: { diagnostics?: WriterFrameDiagnostics },
) {
  const compacting = new Set<string>();

  /**
   * A writer frame: judged once on a private candidate of the committed replica, then appended
   * at whatever revision the branch is at. A concurrent writer costs the frame one row-lock
   * wait, never a second judgement: what landed meanwhile is folded into the committed prefix
   * under the lock. The room is checked against the replica first, and a room that lacks it
   * missed a delivery: it is reconciled and the frame goes on (decision D26). Only a closed
   * branch, a frozen Work or a generation the branch has left refuses the frame; an update
   * whose prefix the journal lacks throws `BranchPrefixMissingError` for the gateway's resync.
   */
  async function commitWriterUpdate(frame: WriterFrameInput): Promise<{ admitted: boolean }> {
    const write = await judgeWriterUpdate(frame);
    if (!write) return { admitted: false };
    const wrote = await runtime.commitOnce(write, {});
    if (!wrote) return { admitted: false };
    await collabHook("branch.append.afterCommit");
    compactIfLong(frame.branchId);
    return { admitted: true };
  }

  /** The frame judged on the committed replica: its prepared append, or null when contained. */
  async function judgeWriterUpdate(frame: WriterFrameInput) {
    const base = await runtime.loadBase(frame.branchId);
    const { snapshot, replica } = base;
    const admissible =
      snapshot.kind === "work_draft" &&
      snapshot.status === "active" &&
      snapshot.lifecycle === "active" &&
      snapshot.generation === frame.expectedGeneration;
    if (admissible)
      runtime.reconcileRoom({
        branchId: frame.branchId,
        room: frame.roomDocument,
        replica,
        trigger: "frame",
      });
    const admission = await admitWriterUpdate({
      targetDocument: replica.doc,
      update: frame.updateData,
      validateTarget() {
        if (!admissible) throw new BranchStaleUpdateError(frame.branchId);
      },
      isContained: () => runtime.containment.contains(replica.doc, frame.updateData),
      append: async () =>
        runtime.prepareAppend(base, [
          {
            branchId: frame.branchId,
            generation: snapshot.generation,
            updateData: frame.updateData,
            source: "writer",
            actorUserId: frame.actorUserId,
          },
        ]),
    });
    return admission.admitted ? admission.value : null;
  }

  /**
   * Folds a long tail into a new checkpoint in the background. `compacting` keeps one fold per
   * branch in this process; anything else is the fold fence's: compaction is content-free, so
   * a frame or inverse that lands meanwhile is folded in, and a rewrite that commits first
   * makes it miss (the next frame past the bound tries again). Called after a writer frame
   * commits, outside every transaction; a failure is reported and leaves the tail for the
   * next frame.
   */
  function compactIfLong(branchId: string): void {
    const long = ({ tail }: PublishedReplica) =>
      tail.rows >= COMPACT_TAIL_ROWS || tail.bytes >= COMPACT_TAIL_BYTES;
    const replica = runtime.published(branchId);
    if (!replica || compacting.has(branchId) || !long(replica)) return;
    compacting.add(branchId);
    void (async () => {
      const { replica: current } = await runtime.loadBase(branchId);
      if (!long(current)) return;
      const write = runtime.prepareRewrite(branchId, runtime.cloneReplica(current), {
        policy: runtime.foldPolicy(current),
        fence: { kind: "none" },
        operation: { kind: "compact" },
      });
      // A moved or closed branch: the next frame past the bound tries again.
      await runtime.commitOnce(write, { moved: () => {} });
    })()
      .catch((cause: unknown) => input.diagnostics?.compactionFailed({ branchId, cause }))
      .finally(() => compacting.delete(branchId));
  }

  return { commitWriterUpdate };
}

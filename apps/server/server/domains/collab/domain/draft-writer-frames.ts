/**
 * Writer-frame admission over the draft runtime: a frame judged on a private candidate of the
 * committed replica (admissibility, the room, the cheap echo exit, authorship as an early
 * rejection) and appended once, sequenced by the draft row's lock and finalized there against
 * what is committed (design §2), and the background tail fold a committed frame can trigger.
 * The runtime (`draft-coordinator.ts`) owns the replicas, candidates and their installation; this
 * module owns only what a frame decides before the lock.
 */
import type * as Y from "yjs";
import { testHook } from "../../../shared/test-hooks.js";
import { admitWriterUpdate } from "./document-mutation-policy.js";
import type { CommittedReplica, DraftRuntime, RoomReconcileTrigger } from "./draft-coordinator.js";
import { DraftStaleUpdateError } from "./draft-store.js";

/** A tail past either bound is folded into a new checkpoint in the background (D10). */
const COMPACT_TAIL_ROWS = 512;
const COMPACT_TAIL_BYTES = 2 * 1024 * 1024;

export type WriterFrameInput = {
  draftId: string;
  expectedGeneration: number;
  updateData: Uint8Array;
  actorUserId?: string;
  roomDocument: Y.Doc;
};

export type WriterFrameDiagnostics = {
  /** The background tail fold failed; the tail stays until the next frame crosses the bound. */
  compactionFailed(input: { draftId: string; cause: unknown }): void;
  /** A room lacked committed content and was brought up to the replica (decision D26). */
  roomReconciled(input: {
    draftId: string;
    generation: number;
    revision: number;
    trigger: RoomReconcileTrigger;
    bytes: number;
  }): void;
  /**
   * An update reached the row lock before the update it depends on reached the journal: not
   * sequenced, and its socket resyncs. Repeated on one draft, it is a server defect.
   */
  appendPrefixMissing(input: {
    draftId: string;
    clocks: readonly { client: number; clock: number }[];
  }): void;
};

export function createWriterFrames(
  runtime: DraftRuntime,
  input: { diagnostics?: WriterFrameDiagnostics },
) {
  const compacting = new Set<string>();

  /**
   * A writer frame: judged once on a private candidate of the committed replica, then appended
   * at whatever revision the draft is at. A concurrent writer costs the frame one row-lock
   * wait, never a second judgement: what landed meanwhile is folded into the committed prefix
   * under the lock. The room is checked against the replica first, and a room that lacks it
   * missed a delivery: it is reconciled and the frame goes on (decision D26). Only a closed
   * draft, a frozen Work or a generation the draft has left refuses the frame; an update
   * whose prefix the journal lacks throws `DraftPrefixMissingError` for the gateway's resync.
   */
  async function commitWriterUpdate(frame: WriterFrameInput): Promise<{ admitted: boolean }> {
    const write = await judgeWriterUpdate(frame);
    if (!write) return { admitted: false };
    const wrote = await runtime.commitOnce(write, {});
    if (!wrote) return { admitted: false };
    await testHook("draft.append.afterCommit");
    compactIfLong(frame.draftId);
    return { admitted: true };
  }

  /** The frame judged on the committed replica: its prepared append, or null when contained. */
  async function judgeWriterUpdate(frame: WriterFrameInput) {
    const base = await runtime.loadBase(frame.draftId);
    const { snapshot, replica } = base;
    const admissible =
      snapshot.kind === "work_draft" &&
      snapshot.status === "active" &&
      snapshot.lifecycle === "active" &&
      snapshot.generation === frame.expectedGeneration;
    if (admissible)
      runtime.reconcileRoom({
        draftId: frame.draftId,
        room: frame.roomDocument,
        replica,
        trigger: "frame",
      });
    const admission = await admitWriterUpdate({
      targetDocument: replica.doc,
      update: frame.updateData,
      validateTarget() {
        if (!admissible) throw new DraftStaleUpdateError(`Draft ${frame.draftId}`);
      },
      isContained: () => runtime.containment.contains(replica.doc, frame.updateData),
      append: async () =>
        runtime.prepareAppend(base, [
          {
            draftId: frame.draftId,
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
   * draft in this process; anything else is the fold fence's: compaction is content-free, so
   * a frame or inverse that lands meanwhile is folded in, and a rewrite that commits first
   * makes it miss (the next frame past the bound tries again). Called after a writer frame
   * commits, outside every transaction; a failure is reported and leaves the tail for the
   * next frame.
   */
  function compactIfLong(draftId: string): void {
    const long = ({ tail }: CommittedReplica) =>
      tail.rows >= COMPACT_TAIL_ROWS || tail.bytes >= COMPACT_TAIL_BYTES;
    const replica = runtime.committed(draftId);
    if (!replica || compacting.has(draftId) || !long(replica)) return;
    compacting.add(draftId);
    void (async () => {
      const { replica: current } = await runtime.loadBase(draftId);
      if (!long(current)) return;
      const write = runtime.prepareRewrite(draftId, runtime.cloneReplica(current), {
        policy: runtime.foldPolicy(current),
        operation: { kind: "compact" },
      });
      // A moved or closed draft: the next frame past the bound tries again.
      await runtime.commitOnce(write, { moved: () => {} });
    })()
      .catch((cause: unknown) => input.diagnostics?.compactionFailed({ draftId, cause }))
      .finally(() => compacting.delete(draftId));
  }

  return { commitWriterUpdate };
}

/**
 * Writer-frame admission over the branch runtime: a frame judged on a private candidate of the
 * committed replica and appended at the revision it was judged at, with no process-level
 * ordering (section 2.2), and the background tail fold a committed frame can trigger. The
 * runtime (`branch-coordinator.ts`) owns the replicas, candidates and publication; this module
 * owns only what a frame decides.
 */
import type * as Y from "yjs";
import type {
  BranchRuntime,
  PublishedReplica,
  RoomReconcileTrigger,
} from "./branch-coordinator.js";
import { captureAppendReceipts } from "./branch-receipts.js";
import {
  type AppendBranchJournalInput,
  BranchStaleUpdateError,
  type BranchStore,
} from "./branch-store.js";
import { collabHook } from "./collab-test-hooks.js";
import { admitWriterUpdate } from "./document-mutation-policy.js";
import { certifyWriterRestorations } from "./writer-restoration.js";

/** A frame's commit attempts: three judged off every lock, the fourth under its Work and row. */
const FRAME_ATTEMPTS = 4;

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
  /** A frame's append missed its revision; `attempt` is the one it judges next. */
  frameRetried(input: { branchId: string; attempt: number }): void;
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
};

export function createWriterFrames(
  runtime: BranchRuntime,
  input: {
    store: Pick<BranchStore, "withJudgementLocks">;
    diagnostics?: WriterFrameDiagnostics;
  },
) {
  const compacting = new Set<string>();

  /**
   * A writer frame: judged on a private candidate of the committed replica, appended under the
   * revision it was judged at, published only once committed. A miss destroys the candidate
   * and judges again on the new revision; the fourth attempt judges under the Work row and
   * the branch row.
   *
   * Only the first attempt checks the room holds the committed replica, and a room that does
   * not missed a delivery: it is reconciled to the replica and the frame goes on (decision
   * D26). A retry exists because a concurrent commit moved the branch, and that commit reaches
   * this room through its own publish, which runs after its COMMIT returns and so may land
   * after this frame judges again: the room lags it without having missed anything. Only a
   * generation the branch has left refuses the frame.
   */
  async function commitWriterUpdate(frame: WriterFrameInput): Promise<{ admitted: boolean }> {
    const { branchId } = frame;
    const outcome = await runtime.commitAttempts(
      async (attempt) => {
        const judge = async () => {
          const write = await judgeWriterUpdate(frame, { checkRoom: attempt.number === 1 });
          return write && attempt.own(write);
        };
        let write: Awaited<ReturnType<typeof judge>>;
        if (attempt.last) {
          write = await attempt.commit(() =>
            input.store.withJudgementLocks(branchId, async () => {
              const judged = await judge();
              await judged?.persist();
              return judged;
            }),
          );
        } else {
          write = await judge();
          const judged = write;
          if (judged) await attempt.commit(() => judged.persist());
        }
        if (!write) return { admitted: false };
        await collabHook("branch.append.afterCommit");
        return { admitted: true };
      },
      {
        bound: FRAME_ATTEMPTS,
        retrying: (attempt) => input.diagnostics?.frameRetried({ branchId, attempt }),
        // Under its own row lock the append cannot miss; a miss there is a moved branch.
        moved: () => {
          throw new BranchStaleUpdateError(branchId);
        },
      },
    );
    if (outcome.admitted) compactIfLong(branchId);
    return outcome;
  }

  /** The frame judged on the committed replica: its prepared append, or null when contained. */
  async function judgeWriterUpdate(frame: WriterFrameInput, { checkRoom }: { checkRoom: boolean }) {
    const base = await runtime.loadBase(frame.branchId);
    const { snapshot, replica } = base;
    const admissible =
      snapshot.kind === "work_draft" &&
      snapshot.status === "active" &&
      snapshot.lifecycle === "active" &&
      snapshot.generation === frame.expectedGeneration;
    if (admissible && checkRoom)
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
      append: async () => {
        const journals: AppendBranchJournalInput[] = [
          {
            branchId: frame.branchId,
            generation: snapshot.generation,
            updateData: frame.updateData,
            source: "writer",
            actorUserId: frame.actorUserId,
            updateMeta: {
              restorationAliases: certifyWriterRestorations(replica.doc, frame.updateData),
            },
          },
        ];
        const candidate = runtime.cloneReplica(replica);
        try {
          const receipts = captureAppendReceipts(candidate, journals);
          return await runtime.prepareAppend(base, candidate, journals, receipts);
        } catch (cause) {
          candidate.destroy();
          throw cause;
        }
      },
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

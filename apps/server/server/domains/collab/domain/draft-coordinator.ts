/** Draft operation policy over the shared committed-replica runtime. */

import {
  bindBlockOrigins,
  bytesEqual,
  type SavePrecondition,
} from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import { admitSegmentRows } from "./document-mutation-policy.js";
import {
  createDraftRuntime,
  type DraftBase,
  type DraftRuntime,
  type DraftRuntimeInput,
  type PreparedDraftAppend,
  type RoomReconcileTrigger,
} from "./draft-runtime.js";
import {
  type AppendDraftJournalInput,
  blockOriginsFromDraftSeed,
  DraftMissingError,
  type DraftSnapshot,
  DraftStaleUpdateError,
} from "./draft-store.js";
import { createWriterFrames, type WriterFrameInput } from "./draft-writer-frames.js";

export type DraftCoordinator = Pick<DraftRuntime, "loadBase" | "prepareAppend"> & {
  readDraft<T>(
    draftId: string,
    fn: (doc: Y.Doc, snapshot: DraftSnapshot) => Promise<T>,
  ): Promise<T>;
  /**
   * A private copy of the committed draft, the caller's to change and destroy, with the draft's
   * block addresses bound.
   */
  copyDraft(draftId: string): Promise<{ doc: Y.Doc; snapshot: DraftSnapshot; position: number }>;
  /**
   * Replays a response's rows on a candidate of the committed draft. With `commit`, the rows
   * come back as a prepared write (null when there are none) for the caller's commit scope.
   */
  prepareStagedRows<T>(
    draftId: string,
    run: (
      doc: Y.Doc,
      snapshot: DraftSnapshot,
    ) => Promise<{ result: T; rows: readonly AppendDraftJournalInput[] }>,
    commit: boolean,
    precondition?: SavePrecondition,
  ): Promise<{ result: T; write: PreparedDraftAppend | null }>;
  /** A writer frame (`draft-writer-frames.ts`). */
  commitWriterUpdate(input: WriterFrameInput): Promise<{ admitted: boolean }>;
  /** Brings this process's rooms up to what is committed now: a read, installed as any other. */
  deliverCommitted(draftId: string): Promise<void>;
  /**
   * Brings a registered room up to what is committed on its stable identity (decisions D26, D27):
   * at its enrollment, from which on every installed transition reaches it, and at each tab's
   * handshake, so a room that missed a delivery heals on the next exchange whether or not the
   * tab may write. Returns the base it reconciled against, or null when the draft closed or
   * was removed.
   */
  reconcileRegisteredRoom(input: {
    draftId: string;
    room: Y.Doc;
    trigger: Exclude<RoomReconcileTrigger, "frame">;
  }): Promise<DraftBase | null>;
};

export function createDraftCoordinator(input: DraftRuntimeInput): DraftCoordinator {
  const runtime = createDraftRuntime(input);
  const { loadBase, cloneReplica, prepareAppend, reconcileRoom } = runtime;

  async function reconcileRegisteredRoom(
    room: Parameters<DraftCoordinator["reconcileRegisteredRoom"]>[0],
  ): Promise<DraftBase | null> {
    const base = await loadBase(room.draftId).catch((cause: unknown) => {
      if (cause instanceof DraftMissingError) return null;
      throw cause;
    });
    if (base?.snapshot.status !== "active") return null;
    reconcileRoom({ ...room, replica: base.replica });
    return base;
  }

  /** `fn` over the committed replica, which it must only read. */
  async function readCommitted<T>(
    draftId: string,
    fn: (doc: Y.Doc, snapshot: DraftSnapshot) => Promise<T>,
  ): Promise<T> {
    const base = await loadBase(draftId);
    return fn(base.replica.doc, base.snapshot);
  }

  /** A private copy: whatever its owner changes stays with it (decision F6). */
  async function copyDraft(
    draftId: string,
  ): Promise<{ doc: Y.Doc; snapshot: DraftSnapshot; position: number }> {
    const base = await loadBase(draftId);
    const doc = cloneReplica(base.replica);
    try {
      const origins = blockOriginsFromDraftSeed(base.snapshot.seed);
      if (origins) bindBlockOrigins(doc, origins);
    } catch (cause) {
      doc.destroy();
      throw cause;
    }
    return { doc, snapshot: base.snapshot, position: base.replica.seq };
  }

  /**
   * `journals` admitted on a fresh copy of the base (the pre-lock policy check, kept as the
   * write's candidate) and prepared as an append: the one way a save's replay prepares rows.
   */
  function prepareRows(
    base: DraftBase,
    journals: readonly AppendDraftJournalInput[],
    precondition?: SavePrecondition,
  ): PreparedDraftAppend {
    const admitted = cloneReplica(base.replica);
    try {
      admitSegmentRows(admitted, base.snapshot.documentId, journals);
    } catch (cause) {
      admitted.destroy();
      throw cause;
    }
    return prepareAppend(base, journals, { admitted, precondition });
  }

  async function prepareStagedRows<T>(
    draftId: string,
    run: (
      doc: Y.Doc,
      snapshot: DraftSnapshot,
    ) => Promise<{ result: T; rows: readonly AppendDraftJournalInput[] }>,
    commit: boolean,
    precondition?: SavePrecondition,
  ): Promise<{ result: T; write: PreparedDraftAppend | null }> {
    const base = await loadBase(draftId);
    const { snapshot } = base;
    assertWritableDraft(snapshot);
    const replay = cloneReplica(base.replica);
    try {
      const { result, rows } = await run(replay, snapshot);
      if (!commit || !rows.length) return { result, write: null };
      const write = prepareRows(base, rows, precondition);
      if (!bytesEqual(Y.encodeStateAsUpdate(write.candidate), Y.encodeStateAsUpdate(replay))) {
        write.dispose();
        throw new Error("Response replay differs from its admitted segment rows");
      }
      return { result, write };
    } finally {
      replay.destroy();
    }
  }

  const frames = createWriterFrames(runtime);

  return {
    loadBase,
    prepareAppend,
    readDraft: readCommitted,
    copyDraft,
    prepareStagedRows,
    async deliverCommitted(draftId) {
      await loadBase(draftId);
    },

    reconcileRegisteredRoom,

    commitWriterUpdate: frames.commitWriterUpdate,
  };
}

function assertWritableDraft(snapshot: DraftSnapshot): void {
  if (snapshot.status !== "active") {
    throw new DraftStaleUpdateError(`Draft ${snapshot.draftId}`);
  }
}

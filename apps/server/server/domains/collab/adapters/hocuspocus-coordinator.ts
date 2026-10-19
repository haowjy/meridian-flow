/** DocumentCoordinator adapters over live Hocuspocus Y.Docs: lock-free room reads, locked commits. */

import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import {
  type DocumentAccess,
  type DocumentCoordinator,
  DocumentNotFoundError,
  type JournalSnapshot,
  type RoomRead,
  type StagedRoomEntries,
  type UpdateJournal,
} from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import {
  bindDocumentAuthority,
  boundDocumentAuthority,
  documentAuthority,
  isDocumentHandleRetired,
  RetiredDocumentHandleError,
  retireDocumentHandle,
} from "../domain/document-handle.js";
import { liveRoom } from "../domain/observation-rooms.js";
import type { CheckpointAuthority } from "../domain/ports/checkpoint-authority.js";
import { loadDocumentState } from "./document-loader.js";

type CoordinatorDeps = {
  hocuspocus: () => Hocuspocus;
  journal: UpdateJournal;
  mutex?: KeyedMutex;
};

type LiveDocHandle = {
  doc: Y.Doc;
  release(): Promise<void>;
};

export type OpenLiveDocument = (docId: string) => Promise<LiveDocHandle>;

const RECOVERY_ORIGIN = {
  source: "local",
  context: { origin: { type: "system", reason: "journal-recovery" } },
} satisfies TransactionOrigin;

export function createHocuspocusCoordinator(deps: CoordinatorDeps): DocumentCoordinator {
  return createCoordinator(deps, defaultOpenLiveDocument(deps.hocuspocus));
}

/**
 * The live agent-edit core's coordinator (D42). Outside a database
 * transaction it is the live coordinator. Inside one, agent-edit works on a
 * private copy of the live document as others see it (the open room plus
 * committed journal rows), and open editors receive the result only after
 * commit, through `recover`. A rollback therefore leaves nothing on screen.
 * The copy needs no document mutex: the room is only read, synchronously.
 */
export function createDeferredLiveProjectionCoordinator(deps: {
  hocuspocus: () => Hocuspocus;
  journal: UpdateJournal;
  live: DocumentCoordinator;
  transactions: {
    inTransaction(): boolean;
    outsideTransaction<T>(operation: () => T): T;
    afterCommit(callback: () => void | Promise<void>): boolean;
  };
}): DocumentCoordinator {
  // The transaction's own rows stay out of the copy, as they stay out of the room until
  // commit; only a document created in this transaction has nothing committed to start from.
  const committedCopy = async (docId: string) => {
    if (!deps.transactions.inTransaction()) return liveRoomCopy(deps, docId);
    const copy = await deps.transactions
      .outsideTransaction(() => liveRoomCopy(deps, docId))
      .catch((cause: unknown) => {
        if (cause instanceof DocumentNotFoundError) return null;
        throw cause;
      });
    return copy ?? liveRoomCopy(deps, docId);
  };
  return {
    readRoom: async (docId, staged) => withStaged(await committedCopy(docId), staged),
    roomFor: liveRoomFor,
    async withDocument<T>(
      docId: string,
      fn: (doc: Y.Doc) => Promise<T>,
      options?: DocumentAccess,
    ): Promise<T> {
      if (!deps.transactions.inTransaction()) return deps.live.withDocument(docId, fn, options);
      const { doc: copy } = await committedCopy(docId);
      // Any change, a pure deletion included: a delete set moves no state vector.
      let changed = false;
      copy.on("update", () => {
        changed = true;
      });
      try {
        const result = await fn(copy);
        if (changed) deps.transactions.afterCommit(() => deps.live.recover(docId));
        return result;
      } finally {
        copy.destroy();
      }
    },
    recover: (docId) => deps.live.recover(docId),
  };
}

/**
 * A private gc-off copy of a live document as others see it, read without the document mutex:
 * the in-process room when it belongs to the journal's authority, plus the committed journal,
 * which also catches up a room behind it after a failed projection. Named by that authority.
 */
async function liveRoomCopy(
  deps: { hocuspocus: () => Hocuspocus; journal: UpdateJournal },
  docId: string,
): Promise<{ doc: Y.Doc; room: string | null }> {
  const snapshot = await deps.journal.read(docId);
  const authority = snapshot.authority as CheckpointAuthority | undefined;
  const loaded = deps.hocuspocus().documents.get(docId);
  const bound = loaded && !isDocumentHandleRetired(loaded) ? boundDocumentAuthority(loaded) : null;
  // A room bound to another generation is a retired version's: the journal names the current one.
  const room =
    loaded &&
    !isDocumentHandleRetired(loaded) &&
    (!authority ||
      !bound ||
      (bound.authorityId === authority.authorityId && bound.generation === authority.generation))
      ? loaded
      : undefined;
  if (!room && !snapshot.checkpoint && snapshot.updates.length === 0)
    throw new DocumentNotFoundError(docId);
  const copy = new Y.Doc({ gc: false });
  if (room) Y.applyUpdate(copy, Y.encodeStateAsUpdate(room), RECOVERY_ORIGIN);
  if (snapshot.checkpoint) Y.applyUpdate(copy, snapshot.checkpoint, RECOVERY_ORIGIN);
  for (const entry of [...snapshot.updates].sort((a, b) => a.seq - b.seq))
    Y.applyUpdate(copy, entry.update, RECOVERY_ORIGIN);
  if (authority) bindDocumentAuthority(copy, authority);
  return { doc: copy, room: authority ? liveRoom(docId, authority.generation) : null };
}

/** A live room has no retirement or inverse to reconcile against: every staged entry is kept. */
export function withStaged(
  copy: { doc: Y.Doc; room: string | null },
  staged: StagedRoomEntries | null,
): RoomRead {
  for (const entry of staged?.entries ?? []) Y.applyUpdate(copy.doc, entry.update);
  return {
    ...copy,
    generation: 0,
    kept: (staged?.entries ?? []).flatMap((entry) =>
      entry.mutation?.writeId ? [entry.mutation.writeId] : [],
    ),
    rejected: [],
  };
}

/** A live handle's room, by the authority its open or journal read bound to it. */
export function liveRoomFor(docId: string, doc: Y.Doc): string | null {
  const authority = boundDocumentAuthority(doc);
  return authority ? liveRoom(docId, authority.generation) : null;
}

export function createHocuspocusCoordinatorForTest(
  deps: CoordinatorDeps & { openLiveDoc: OpenLiveDocument },
): DocumentCoordinator {
  return createCoordinator(deps, deps.openLiveDoc);
}

function createCoordinator(
  deps: CoordinatorDeps,
  openLiveDoc: OpenLiveDocument,
): DocumentCoordinator {
  const mutex = deps.mutex ?? new KeyedMutex();

  async function persistedState(
    docId: string,
    handle?: Y.Doc,
    snapshot?: JournalSnapshot,
  ): Promise<Uint8Array | null> {
    try {
      return await loadDocumentState(deps.journal, docId, handle, snapshot);
    } catch (cause) {
      if (cause instanceof RetiredDocumentHandleError && handle) {
        // A cold open may have loaded a newer generation after our snapshot.
        // Refuse this acquisition, but never evict that newer room.
        if (!isDocumentHandleRetired(handle) && snapshot?.authority) {
          const bound = documentAuthority(handle);
          if (
            bound.authorityId === snapshot.authority.authorityId &&
            bound.generation > snapshot.authority.generation
          )
            throw cause;
        }
        retireDocumentHandle(handle);
        const hp = deps.hocuspocus();
        if (hp.documents.get(docId) === handle) {
          hp.closeConnections(docId);
          hp.documents.delete(docId);
        }
      }
      throw cause;
    }
  }

  function liveDoc(docId: string): Y.Doc | undefined {
    return deps.hocuspocus().documents.get(docId);
  }

  async function applyMissing(doc: Y.Doc, persisted: Uint8Array): Promise<void> {
    const missing = Y.diffUpdate(persisted, Y.encodeStateVector(doc));
    Y.applyUpdate(doc, missing, RECOVERY_ORIGIN);
  }

  return {
    documentAuthority,
    readRoom: async (docId, staged) => withStaged(await liveRoomCopy(deps, docId), staged),
    roomFor: liveRoomFor,
    withDocument<T>(
      docId: string,
      fn: (doc: Y.Doc) => Promise<T>,
      options?: DocumentAccess,
    ): Promise<T> {
      return mutex.run(
        docId,
        async () => {
          const snapshot = await deps.journal.read(docId);
          if (!liveDoc(docId) && !snapshot.checkpoint && snapshot.updates.length === 0) {
            throw new DocumentNotFoundError(docId);
          }
          const handle = await openLiveDoc(docId);
          try {
            const persisted = await persistedState(docId, handle.doc, snapshot);
            if (persisted) await applyMissing(handle.doc, persisted);
            return await fn(handle.doc);
          } finally {
            await handle.release();
          }
        },
        options,
      );
    },

    recover(docId: string): Promise<void> {
      return mutex.run(docId, async () => {
        const snapshot = await deps.journal.read(docId);
        const live = liveDoc(docId);
        if (live) {
          const persisted = await persistedState(docId, live, snapshot);
          if (!persisted) return;
          await applyMissing(live, persisted);
          return;
        }

        if (!snapshot.checkpoint && snapshot.updates.length === 0) return;

        // Cold open runs Hocuspocus onLoadDocument; after WS rewiring that hook must
        // call loadDocumentState. Reapplying the diff is harmless if it already did.
        const handle = await openLiveDoc(docId);
        try {
          const bound = await persistedState(docId, handle.doc, snapshot);
          if (bound) await applyMissing(handle.doc, bound);
        } finally {
          await handle.release();
        }
      });
    },
  };
}

function defaultOpenLiveDocument(hocuspocus: () => Hocuspocus): OpenLiveDocument {
  return async (docId) => {
    const connection = await hocuspocus().openDirectConnection(docId, {
      origin: { type: "system", reason: "agent-edit" },
    });
    if (!connection.document) throw new Error("Direct Hocuspocus connection closed before use");
    return {
      doc: connection.document,
      release: () => connection.disconnect(),
    };
  };
}

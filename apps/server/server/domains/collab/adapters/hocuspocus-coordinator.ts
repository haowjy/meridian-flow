/** DocumentCoordinator adapter that gates agent writes through live Hocuspocus Y.Docs. */

import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import {
  type DocumentCoordinator,
  type DocumentLockOptions,
  DocumentNotFoundError,
  type JournalSnapshot,
  type UpdateJournal,
} from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import {
  deferUntilDrizzleCommit,
  isInDrizzleTransaction,
  runOutsideDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import {
  documentAuthority,
  isDocumentHandleRetired,
  RetiredDocumentHandleError,
  retireDocumentHandle,
} from "../domain/document-handle.js";
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
  return createTransactionAwareCoordinator({
    journal: deps.journal,
    live: createCoordinator(deps, defaultOpenLiveDocument(deps.hocuspocus)),
    transactions: {
      inTransaction: isInDrizzleTransaction,
      outsideTransaction: runOutsideDrizzleTransaction,
      afterCommit: deferUntilDrizzleCommit,
    },
  });
}

/**
 * The single live coordinator boundary (D42). Outside a database
 * transaction it uses the live room. Inside one, every caller works on a
 * private copy of the committed durable cut, and open editors receive the result only after
 * commit, through `recover`. A rollback therefore leaves nothing on screen.
 * The copy never opens, reads or hydrates a room.
 */
function createTransactionAwareCoordinator(deps: {
  journal: UpdateJournal;
  live: DocumentCoordinator;
  transactions: {
    inTransaction(): boolean;
    outsideTransaction<T>(operation: () => T): T;
    afterCommit(callback: () => void | Promise<void>): boolean;
  };
}): DocumentCoordinator {
  return {
    documentAuthority,
    async withDocument<T>(
      docId: string,
      fn: (doc: Y.Doc) => Promise<T>,
      options?: DocumentLockOptions,
    ): Promise<T> {
      if (!deps.transactions.inTransaction()) return deps.live.withDocument(docId, fn, options);
      // A newly created document has only transaction-local seed state. Existing
      // documents expose committed state, even to the transaction that staged a landing.
      const committed = await deps.transactions.outsideTransaction(() => deps.journal.read(docId));
      const snapshot =
        committed.checkpoint || committed.updates.length
          ? committed
          : await deps.journal.read(docId);
      const copy = new Y.Doc({ gc: false });
      try {
        const seed = await loadDocumentState(deps.journal, docId, copy, snapshot);
        if (!seed) throw new DocumentNotFoundError(docId);
        Y.applyUpdate(copy, seed, RECOVERY_ORIGIN);
        const seeded = Y.encodeStateAsUpdate(copy);
        const result = await fn(copy);
        if (!sameBytes(seeded, Y.encodeStateAsUpdate(copy))) {
          deps.transactions.afterCommit(() => deps.live.recover(docId));
        }
        return result;
      } finally {
        copy.destroy();
      }
    },
    async recover(docId) {
      if (!deps.transactions.afterCommit(() => deps.live.recover(docId))) {
        await deps.live.recover(docId);
      }
    },
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
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
    withDocument<T>(
      docId: string,
      fn: (doc: Y.Doc) => Promise<T>,
      options?: DocumentLockOptions,
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

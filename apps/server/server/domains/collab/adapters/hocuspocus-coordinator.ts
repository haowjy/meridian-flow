/** DocumentCoordinator adapter that gates agent writes through live Hocuspocus Y.Docs. */

import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import {
  type DocumentCoordinator,
  DocumentNotFoundError,
  type UpdateJournal,
} from "@meridian/agent-edit";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
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

  async function persistedState(docId: string): Promise<Uint8Array | null> {
    return loadDocumentState(deps.journal, docId);
  }

  function liveDoc(docId: string): Y.Doc | undefined {
    return deps.hocuspocus().documents.get(docId);
  }

  async function applyMissing(doc: Y.Doc, persisted: Uint8Array): Promise<void> {
    const missing = Y.diffUpdate(persisted, Y.encodeStateVector(doc));
    Y.applyUpdate(doc, missing, RECOVERY_ORIGIN);
  }

  return {
    withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
      return mutex.run(docId, async () => {
        if (!liveDoc(docId) && !(await persistedState(docId))) {
          throw new DocumentNotFoundError(docId);
        }

        const handle = await openLiveDoc(docId);
        try {
          return await fn(handle.doc);
        } finally {
          await handle.release();
        }
      });
    },

    recover(docId: string): Promise<void> {
      return mutex.run(docId, async () => {
        const persisted = await persistedState(docId);
        if (!persisted) return;

        const live = liveDoc(docId);
        if (live) {
          await applyMissing(live, persisted);
          return;
        }

        // Cold open runs Hocuspocus onLoadDocument; after WS rewiring that hook must
        // call loadDocumentState. Reapplying the diff is harmless if it already did.
        const handle = await openLiveDoc(docId);
        try {
          await applyMissing(handle.doc, persisted);
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

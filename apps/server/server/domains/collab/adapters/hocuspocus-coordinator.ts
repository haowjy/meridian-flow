/**
 * Live Hocuspocus documents: agent-edit's coordinator (lock-free room reads, saves that append
 * to the journal and reach the room only after commit), collab's locked room door, and the
 * owned delivery of committed rows to the open room.
 */

import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import {
  type DocumentCoordinator,
  DocumentNotFoundError,
  type JournalSnapshot,
  type RoomRead,
  type SaveCut,
  type StagedRoomEntries,
  type StagedWriteSaveResult,
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
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { loadDocumentState } from "./document-loader.js";

type CoordinatorDeps = {
  hocuspocus: () => Hocuspocus;
  journal: UpdateJournal;
  mutex?: KeyedMutex;
  /** The ambient database transaction; without it every acquisition gets the open room. */
  transactions?: {
    inTransaction(): boolean;
    afterCommit(callback: () => void | Promise<void>): boolean;
  };
  diagnostics?: RoomDeliveryDiagnostics;
  /** The waits before each retry of a failed delivery; the last repeats until the outage ends. */
  deliveryBackoffMs?: readonly number[];
};

/**
 * A delivery outage, reported once at each end: the first failed attempt, and the pass that
 * caught the room up or found Hocuspocus had unloaded it.
 */
export type RoomDeliveryDiagnostics = {
  failed(event: { documentId: string; cause: unknown }): void;
  recovered(event: {
    documentId: string;
    attempts: number;
    outcome: "delivered" | "unloaded";
  }): void;
};

const DELIVERY_BACKOFF_MS = [250, 1_000, 4_000, 30_000] as const;

type LiveDocHandle = {
  doc: Y.Doc;
  release(): Promise<void>;
};

export type OpenLiveDocument = (docId: string) => Promise<LiveDocHandle>;

const RECOVERY_ORIGIN = {
  source: "local",
  context: { origin: { type: "system", reason: "journal-recovery" } },
} satisfies TransactionOrigin;

export function createHocuspocusCoordinator(deps: CoordinatorDeps): LiveDocumentCoordinator {
  return createCoordinator(deps, defaultOpenLiveDocument(deps.hocuspocus));
}

/**
 * The live agent-edit core's coordinator (D42). A call reads a private copy of the live
 * document as others see it (the open room plus committed journal rows). A save appends its
 * kept entries to the journal in the caller's commit scope, and open editors receive them only
 * after the root transaction commits, through `deliver`: a rollback leaves nothing on screen,
 * and nothing applies to the room inside a transaction (LOCK-WS). The copy needs no document
 * mutex: the room is only read, synchronously.
 */
export function createDeferredLiveProjectionCoordinator(deps: {
  hocuspocus: () => Hocuspocus;
  journal: Pick<UpdateJournal, "read" | "appendBatch">;
  live: Pick<LiveDocumentCoordinator, "deliver">;
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
  const deliver = (docId: string) => () => deps.live.deliver(docId);
  return {
    readRoom: async (docId, staged) => withStaged(await committedCopy(docId), staged),
    prepareSave: async (input) =>
      liveSave(
        await committedCopy(input.docId).catch(emptyWhenMissing),
        input,
        deps.journal,
        () => {
          const delivery = deliver(input.docId);
          if (!deps.transactions.afterCommit(delivery)) void delivery();
        },
      ),
  };
}

/** A document a save creates has no room yet: its rows append onto an empty one. */
export function emptyWhenMissing(cause: unknown): { doc: Y.Doc; room: null } {
  if (!(cause instanceof DocumentNotFoundError)) throw cause;
  return { doc: new Y.Doc({ gc: false }), room: null };
}

/**
 * A live save of one scope's entries onto `copy` (the room's committed state, consumed): every
 * entry is kept, since a live room has no retirement or inverse to reconcile against. `persist`
 * appends them as one journal batch bound to the copy's authority, joining the caller's
 * transaction when there is one, and resolves the cut that append returned; `transfer` hands
 * them to `deliver`.
 */
export function liveSave(
  copy: { doc: Y.Doc; room: string | null },
  input: StagedRoomEntries & { docId: string },
  journal: Pick<UpdateJournal, "appendBatch">,
  deliver: () => void,
): StagedWriteSaveResult {
  try {
    const prepared = Y.encodeStateAsUpdate(copy.doc);
    for (const entry of input.entries) Y.applyUpdate(copy.doc, entry.update);
    const authority = boundDocumentAuthority(copy.doc) ?? undefined;
    const result = {
      kept: input.entries.flatMap((entry) =>
        entry.mutation?.writeId ? [entry.mutation.writeId] : [],
      ),
      rejected: [],
      room: copy.room,
      beforeState: prepared,
      afterState: Y.encodeStateAsUpdate(copy.doc),
    };
    if (!input.entries.length) return { ...result, write: { kind: "no-effect" } };
    return {
      ...result,
      write: {
        kind: "write",
        async persist() {
          const appended = await journal.appendBatch(
            input.entries.map((entry) => ({ ...entry, authority })),
          );
          return appendCut(input, prepared, appended[0]?.beforeState ?? prepared);
        },
        transfer: deliver,
        dispose() {},
      },
    };
  } finally {
    copy.doc.destroy();
  }
}

/**
 * The cut the append of `input`'s rows followed: `found`, the journal it read under the
 * document's lock before them (a writer's frame admitted between preparing and appending is in
 * it, and the report names what the rows swept of it), with the prepared copy merged in for the
 * room it read. In-memory Yjs over bytes already in hand: nothing here waits on storage.
 */
function appendCut(input: StagedRoomEntries, prepared: Uint8Array, found: Uint8Array): SaveCut {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, found);
    Y.applyUpdate(doc, prepared);
    const beforeState = Y.encodeStateAsUpdate(doc);
    for (const entry of input.entries) Y.applyUpdate(doc, entry.update);
    return { beforeState, afterState: Y.encodeStateAsUpdate(doc) };
  } finally {
    doc.destroy();
  }
}

/**
 * A private gc-off copy of a live document as others see it, read without the document mutex:
 * the in-process room when it belongs to the journal's authority, plus the committed journal,
 * which also catches up a room behind it after a failed projection. Named by that authority.
 */
async function liveRoomCopy(
  deps: { hocuspocus: () => Hocuspocus; journal: Pick<UpdateJournal, "read"> },
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
): LiveDocumentCoordinator {
  return createCoordinator(deps, deps.openLiveDoc);
}

function createCoordinator(
  deps: CoordinatorDeps,
  openLiveDoc: OpenLiveDocument,
): LiveDocumentCoordinator {
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

  /**
   * A transaction's acquisition: a private copy of the room with the committed journal and the
   * transaction's own rows, which never reaches the room. Its rows do once the root commits.
   */
  async function inTransaction<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    const copy = await liveRoomCopy(deps, docId);
    try {
      return await fn(copy.doc);
    } finally {
      copy.doc.destroy();
      deps.transactions?.afterCommit(() => delivery.deliver(docId));
    }
  }

  async function applyMissing(doc: Y.Doc, persisted: Uint8Array): Promise<void> {
    const missing = Y.diffUpdate(persisted, Y.encodeStateVector(doc));
    Y.applyUpdate(doc, missing, RECOVERY_ORIGIN);
  }

  const delivery = createRoomDelivery({
    catchUp,
    // Without a bound Hocuspocus (a server not serving rooms) no room is loaded to fall behind.
    loaded: (docId) => {
      try {
        return liveDoc(docId);
      } catch {
        return undefined;
      }
    },
    backoffMs: deps.deliveryBackoffMs ?? DELIVERY_BACKOFF_MS,
    diagnostics: deps.diagnostics,
  });

  function recover(docId: string): Promise<void> {
    return catchUp(docId).then(() => undefined);
  }

  /**
   * Applies the committed journal rows the open room lacks. Given `into`, only into that room:
   * false, reading nothing, once Hocuspocus no longer holds it (unloaded, or replaced by a room
   * that cold-loaded the journal itself).
   */
  function catchUp(docId: string, into?: Y.Doc): Promise<boolean> {
    return mutex.run(docId, async () => {
      if (into && liveDoc(docId) !== into) return false;
      const snapshot = await deps.journal.read(docId);
      const live = liveDoc(docId);
      if (into && live !== into) return false;
      if (live) {
        const persisted = await persistedState(docId, live, snapshot);
        if (persisted) await applyMissing(live, persisted);
        return true;
      }

      if (!snapshot.checkpoint && snapshot.updates.length === 0) return true;

      // Cold open runs Hocuspocus onLoadDocument; after WS rewiring that hook must
      // call loadDocumentState. Reapplying the diff is harmless if it already did.
      const handle = await openLiveDoc(docId);
      try {
        const bound = await persistedState(docId, handle.doc, snapshot);
        if (bound) await applyMissing(handle.doc, bound);
      } finally {
        await handle.release();
      }
      return true;
    });
  }

  return {
    recover,
    deliver: delivery.deliver,
    withDocument<T>(
      docId: string,
      fn: (doc: Y.Doc) => Promise<T>,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<T> {
      return mutex.run(
        docId,
        async () => {
          if (deps.transactions?.inTransaction()) return inTransaction(docId, fn);
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
  };
}

/**
 * Delivery of committed rows to a document's open room, an obligation owned until it is met:
 * one chain per document folds every request made while it runs into its next pass. A failed
 * pass starts an outage against the room that is behind; it is retried after each wait in
 * `backoffMs` (the last repeating) for as long as Hocuspocus holds that same room, and ends with
 * a pass that catches it up or with the room unloaded or replaced (a load reads the journal).
 * A request made during a wait ends the wait: its pass runs at once into whatever room is open,
 * so a save after the outage never waits out the backoff.
 * Room lifetime stays Hocuspocus's: delivery never closes or drops a room. A writer's frames are
 * journal-first, so while the journal can't be read they fail too.
 */
function createRoomDelivery(deps: {
  catchUp(docId: string, into?: Y.Doc): Promise<boolean>;
  loaded(docId: string): Y.Doc | undefined;
  backoffMs: readonly number[];
  diagnostics: RoomDeliveryDiagnostics | undefined;
}): { deliver(docId: string): Promise<void> } {
  // `wake` cuts short a retry's wait: a new request is served at once, not after the backoff.
  type Chain = { again: boolean; waiters: (() => void)[]; wake?: () => void };
  const chains = new Map<string, Chain>();

  async function run(docId: string, chain: Chain): Promise<void> {
    // The outage in progress: its failed attempts (0: none), and the room left behind.
    let failures = 0;
    let behind: Y.Doc | undefined;
    const end = (outcome: "delivered" | "unloaded") => {
      if (failures) deps.diagnostics?.recovered({ documentId: docId, attempts: failures, outcome });
      failures = 0;
      behind = undefined;
    };
    try {
      while (chain.again || behind) {
        // A new request delivers to whatever room is open; a retry only to the one behind.
        const into = chain.again ? undefined : behind;
        chain.again = false;
        const waiters = chain.waiters.splice(0);
        try {
          end((await deps.catchUp(docId, into)) ? "delivered" : "unloaded");
        } catch (cause) {
          // A room retired for a replaced generation was closed by the attempt itself.
          if (cause instanceof RetiredDocumentHandleError) end("unloaded");
          else {
            if (!failures) deps.diagnostics?.failed({ documentId: docId, cause });
            failures += 1;
            behind = deps.loaded(docId);
            if (!behind) end("unloaded");
            else {
              const wait = deps.backoffMs[Math.min(failures, deps.backoffMs.length) - 1] ?? 0;
              for (const resolve of waiters) resolve();
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, wait);
                timer.unref?.();
                chain.wake = () => {
                  clearTimeout(timer);
                  resolve();
                };
              });
              chain.wake = undefined;
              continue;
            }
          }
        }
        for (const resolve of waiters) resolve();
      }
    } finally {
      chains.delete(docId);
      for (const resolve of chain.waiters.splice(0)) resolve();
    }
  }

  return {
    deliver(docId) {
      return new Promise<void>((resolve) => {
        const running = chains.get(docId);
        if (running) {
          running.again = true;
          running.waiters.push(resolve);
          running.wake?.();
          return;
        }
        const chain: Chain = { again: true, waiters: [resolve] };
        chains.set(docId, chain);
        void run(docId, chain);
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

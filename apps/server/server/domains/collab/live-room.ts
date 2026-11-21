/**
 * A Live document's room: loaded from its checkpoint and tail, its writer frames judged in the
 * room and stored with one insert, its checkpoints written from the journal in the background,
 * its generation fenced against a restore. Rooms catch up by reading in the live coordinator
 * (`adapters/hocuspocus-coordinator.ts`).
 */
import type { Hocuspocus } from "@hocuspocus/server";
import type { UpdateMeta } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { processDetachedWork } from "../../shared/detached-work.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import { loadDocumentState } from "./adapters/document-loader.js";
import type { CollabTransport, UpdateOrigin } from "./contracts.js";
import {
  documentAuthority,
  isDocumentHandleRetired,
  RetiredDocumentHandleError,
  retireDocumentHandle,
} from "./domain/document-handle.js";
import type {
  CheckpointAuthority,
  CheckpointJournal,
} from "./domain/ports/checkpoint-authority.js";
import type { LiveWriterJournal } from "./domain/ports/live-writer-journal.js";
import type { WriterQueue } from "./writer-queue.js";

type PendingCheckpoint = {
  document: Y.Doc;
  authority: CheckpointAuthority;
};

type CheckpointSlot = {
  next?: PendingCheckpoint;
  running: Promise<void>;
};

export type LiveRoomDeps = {
  journal: CheckpointJournal & LiveWriterJournal;
  hocuspocus(): Hocuspocus | null;
  queue: WriterQueue;
  eventSink?: EventSink;
  metaForOrigin(origin: UpdateOrigin): UpdateMeta;
  /** Runs `callback` once the caller's ambient DB transaction commits; with none, now. */
  afterCallerCommit(callback: () => void): void;
  readAuthorityHeadGeneration?(documentId: DocumentId): Promise<bigint>;
};

export type LiveRoom = Pick<
  CollabTransport,
  | "loadHocuspocusDocument"
  | "validateHocuspocusDocument"
  | "currentLiveGeneration"
  | "admitLiveWriterUpdate"
  | "storeHocuspocusDocument"
> & {
  disconnectLiveGeneration(documentId: DocumentId, generation: bigint): Promise<void>;
  drainCheckpoints(): Promise<void>;
};

export function createLiveRoom(deps: LiveRoomDeps): LiveRoom {
  const { queue } = deps;
  // A reconnected client has current transport authority but can replay cached
  // pre-restore structs/deletes. Handle fencing cannot identify that byte history.
  const retiredStateVectors = new Map<string, Uint8Array>();
  const checkpointSlots = new Map<string, CheckpointSlot>();

  function emitCheckpointFailure(documentId: string, cause: unknown): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "error",
      source: "collab.hocuspocus",
      name: "checkpoint.failed",
      correlation: { documentId },
      payload: unknownToEventPayload(cause),
    });
  }

  /**
   * Writes live checkpoints in the background, one at a time per document; a
   * request that arrives while one is writing replaces any queued one.
   */
  function startCheckpoint(documentId: string, pending: PendingCheckpoint): void {
    const slot = checkpointSlots.get(documentId);
    if (slot) {
      slot.next = pending;
      return;
    }
    const created: CheckpointSlot = { next: pending, running: Promise.resolve() };
    checkpointSlots.set(documentId, created);
    created.running = processDetachedWork.track(
      (async () => {
        while (created.next) {
          const { document, authority } = created.next;
          created.next = undefined;
          // A retired room's state belongs to an authority generation that has
          // since been replaced.
          if (isDocumentHandleRetired(document)) {
            continue;
          }
          try {
            const cut = await deps.journal.captureCheckpoint(documentId, authority);
            if (cut) {
              const state = await cut.materializeState();
              await deps.journal.storeCheckpoint(cut);
              await cut.dropUnseenContent(document);
              if (deps.eventSink)
                emitEvent(deps.eventSink, {
                  level: "debug",
                  source: "collab.hocuspocus",
                  name: "checkpoint.clients",
                  payload: {
                    documentId,
                    clientCount: Y.decodeStateVector(Y.encodeStateVectorFromUpdate(state)).size,
                    // The growth curve of a document's stored history against its text.
                    ...(await cut.history()),
                  },
                });
            }
          } catch (cause) {
            emitCheckpointFailure(documentId, cause);
          }
        }
      })().finally(() => {
        checkpointSlots.delete(documentId);
      }),
      "Hocuspocus checkpoint",
    );
  }

  function retireRoom(documentId: DocumentId, document: Y.Doc): void {
    retireDocumentHandle(document);
    const hp = deps.hocuspocus();
    if (hp?.documents.get(documentId) !== document) return;
    hp.closeConnections(documentId);
    hp.documents.delete(documentId);
  }

  async function validate(documentId: DocumentId, document: Y.Doc): Promise<void> {
    try {
      const authority = documentAuthority(document);
      const generation = await deps.readAuthorityHeadGeneration?.(documentId);
      if (
        isDocumentHandleRetired(document) ||
        (generation !== undefined && authority.generation !== generation)
      ) {
        throw new RetiredDocumentHandleError();
      }
    } catch (cause) {
      if (cause instanceof RetiredDocumentHandleError) {
        retireRoom(documentId, document);
      }
      throw cause;
    }
  }

  return {
    validateHocuspocusDocument: validate,

    async currentLiveGeneration(documentId) {
      return (await deps.readAuthorityHeadGeneration?.(documentId)) ?? 1n;
    },

    async loadHocuspocusDocument(documentId, document) {
      if (!document) return (await loadDocumentState(deps.journal, documentId)) ?? undefined;
      try {
        const state = await loadDocumentState(deps.journal, documentId, document);
        await validate(documentId, document);
        return state ?? undefined;
      } catch (cause) {
        if (cause instanceof RetiredDocumentHandleError) retireRoom(documentId, document);
        throw cause;
      }
    },

    async admitLiveWriterUpdate(input) {
      const room = input.document;
      const authority = documentAuthority(room);
      if (authority.generation !== input.expectedGeneration) {
        queue.recordDropped(input.documentId);
        throw new Error("stale-durable-authority-generation");
      }
      if (deps.hocuspocus()?.documents.get(input.documentId) !== room) {
        throw new Error("live-document-room-mismatch");
      }
      const retiredStateVector = retiredStateVectors.get(input.documentId);
      if (retiredStateVector && replaysRetiredGeneration(input.update, room, retiredStateVector)) {
        queue.recordDropped(input.documentId);
        throw new Error("retired-durable-authority-generation");
      }
      const novel = queue.judge({
        room,
        update: input.update,
        key: input.documentId,
      });
      // Reconnects replay state the room already holds: acknowledged, nothing stored.
      if (!novel) return { admitted: false };
      const append = deps.journal.appendWriterUpdate(
        input.documentId,
        novel,
        deps.metaForOrigin(input.origin),
        authority,
      );
      queue.track(input.documentId, append);
      try {
        await append;
      } catch (cause) {
        // The head moved on (a restore): this room's state belongs to the old generation.
        if (cause instanceof RetiredDocumentHandleError) retireRoom(input.documentId, room);
        throw cause;
      }
      return { admitted: true };
    },

    async storeHocuspocusDocument(documentId, document) {
      if (isDocumentHandleRetired(document)) return;
      const authority = documentAuthority(document);
      await queue.drain(documentId);
      const pending: PendingCheckpoint = { document, authority };
      // Releasing a server-side room runs this hook inline in the releaser's
      // async context, often inside its DB transaction. Capturing the cut takes the
      // document's mutation lock, so writing it here either holds that lock for
      // the rest of the caller's transaction or waits on a lock the caller holds;
      // either way a caller that then waits on another connection deadlocks.
      // A checkpoint only caches durable journal state, so it is written after
      // the caller commits, and skipped if the caller rolls back.
      deps.afterCallerCommit(() => startCheckpoint(documentId, pending));
    },

    async disconnectLiveGeneration(documentId, generation) {
      const hocuspocus = deps.hocuspocus();
      // Hocuspocus serves a room only after all load hooks complete. Its
      // registered continuation runs before this one retires and evicts it.
      void hocuspocus?.loadingDocuments?.get(documentId)?.then(
        (loaded) => {
          if (
            isDocumentHandleRetired(loaded) ||
            documentAuthority(loaded).generation <= generation
          ) {
            retireRoom(documentId, loaded);
          }
        },
        () => {},
      );
      const document = hocuspocus?.documents.get(documentId);
      if (!hocuspocus || !document) return;
      if (!isDocumentHandleRetired(document) && documentAuthority(document).generation > generation)
        return;
      retiredStateVectors.set(documentId, Y.encodeStateVector(document));
      retireRoom(documentId, document);
    },

    async drainCheckpoints() {
      while (checkpointSlots.size > 0) {
        await Promise.allSettled([...checkpointSlots.values()].map((slot) => slot.running));
      }
    },
  };
}

function replaysRetiredGeneration(
  update: Uint8Array,
  current: Y.Doc,
  retiredStateVector: Uint8Array,
): boolean {
  const currentClocks = Y.decodeStateVector(Y.encodeStateVector(current));
  const retiredClocks = Y.decodeStateVector(retiredStateVector);
  const decoded = Y.decodeUpdate(update);
  if (
    decoded.structs.some((struct) => {
      const end = struct.id.clock + struct.length;
      const currentClock = currentClocks.get(struct.id.client) ?? 0;
      const retiredClock = retiredClocks.get(struct.id.client) ?? 0;
      return end > currentClock && struct.id.clock < retiredClock;
    })
  )
    return true;
  for (const [client, ranges] of decoded.ds.clients) {
    const retainedClock = Math.min(currentClocks.get(client) ?? 0, retiredClocks.get(client) ?? 0);
    if (ranges.some(({ clock, len }) => clock < retainedClock && clock + len > 0)) return true;
  }
  return false;
}

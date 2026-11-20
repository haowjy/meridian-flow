/** The persistence queue every room's writer frames and checkpoints are counted in. */
import type { Hocuspocus } from "@hocuspocus/server";
import { RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { CollabPersistenceMetrics, UpdateOrigin } from "./contracts.js";
import {
  novelToRoom,
  ReservedWriterClientIdError,
  WriterFrameGapError,
} from "./domain/document-mutation-policy.js";

type PendingAppend = {
  documentId: string;
  startedAt: number;
  promise: Promise<void>;
};

export type WriterQueue = ReturnType<typeof createWriterQueue>;

export function createWriterQueue(deps: {
  hocuspocus(): Hocuspocus | null;
  eventSink?: EventSink;
  emitAgentEditInvariantViolation(payload: Record<string, unknown>): void;
}) {
  const pendingAppends = new Map<number, PendingAppend>();
  const droppedByDocument = new Map<string, number>();
  let nextPendingId = 1;

  function recordDropped(key: string): void {
    droppedByDocument.set(key, (droppedByDocument.get(key) ?? 0) + 1);
  }

  return {
    recordDropped,

    /** Waits out the pending stores of `key`, or of every room. */
    async drain(key?: string): Promise<void> {
      while (true) {
        const pending = [...pendingAppends.values()].filter(
          (entry) => !key || entry.documentId === key,
        );
        if (pending.length === 0) return;
        await Promise.allSettled(pending.map((entry) => entry.promise));
      }
    },

    /** Counts `promise` under `key` until it settles; a rejection is recorded and reported. */
    track(key: string, promise: Promise<unknown>): void {
      const id = nextPendingId++;
      const tracked = promise
        .then(() => undefined)
        .catch((cause) => {
          recordDropped(key);
          if (!deps.eventSink) return;
          emitEvent(deps.eventSink, {
            level: "error",
            source: "collab.hocuspocus",
            name: "persistence_append.failed",
            correlation: { documentId: key },
            payload: unknownToEventPayload(cause),
          });
        })
        .finally(() => {
          pendingAppends.delete(id);
        });
      pendingAppends.set(id, { documentId: key, startedAt: Date.now(), promise: tracked });
    },

    /**
     * What of a writer's frame the room lacks, or null when it holds all of it. A reserved
     * authorship refusal or a frame that starts past the room's clock throws: the socket closes
     * and the reconnect's handshake carries what is missing.
     */
    judge(input: {
      room: Y.Doc;
      update: Uint8Array;
      /** What the queue counts the frame's refusals under. */
      key: string;
      origin: UpdateOrigin;
      subject: { documentId: string } | { draftId: string };
    }): Uint8Array | null {
      try {
        return novelToRoom(input.room, input.update);
      } catch (cause) {
        if (cause instanceof WriterFrameGapError) {
          recordDropped(input.key);
        } else if (cause instanceof ReservedWriterClientIdError) {
          recordDropped(input.key);
          deps.emitAgentEditInvariantViolation({
            message: `Rejected connection update for ${Object.values(input.subject)[0]}: Yjs clientID ${cause.clientId} is in the reserved server-authored band [0, ${RESERVED_CLIENT_ID_MAX}].`,
            ...input.subject,
            originType: input.origin.type,
            reservedClientId: cause.clientId,
            reservedClientIdMax: RESERVED_CLIENT_ID_MAX,
          });
          throw new Error("reserved-writer-client-id");
        }
        throw cause;
      }
    },

    metrics(): CollabPersistenceMetrics {
      const byDocument = new Map<
        string,
        { depth: number; oldestStartedAt: number; dropped: number }
      >();
      for (const entry of pendingAppends.values()) {
        const current = byDocument.get(entry.documentId) ?? {
          depth: 0,
          oldestStartedAt: entry.startedAt,
          dropped: droppedByDocument.get(entry.documentId) ?? 0,
        };
        current.depth += 1;
        current.oldestStartedAt = Math.min(current.oldestStartedAt, entry.startedAt);
        byDocument.set(entry.documentId, current);
      }
      for (const [documentId, dropped] of droppedByDocument) {
        if (!byDocument.has(documentId) && dropped > 0) {
          byDocument.set(documentId, { depth: 0, oldestStartedAt: Date.now(), dropped });
        }
      }
      const hocuspocus = deps.hocuspocus();
      return {
        queues: [...byDocument.entries()].map(([documentId, queue]) => ({
          documentId,
          depth: queue.depth,
          oldestAgeMs: queue.depth === 0 ? 0 : Date.now() - queue.oldestStartedAt,
          dropped: queue.dropped,
        })),
        liveDocumentCount: hocuspocus?.getDocumentsCount() ?? hocuspocus?.documents.size ?? 0,
        openConnectionCount: hocuspocus?.getConnectionsCount() ?? 0,
      };
    },
  };
}

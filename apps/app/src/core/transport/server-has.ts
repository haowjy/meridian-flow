/**
 * server-has — what the server holds, as a state vector read off one socket's frames: the server's
 * SyncStep1, every document update the server sends, and every one this client writes to the open
 * socket (the socket is ordered: the server gets it, or the connection ends and the next handshake
 * starts over). Per client the server holds every item below the vector's clock.
 *
 * A document can hold items no frame carried. A local peer's update that waits on items the
 * server has not sent yet stays pending in the Y.Doc; the server update that supplies them
 * integrates both in the provider's transaction, and Hocuspocus never uploads a provider-origin
 * update. `lacking` is what the document holds beyond the vector, so sending it after each server
 * frame delivers those items however the frame's transactions nested.
 *
 * Pure bookkeeping over wire frames; the socket subclass in `hocuspocus-document-transport.ts`
 * feeds it.
 */
import { messageYjsSyncStep1 } from "y-protocols/sync";
import * as Y from "yjs";

import { readSyncFrame } from "./handshake-difference";

export type ServerHasTracker = {
  /** A socket opened: the server has shown nothing on it yet. */
  reset(): void;
  /** Whether `frame`, received from the server, was a Sync frame. */
  noteFrameReceived(frame: Uint8Array): boolean;
  /** A frame was written to the open socket. */
  noteFrameSent(frame: Uint8Array): void;
  readonly vector: Uint8Array;
  /** The update of what `document` holds that the server lacks; null when it lacks no item. */
  lacking(document: Y.Doc): Uint8Array | null;
};

export function createServerHasTracker(): ServerHasTracker {
  let clocks = new Map<number, number>();
  const grow = (vector: Map<number, number>) => {
    for (const [client, clock] of vector)
      if ((clocks.get(client) ?? 0) < clock) clocks.set(client, clock);
  };
  // An update's end clocks: `encodeStateVectorFromUpdate` counts only runs from clock 0.
  const holds = (payload: Uint8Array) => grow(Y.parseUpdateMeta(payload).to);
  return {
    reset() {
      clocks = new Map();
    },
    noteFrameReceived(frame) {
      const sync = readSyncFrame(frame);
      if (!sync) return false;
      if (sync.syncType === messageYjsSyncStep1) grow(Y.decodeStateVector(sync.payload));
      else holds(sync.payload);
      return true;
    },
    noteFrameSent(frame) {
      const sync = readSyncFrame(frame);
      // This client's own SyncStep1 is its state, not the server's.
      if (sync && sync.syncType !== messageYjsSyncStep1) holds(sync.payload);
    },
    get vector() {
      return Y.encodeStateVector(clocks);
    },
    lacking(document) {
      for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(document)))
        if ((clocks.get(client) ?? 0) < clock)
          return Y.encodeStateAsUpdate(document, Y.encodeStateVector(clocks));
      return null;
    },
  };
}

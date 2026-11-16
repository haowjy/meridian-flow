/**
 * server-has — what the server holds, as a state vector read off one socket's frames: the server's
 * SyncStep1, every document update the server sends, and every one this client writes to the open
 * socket (the socket is ordered: the server gets it, or the connection ends and the next handshake
 * starts over). Per client the server holds every item below the vector's clock: a payload only
 * extends a client's clock by runs that continue from it, since an update can carry structs
 * beyond a gap (pending on the server) that the server has not integrated. Before this socket's
 * SyncStep1 the vector is only the frames seen so far, so `lacking` claims nothing until it has
 * arrived. The check covers inserts only: a state vector carries no deletions, so a peer's
 * deletions released by a server frame go with the next handshake's SyncStep2.
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
  /** Whether `frame`, received from the server, was a Sync frame. Called before it is applied, so
   *  the reply to a SyncStep1 continues from the server's clocks. */
  noteFrameReceived(frame: Uint8Array): boolean;
  /** A frame was written to the open socket. */
  noteFrameSent(frame: Uint8Array): void;
  readonly vector: Uint8Array;
  /** What the server itself has shown on this socket: its SyncStep1 and its updates, never a frame this client wrote. */
  readonly shown: Uint8Array;
  /** The update of what `document` holds that the server lacks; null when it lacks no item or
   *  this socket's SyncStep1 has not arrived. */
  lacking(document: Y.Doc): Uint8Array | null;
};

export function createServerHasTracker(): ServerHasTracker {
  let clocks = new Map<number, number>();
  let shown = new Map<number, number>();
  let handshaken = false;
  const grow = (vector: Map<number, number>) => {
    for (const [client, clock] of vector)
      if ((clocks.get(client) ?? 0) < clock) clocks.set(client, clock);
  };
  // Structs come per client in clock order; a Skip marks a gap.
  const holds = (payload: Uint8Array, into = clocks) => {
    for (const struct of Y.decodeUpdate(payload).structs) {
      if (struct instanceof Y.Skip) continue;
      const { client, clock } = struct.id;
      const held = into.get(client) ?? 0;
      if (clock <= held && held < clock + struct.length) into.set(client, clock + struct.length);
    }
  };
  return {
    reset() {
      clocks = new Map();
      shown = new Map();
      handshaken = false;
    },
    noteFrameReceived(frame) {
      const sync = readSyncFrame(frame);
      if (!sync) return false;
      if (sync.syncType === messageYjsSyncStep1) {
        const vector = Y.decodeStateVector(sync.payload);
        grow(vector);
        for (const [client, clock] of vector)
          if ((shown.get(client) ?? 0) < clock) shown.set(client, clock);
        handshaken = true;
      } else {
        holds(sync.payload);
        holds(sync.payload, shown);
      }
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
    get shown() {
      return Y.encodeStateVector(shown);
    },
    lacking(document) {
      if (!handshaken) return null;
      for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(document)))
        if ((clocks.get(client) ?? 0) < clock)
          return Y.encodeStateAsUpdate(document, Y.encodeStateVector(clocks));
      return null;
    },
  };
}

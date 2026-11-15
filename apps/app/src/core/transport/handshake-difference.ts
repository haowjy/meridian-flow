/**
 * handshake-difference — what a document holds that the server lacks, read from one handshake.
 *
 * On every handshake the server sends its SyncStep1 (its state vector) and then its SyncStep2 (which
 * carries its whole delete set), both as plain Sync frames. Paired, they say exactly what the server
 * has: the update `Y.encodeStateAsUpdate(document, serverStateVector)` is what the provider sends as
 * its own SyncStep2 reply, and the document equals the server when the server's snapshot contains
 * it. The delete-set half matters: an unsent deletion has no structs. Nothing is stored between
 * handshakes, so partial acknowledgement, reconnect loops, another tab's edits and edits from before
 * this transport existed are all covered, which the outbox is not.
 *
 * Pure bookkeeping over wire frames; the socket subclass in `hocuspocus-document-transport.ts`
 * feeds it, on a read-admitted connection only.
 */
import * as decoding from "lib0/decoding";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import type { HandshakeDifference } from "@/core/editor/document-session";

const MESSAGE_SYNC = 0;

export type HandshakeDifferenceReader = {
  /** A socket opened: forget the last SyncStep1. */
  reset(): void;
  /** Called after the provider applied the frame. */
  noteFrameReceived(frame: Uint8Array): void;
};

/** A Sync frame's type (SyncStep1, SyncStep2 or Update) and payload; null for any other frame. */
export function readSyncFrame(frame: Uint8Array): { syncType: number; payload: Uint8Array } | null {
  try {
    const body = decoding.createDecoder(frame);
    decoding.readVarString(body);
    if (decoding.readVarUint(body) !== MESSAGE_SYNC) return null;
    const syncType = decoding.readVarUint(body);
    if (
      syncType !== messageYjsSyncStep1 &&
      syncType !== messageYjsSyncStep2 &&
      syncType !== messageYjsUpdate
    )
      return null;
    return { syncType, payload: decoding.readVarUint8Array(body) };
  } catch {
    // Pings, pongs, and other frames without a document name.
    return null;
  }
}

/** The server's state vector, when `frame` is its SyncStep1. */
export function readServerStateVector(frame: Uint8Array): Uint8Array | null {
  const sync = readSyncFrame(frame);
  return sync?.syncType === messageYjsSyncStep1 ? sync.payload : null;
}

export function createHandshakeDifferenceReader(
  document: Y.Doc,
  onHandshake: (difference: HandshakeDifference | null) => void,
): HandshakeDifferenceReader {
  let serverStateVector: Uint8Array | null = null;
  return {
    reset() {
      serverStateVector = null;
    },
    noteFrameReceived(frame) {
      const sync = readSyncFrame(frame);
      if (!sync) return;
      if (sync.syncType === messageYjsSyncStep1) {
        serverStateVector = sync.payload;
        return;
      }
      if (sync.syncType !== messageYjsSyncStep2 || !serverStateVector) return;
      const lacking = Y.encodeStateAsUpdate(document, serverStateVector);
      const snapshot = Y.createSnapshot(
        Y.decodeUpdate(sync.payload).ds,
        Y.decodeStateVector(serverStateVector),
      );
      onHandshake(
        Y.snapshotContainsUpdate(snapshot, lacking)
          ? null
          : { lacking, server: Y.encodeSnapshot(snapshot) },
      );
    },
  };
}

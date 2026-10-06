/**
 * server-acknowledgement — answers "has the server acknowledged every local
 * change?" for one document socket, and can answer it again after each
 * reconnect.
 *
 * Why not Hocuspocus' `unsyncedChanges`: `startSync()` resets that counter to
 * one on every handshake, discarding updates still in flight, and updates
 * queued while offline flush later. The first acknowledgement can therefore
 * bring it to zero while later messages are still unacknowledged. This tracker
 * counts what actually went onto the current socket instead.
 *
 * Invariant for `acknowledged`: on the current connection the server has
 * acknowledged (`SyncStatus` applied) the handshake SyncStep2 and every
 * document Update sent since. It is false on any local change, disconnect,
 * reconnect, or rejected (`SyncStatus` not applied) message. For a live
 * document room the server journals a client update (unless the document
 * already contains it) before it applies the update and replies `SyncStatus`,
 * so an acknowledgement means the server applied the edit and journaled it.
 * Only the debounced full-document store is asynchronous, and the next
 * handshake's state-vector diff re-sends anything the server later loses.
 *
 * Pure bookkeeping over wire frames; the socket subclass in
 * `hocuspocus-document-transport.ts` feeds it.
 */
import * as decoding from "lib0/decoding";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";

// Hocuspocus wire frame: varString document name, varUint message type, payload.
const MESSAGE_SYNC = 0;
const MESSAGE_SYNC_STATUS = 8;

export type ServerAcknowledgementTracker = {
  /** A socket opened: start counting from zero. */
  beginConnection(): void;
  /** The socket closed, is reconnecting, or the transport is terminal. */
  endConnection(): void;
  /** A frame was handed to the open socket (not merely queued for later). */
  noteFrameSent(frame: Uint8Array): void;
  /**
   * A document frame was queued because the socket is not open (including
   * `CLOSING`, which precedes the close event). It is not counted as sent, but
   * the server can no longer be said to have everything.
   */
  noteFrameQueued(frame: Uint8Array): void;
  noteFrameReceived(frame: Uint8Array): void;
  readonly acknowledged: boolean;
};

function readMessageType(frame: Uint8Array): { type: number; body: decoding.Decoder } | null {
  try {
    const body = decoding.createDecoder(frame);
    decoding.readVarString(body);
    return { type: decoding.readVarUint(body), body };
  } catch {
    // Pings, pongs, and other frames without a document name.
    return null;
  }
}

/** The Sync sub-type of a SyncStep2 or Update frame; null for anything else. */
function readDocumentSyncType(frame: Uint8Array): number | null {
  const message = readMessageType(frame);
  if (message?.type !== MESSAGE_SYNC) return null;
  try {
    const syncType = decoding.readVarUint(message.body);
    return syncType === messageYjsSyncStep2 || syncType === messageYjsUpdate ? syncType : null;
  } catch {
    return null;
  }
}

export function createServerAcknowledgementTracker(
  onChange: (acknowledged: boolean) => void,
): ServerAcknowledgementTracker {
  let open = false;
  let handshakeSent = false;
  let rejected = false;
  let sent = 0;
  let acknowledgedCount = 0;
  let published = false;

  const compute = () => open && handshakeSent && !rejected && acknowledgedCount >= sent;
  const publish = () => {
    const next = compute();
    if (next === published) return;
    published = next;
    onChange(next);
  };

  return {
    beginConnection() {
      open = true;
      handshakeSent = false;
      rejected = false;
      sent = 0;
      acknowledgedCount = 0;
      publish();
    },
    endConnection() {
      open = false;
      publish();
    },
    noteFrameSent(frame) {
      if (!open) return;
      const syncType = readDocumentSyncType(frame);
      if (syncType === null) return;
      if (syncType === messageYjsSyncStep2) handshakeSent = true;
      sent += 1;
      publish();
    },
    noteFrameQueued(frame) {
      if (readDocumentSyncType(frame) === null) return;
      // The socket is closing or closed: nothing more on it will be acknowledged.
      // The next connection restarts the count and flushes the queued frame.
      open = false;
      publish();
    },
    noteFrameReceived(frame) {
      if (!open) return;
      const message = readMessageType(frame);
      if (message?.type !== MESSAGE_SYNC_STATUS) return;
      let applied: boolean;
      try {
        applied = decoding.readVarInt(message.body) === 1;
      } catch {
        return;
      }
      // An unapplied message (read-only connection) is never "saved". Staying
      // false for the rest of this connection is deliberate: the reconnect
      // handshake is what re-sends the content.
      // Clamp: an acknowledgement for nothing we sent must not pre-pay a later send.
      if (applied) acknowledgedCount = Math.min(acknowledgedCount + 1, sent);
      else rejected = true;
      publish();
    },
    get acknowledged() {
      return published;
    },
  };
}

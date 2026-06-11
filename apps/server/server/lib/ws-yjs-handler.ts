import {
  decodeYjsBinaryEnvelope,
  encodeYjsBinaryEnvelope,
  encodeYjsControlFrame,
  parseYjsClientControlFrame,
  YJS_WS_MESSAGE_AWARENESS,
  YJS_WS_MESSAGE_SYNC,
  type YjsControlErrorCode,
  type YjsServerControlFrame,
} from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { DocumentSyncTransport, UpdateOrigin } from "../domains/collab/ports/document-sync.js";
import type { AppServices } from "./app.js";
import { safeWsSend } from "./ws-safe-send.js";

export const MSG_SYNC = YJS_WS_MESSAGE_SYNC;
export const MSG_AWARENESS = YJS_WS_MESSAGE_AWARENESS;

const IDLE_TIMEOUT_MS = 60_000;

export interface YjsWsHandlerDeps {
  transport: DocumentSyncTransport;
  canAccessDocument: (userId: UserId, documentId: string) => Promise<boolean>;
  updateOrigin?: (peer: YjsWsPeer) => UpdateOrigin;
  commitEditorUpdate?: (
    documentId: string,
    update: Uint8Array,
    origin: UpdateOrigin,
  ) => Promise<void>;
}

export type YjsWsAuthenticatedContext = {
  app: AppServices;
  userId: UserId;
};

export interface YjsWsPeer {
  request?: Request;
  context?: YjsWsAuthenticatedContext;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface DocState {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  peers: Set<ConnState>;
  unobserveDoc: () => void;
}

interface DocRegistryEntry {
  documentId: string;
  state: DocState | null;
  promise: Promise<DocState | null>;
  pendingPeers: Set<PeerState>;
}

interface ConnState {
  peer: YjsWsPeer;
  channelIndex: number;
  documentId: string;
  docEntry: DocRegistryEntry;
  queue: Promise<void>;
  awarenessClientId: number | null;
}

interface PeerState {
  closed: boolean;
  idleTimer: ReturnType<typeof setTimeout>;
  channels: Map<number, ConnState>;
  documentChannels: Map<string, number>;
  pendingDocEntries: Set<DocRegistryEntry>;
  nextChannelIndex: number;
  controlQueue: Promise<void>;
}

function logWsError(name: string, payload: Record<string, unknown>): void {
  console.error(`ws-yjs-handler:${name}`, payload);
}

export function createYjsWsHandler(deps: YjsWsHandlerDeps) {
  const { transport } = deps;
  const updateOrigin = deps.updateOrigin ?? (() => ({ type: "system" as const }));
  const commitEditorUpdate = deps.commitEditorUpdate;
  const docs = new Map<string, DocRegistryEntry>();
  const peers = new WeakMap<YjsWsPeer, PeerState>();

  function getPeerState(peer: YjsWsPeer): PeerState {
    let state = peers.get(peer);
    if (!state) {
      state = {
        closed: false,
        idleTimer: setTimeout(() => peer.close(4408, "idle_timeout"), IDLE_TIMEOUT_MS),
        channels: new Map(),
        documentChannels: new Map(),
        pendingDocEntries: new Set(),
        nextChannelIndex: 0,
        controlQueue: Promise.resolve(),
      };
      peers.set(peer, state);
    }
    return state;
  }

  function resetIdleTimer(peer: YjsWsPeer, state: PeerState): void {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => peer.close(4408, "idle_timeout"), IDLE_TIMEOUT_MS);
  }

  async function loadDocState(documentId: string): Promise<DocState | null> {
    const result = await transport.getDoc(documentId);
    if (!result.ok) {
      logWsError("get_doc.failed", { documentId, error: result.error });
      return null;
    }

    const doc = result.value;
    const awareness = new awarenessProtocol.Awareness(doc);
    const state: DocState = {
      doc,
      awareness,
      peers: new Set(),
      unobserveDoc: () => {},
    };

    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      broadcastExcept(state, origin, encoding.toUint8Array(encoder));
    };
    doc.on("update", onDocUpdate);
    state.unobserveDoc = () => doc.off("update", onDocUpdate);

    awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
        );
        broadcastExcept(state, origin, encoding.toUint8Array(encoder));
      },
    );

    return state;
  }

  function getOrCreateDocEntry(documentId: string): DocRegistryEntry {
    const existing = docs.get(documentId);
    if (existing) return existing;

    const entry: DocRegistryEntry = {
      documentId,
      state: null,
      promise: Promise.resolve(null),
      pendingPeers: new Set(),
    };
    entry.promise = loadDocState(documentId)
      .then((state) => {
        entry.state = state;
        cleanupDocEntryIfIdle(entry);
        return state;
      })
      .catch((error) => {
        destroyDocEntry(entry);
        throw error;
      });
    docs.set(documentId, entry);
    return entry;
  }

  function destroyDocEntry(entry: DocRegistryEntry): void {
    const state = entry.state;
    if (state) {
      state.unobserveDoc();
      state.awareness.destroy();
      entry.state = null;
    }
    if (docs.get(entry.documentId) === entry) {
      docs.delete(entry.documentId);
    }
  }

  function cleanupDocEntryIfIdle(entry: DocRegistryEntry): void {
    if (entry.pendingPeers.size > 0) return;
    if ((entry.state?.peers.size ?? 0) > 0) return;
    destroyDocEntry(entry);
  }

  function addPendingSubscription(peerState: PeerState, entry: DocRegistryEntry): void {
    peerState.pendingDocEntries.add(entry);
    entry.pendingPeers.add(peerState);
  }

  function removePendingSubscription(peerState: PeerState, entry: DocRegistryEntry): void {
    peerState.pendingDocEntries.delete(entry);
    entry.pendingPeers.delete(peerState);
    cleanupDocEntryIfIdle(entry);
  }

  function sendControl(peer: YjsWsPeer, message: YjsServerControlFrame): boolean {
    return safeWsSend(peer, encodeYjsControlFrame(message), {
      logPrefix: "ws-yjs",
      onFailure: () => close(peer),
    });
  }

  function sendError(
    peer: YjsWsPeer,
    code: YjsControlErrorCode,
    reason: string,
    options: { documentId?: string; channelIndex?: number } = {},
  ): boolean {
    return sendControl(peer, { type: "error", code, reason, ...options });
  }

  function sendBinary(peer: YjsWsPeer, conn: ConnState, msg: Uint8Array): boolean {
    return safeWsSend(peer, encodeYjsBinaryEnvelope(conn.channelIndex, msg), {
      logPrefix: "ws-yjs",
      onFailure: () => close(peer),
    });
  }

  function broadcastExcept(state: DocState, origin: unknown, msg: Uint8Array): void {
    for (const conn of Array.from(state.peers)) {
      if (conn === origin) continue;
      sendBinary(conn.peer, conn, msg);
    }
  }

  function disposeChannel(peer: YjsWsPeer, conn: ConnState): void {
    const peerState = peers.get(peer);
    const docState = conn.docEntry.state;

    if (docState) {
      docState.peers.delete(conn);
      if (conn.awarenessClientId !== null) {
        awarenessProtocol.removeAwarenessStates(docState.awareness, [conn.awarenessClientId], null);
      }
      if (docState.peers.size === 0) {
        cleanupDocEntryIfIdle(conn.docEntry);
      }
    }

    peerState?.channels.delete(conn.channelIndex);
    peerState?.documentChannels.delete(conn.documentId);
  }

  function close(peer: YjsWsPeer): void {
    const state = peers.get(peer);
    if (!state) return;

    state.closed = true;
    clearTimeout(state.idleTimer);

    for (const conn of Array.from(state.channels.values())) {
      disposeChannel(peer, conn);
    }

    for (const entry of Array.from(state.pendingDocEntries)) {
      removePendingSubscription(state, entry);
    }

    peers.delete(peer);
  }

  async function processBinaryPayload(
    peer: YjsWsPeer,
    docState: DocState,
    conn: ConnState,
    data: Uint8Array,
  ): Promise<void> {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MSG_SYNC: {
        const state = await transport.encodeState(conn.documentId);
        if (!state.ok) {
          logWsError("encode_state.failed", { documentId: conn.documentId, error: state.error });
          return;
        }

        const shadowDoc = new Y.Doc();
        Y.applyUpdate(shadowDoc, state.value);
        const capturedUpdates: Uint8Array[] = [];
        const captureUpdate = (update: Uint8Array, origin: unknown) => {
          if (origin === conn) capturedUpdates.push(update);
        };
        shadowDoc.on("update", captureUpdate);

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);

        try {
          syncProtocol.readSyncMessage(decoder, encoder, shadowDoc, conn, (error: Error) => {
            logWsError("sync_protocol.error", {
              documentId: conn.documentId,
              message: error.message,
            });
          });
        } finally {
          shadowDoc.off("update", captureUpdate);
          shadowDoc.destroy();
        }

        if (encoding.length(encoder) > 1) {
          sendBinary(peer, conn, encoding.toUint8Array(encoder));
        }

        if (capturedUpdates.length > 0) {
          const delta =
            capturedUpdates.length === 1 ? capturedUpdates[0] : Y.mergeUpdates(capturedUpdates);
          const origin = updateOrigin(peer);
          if (!commitEditorUpdate) {
            logWsError("commit_editor_update.missing", { documentId: conn.documentId });
            return;
          }
          try {
            await commitEditorUpdate(conn.documentId, delta, origin);
          } catch (error) {
            logWsError("commit_editor_update.failed", {
              documentId: conn.documentId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        break;
      }

      case MSG_AWARENESS: {
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(docState.awareness, update, conn);
        if (conn.awarenessClientId === null) {
          const ad = decoding.createDecoder(update);
          const len = decoding.readVarUint(ad);
          if (len > 0) {
            conn.awarenessClientId = decoding.readVarUint(ad);
          }
        }
        break;
      }

      default:
        logWsError("unknown_message_type", { documentId: conn.documentId, messageType });
    }
  }

  async function subscribeDocument(peer: YjsWsPeer, documentId: string): Promise<void> {
    const auth = peer.context;
    if (!auth) {
      sendError(peer, "auth_failed", "Authenticate before subscribing", { documentId });
      return;
    }

    try {
      const allowed = await deps.canAccessDocument(auth.userId, documentId);
      const peerState = peers.get(peer);
      if (!peerState || peerState.closed) return;
      if (!allowed) {
        sendError(peer, "document_not_found", "Document not found", { documentId });
        return;
      }
    } catch (error) {
      logWsError("document_access.failed", {
        documentId,
        message: error instanceof Error ? error.message : String(error),
      });
      sendError(peer, "internal", "Document access check failed", { documentId });
      return;
    }

    const peerState = peers.get(peer);
    if (!peerState || peerState.closed) return;
    const existingChannel = peerState.documentChannels.get(documentId);
    if (existingChannel !== undefined) {
      sendControl(peer, { type: "subscribed", documentId, channelIndex: existingChannel });
      return;
    }

    const docEntry = getOrCreateDocEntry(documentId);
    addPendingSubscription(peerState, docEntry);

    let docState: DocState | null;
    try {
      docState = await docEntry.promise;
    } catch (error) {
      removePendingSubscription(peerState, docEntry);
      throw error;
    }

    const livePeerState = peers.get(peer);
    if (!livePeerState || livePeerState.closed) {
      removePendingSubscription(peerState, docEntry);
      return;
    }
    if (!docState) {
      removePendingSubscription(peerState, docEntry);
      sendError(peer, "document_not_found", "Document not found", { documentId });
      return;
    }

    const conn: ConnState = {
      peer,
      channelIndex: livePeerState.nextChannelIndex,
      documentId,
      docEntry,
      queue: Promise.resolve(),
      awarenessClientId: null,
    };
    livePeerState.nextChannelIndex += 1;
    livePeerState.channels.set(conn.channelIndex, conn);
    livePeerState.documentChannels.set(documentId, conn.channelIndex);
    docState.peers.add(conn);
    removePendingSubscription(peerState, docEntry);

    conn.queue = conn.queue
      .then(async () => {
        if (
          !sendControl(peer, { type: "subscribed", documentId, channelIndex: conn.channelIndex })
        ) {
          return;
        }

        const enc1 = encoding.createEncoder();
        encoding.writeVarUint(enc1, MSG_SYNC);
        syncProtocol.writeSyncStep1(enc1, docState.doc);
        if (!sendBinary(peer, conn, encoding.toUint8Array(enc1))) return;

        const enc2 = encoding.createEncoder();
        encoding.writeVarUint(enc2, MSG_SYNC);
        syncProtocol.writeSyncStep2(enc2, docState.doc);
        if (!sendBinary(peer, conn, encoding.toUint8Array(enc2))) return;

        const states = docState.awareness.getStates();
        if (states.size > 0) {
          const enc3 = encoding.createEncoder();
          encoding.writeVarUint(enc3, MSG_AWARENESS);
          encoding.writeVarUint8Array(
            enc3,
            awarenessProtocol.encodeAwarenessUpdate(docState.awareness, Array.from(states.keys())),
          );
          sendBinary(peer, conn, encoding.toUint8Array(enc3));
        }
      })
      .catch((error) => {
        logWsError("channel_init.failed", {
          documentId,
          channelIndex: conn.channelIndex,
          message: error instanceof Error ? error.message : String(error),
        });
        disposeChannel(peer, conn);
        sendError(peer, "internal", "Channel initialization failed", {
          documentId,
          channelIndex: conn.channelIndex,
        });
      });

    await conn.queue;
  }

  function unsubscribeDocument(peer: YjsWsPeer, documentId: string): void {
    const peerState = peers.get(peer);
    if (!peerState) return;
    const channelIndex = peerState.documentChannels.get(documentId);
    if (channelIndex === undefined) return;
    const conn = peerState.channels.get(channelIndex);
    if (conn) disposeChannel(peer, conn);
  }

  function open(peer: YjsWsPeer): boolean {
    if (!peer.context) {
      sendError(peer, "auth_failed", "Authentication failed");
      peer.close(4401, "auth_failed");
      return false;
    }
    getPeerState(peer);
    return true;
  }

  async function handleMessage(peer: YjsWsPeer, raw: string | Uint8Array): Promise<void> {
    const state = peers.get(peer);
    if (!state) return;
    resetIdleTimer(peer, state);

    if (typeof raw === "string") {
      const message = parseYjsClientControlFrame(raw);
      if (!message) {
        sendError(peer, "bad_request", "Malformed Yjs control frame");
        return;
      }

      state.controlQueue = state.controlQueue
        .then(async () => {
          if (state.closed) return;
          switch (message.type) {
            case "subscribe":
              await subscribeDocument(peer, message.documentId);
              return;
            case "unsubscribe":
              unsubscribeDocument(peer, message.documentId);
              return;
          }
        })
        .catch((error) => {
          logWsError("control_message.failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          sendError(peer, "internal", "Control message handling failed");
        });
      await state.controlQueue;
      return;
    }

    const frame = decodeYjsBinaryEnvelope(raw);
    if (!frame) {
      sendError(peer, "bad_request", "Malformed Yjs binary envelope");
      return;
    }

    const conn = state.channels.get(frame.channelIndex);
    if (!conn) {
      sendError(peer, "not_subscribed", "Channel is not subscribed", {
        channelIndex: frame.channelIndex,
      });
      return;
    }

    conn.queue = conn.queue
      .then(async () => {
        const docState = conn.docEntry.state;
        if (!docState) return;
        await processBinaryPayload(peer, docState, conn, frame.payload);
      })
      .catch((error) => {
        logWsError("message_handling.failed", {
          documentId: conn.documentId,
          channelIndex: conn.channelIndex,
          message: error instanceof Error ? error.message : String(error),
        });
        sendError(peer, "internal", "Message handling failed", {
          documentId: conn.documentId,
          channelIndex: conn.channelIndex,
        });
      });
  }

  function message(peer: YjsWsPeer, raw: string | Uint8Array): void {
    void handleMessage(peer, raw).catch((error) => {
      logWsError("on_message.unhandled", {
        message: error instanceof Error ? error.message : String(error),
      });
      sendError(peer, "internal", "Internal server error");
    });
  }

  function forgetDocument(documentId: string): void {
    const entry = docs.get(documentId);
    if (!entry) return;
    destroyDocEntry(entry);
  }

  return { open, message, close, forgetDocument };
}

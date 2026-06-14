// @ts-nocheck
/**
 * document-session-transport — multiplexed Yjs sync/awareness over ONE socket.
 *
 * A shared WebSocket to `/ws/yjs` carries every collaborative document. Each
 * document gets a `DocumentChannel` (a `DocumentSessionTransportProvider`) that
 * the editor binds to exactly as it did the old per-document transport. The
 * socket owns connect/reconnect/backoff and ping-timeout liveness; channels own
 * their Yjs `Y.Doc`/awareness framing.
 *
 * Wire contract (`@meridian/contracts/protocol` → yjs-multiplex):
 *  - Control frames are JSON text: client `{type:"subscribe"|"unsubscribe"}`,
 *    server `{type:"subscribed", channelIndex}` / `{type:"error", ...}`.
 *  - Binary frames are varuint-channel-prefixed; the payload is the same
 *    `[messageType, ...]` Yjs sync/awareness frame as before.
 *  - Outgoing binary requires the server-assigned `channelIndex`, so a channel
 *    can only send after its `subscribed` ack; sync step1 + awareness are sent
 *    then (and again on every resubscribe), letting Yjs reconcile.
 *
 * Mirrors `WsThreadTransport` (socket/backoff) + `ws-thread-subscription`
 * (per-key registry). Thread/agent events use `WsThreadTransport` instead.
 */
import {
  decodeYjsBinaryEnvelope,
  encodeYjsBinaryEnvelope,
  encodeYjsControlFrame,
  parseYjsServerControlFrame,
  YJS_WS_MESSAGE_AWARENESS,
  YJS_WS_MESSAGE_SYNC,
  type YjsControlErrorCode,
  yjsWsPath,
} from "@meridian/contracts/protocol";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { type Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

import { buildSameOriginWsUrl } from "./dev-transport";
import { SocketLifecycleController, type SocketLifecycleOptions } from "./socket-lifecycle";
import type { ConnectionState } from "./ThreadTransport";

export type YjsWsDecodedMessage =
  | { type: "sync"; decoder: decoding.Decoder }
  | { type: "awareness"; update: Uint8Array };

export type DocumentChannelError = {
  code: YjsControlErrorCode;
  reason: string;
};

export function encodeSyncStep1Message(document: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, YJS_WS_MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, document);
  return encoding.toUint8Array(encoder);
}

export function encodeSyncUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, YJS_WS_MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwarenessMessage(
  awareness: Awareness,
  clientIds: readonly number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, YJS_WS_MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, Array.from(clientIds)));
  return encoding.toUint8Array(encoder);
}

export function decodeYjsWsMessage(data: Uint8Array): YjsWsDecodedMessage | null {
  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);
  if (messageType === YJS_WS_MESSAGE_SYNC) {
    return { type: "sync", decoder };
  }
  if (messageType === YJS_WS_MESSAGE_AWARENESS) {
    return { type: "awareness", update: decoding.readVarUint8Array(decoder) };
  }
  return null;
}

/** Provider surface consumed by `DocumentSession` (one per document). */
export type DocumentChannelProvider = {
  awareness: Awareness;
  synced: boolean;
  whenSynced: Promise<void>;
  subscribeStatus(listener: (state: ConnectionState) => void): () => void;
  onError(listener: (error: DocumentChannelError) => void): () => void;
  destroy: () => void;
};

export type DocumentSessionTransportOptions = SocketLifecycleOptions;

/**
 * One document's channel. Owns its `Y.Doc`/awareness event wiring and the Yjs
 * framing; the parent socket pumps inbound payloads in and channel-prefixes
 * outbound frames. `channelIndex` is `null` until the server acks `subscribe`.
 */
export class DocumentChannel implements DocumentChannelProvider {
  readonly documentId: string;
  readonly awareness: Awareness;
  readonly whenSynced: Promise<void>;

  channelIndex: number | null = null;

  private readonly document: Y.Doc;
  private readonly sendBinary: (channelIndex: number, payload: Uint8Array) => void;
  private readonly onDispose: (documentId: string) => void;
  private readonly onSynced: () => void;
  private readonly resolveSynced: () => void;
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>();
  private readonly errorListeners = new Set<(error: DocumentChannelError) => void>();

  private connectionState: ConnectionState = { kind: "connecting", attempt: 1 };
  private initialSynced = false;
  private destroyed = false;

  constructor(options: {
    documentId: string;
    document: Y.Doc;
    awareness: Awareness;
    sendBinary: (channelIndex: number, payload: Uint8Array) => void;
    onDispose: (documentId: string) => void;
    onSynced: () => void;
  }) {
    this.documentId = options.documentId;
    this.document = options.document;
    this.awareness = options.awareness;
    this.sendBinary = options.sendBinary;
    this.onDispose = options.onDispose;
    this.onSynced = options.onSynced;

    let resolveSynced!: () => void;
    this.whenSynced = new Promise<void>((resolve) => {
      resolveSynced = resolve;
    });
    this.resolveSynced = resolveSynced;

    this.document.on("update", this.handleDocumentUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);
  }

  get synced(): boolean {
    return this.initialSynced;
  }

  subscribeStatus(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  onError(listener: (error: DocumentChannelError) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.document.off("update", this.handleDocumentUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.onDispose(this.documentId);
  }

  /** Socket → channel: the server acked our subscribe. Begin Yjs sync. */
  onSubscribed(channelIndex: number): void {
    if (this.destroyed) return;
    this.channelIndex = channelIndex;
    this.send(encodeSyncStep1Message(this.document));
    this.sendLocalAwareness();
  }

  /** Socket → channel: the connection dropped; channel must re-sync on ack. */
  onDisconnected(state: ConnectionState): void {
    this.channelIndex = null;
    this.publishConnectionState(state);
  }

  publishConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    for (const listener of this.connectionListeners) listener(state);
  }

  /** Socket → channel: a per-channel error frame for this document. */
  emitError(error: DocumentChannelError): void {
    for (const listener of this.errorListeners) listener(error);
  }

  /** Socket → channel: a decoded binary payload addressed to this channel. */
  handlePayload(payload: Uint8Array): void {
    if (this.destroyed) return;
    const decoded = decodeYjsWsMessage(payload);
    if (!decoded) return;

    switch (decoded.type) {
      case "sync": {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, YJS_WS_MESSAGE_SYNC);
        syncProtocol.readSyncMessage(
          decoded.decoder,
          encoder,
          this.document,
          this,
          (error: Error) => console.error("document-session-transport: sync protocol error", error),
        );
        if (encoding.length(encoder) > 1) {
          this.send(encoding.toUint8Array(encoder));
        }
        this.markSynced();
        break;
      }
      case "awareness":
        applyAwarenessUpdate(this.awareness, decoded.update, this);
        break;
    }
  }

  private markSynced(): void {
    this.publishConnectionState({ kind: "connected" });
    this.onSynced();
    if (this.initialSynced) return;
    this.initialSynced = true;
    this.resolveSynced();
  }

  private send(payload: Uint8Array): void {
    if (this.channelIndex === null) return;
    this.sendBinary(this.channelIndex, payload);
  }

  private sendLocalAwareness(): void {
    const state = this.awareness.getLocalState();
    if (!state) return;
    this.send(encodeAwarenessMessage(this.awareness, [this.document.clientID]));
  }

  private handleDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    this.send(encodeSyncUpdateMessage(update));
  };

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    const changed = [...added, ...updated, ...removed];
    if (changed.length === 0) return;
    this.send(encodeAwarenessMessage(this.awareness, changed));
  };
}

export class DocumentSessionTransport {
  private readonly socket: SocketLifecycleController;
  private readonly now: () => number;

  /** documentId → channel. The registry of every live subscription. */
  private readonly channels = new Map<string, DocumentChannel>();
  /** channelIndex → documentId, valid only for the current socket generation. */
  private readonly channelIndexToDocument = new Map<number, string>();

  constructor(options: DocumentSessionTransportOptions = {}) {
    this.socket = new SocketLifecycleController(
      {
        buildUrl: () => buildSameOriginWsUrl(yjsWsPath()),
        binaryType: "arraybuffer",
        wantsConnection: () => this.channels.size > 0,
        onOpen: () => {
          this.channelIndexToDocument.clear();
          // Re-subscribe every active channel; the server replies `subscribed`
          // per document and each channel then runs Yjs sync step1 to reconcile.
          for (const documentId of this.channels.keys()) {
            this.sendControl({ type: "subscribe", documentId });
          }
        },
        onMessage: (data) => this.handleSocketMessage(data),
        onClose: () => {
          this.channelIndexToDocument.clear();
        },
        onSocketError: () => {
          const attempt = this.socket.state.kind === "connecting" ? this.socket.state.attempt : 1;
          this.socket.publishConnectionState({
            kind: "degraded",
            attempt,
            nextRetryAt: this.now(),
          });
        },
        publishConnectionState: (state) => this.fanOutConnectionState(state),
      },
      options,
    );
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Open (or reuse) the shared socket and register a channel for `documentId`.
   * The returned provider is what `DocumentSession` binds to. One channel per
   * document — subscribing twice for the same id is a programmer error.
   */
  subscribe(options: {
    documentId: string;
    document: Y.Doc;
    awareness: Awareness;
  }): DocumentChannel {
    const { documentId } = options;
    if (this.channels.has(documentId)) {
      throw new Error(`document-session-transport: already subscribed to ${documentId}`);
    }

    const channel = new DocumentChannel({
      documentId,
      document: options.document,
      awareness: options.awareness,
      sendBinary: (channelIndex, payload) => this.sendBinary(channelIndex, payload),
      onDispose: (id) => this.unsubscribe(id),
      onSynced: () => {
        this.socket.resetBackoff();
      },
    });
    this.channels.set(documentId, channel);

    this.socket.ensureConnected();
    if (this.socket.isSocketOpen()) {
      this.sendControl({ type: "subscribe", documentId });
    }
    return channel;
  }

  unsubscribe(documentId: string): void {
    const channel = this.channels.get(documentId);
    if (!channel) return;
    this.channels.delete(documentId);
    if (channel.channelIndex !== null) {
      this.channelIndexToDocument.delete(channel.channelIndex);
    }
    if (this.socket.isSocketOpen()) {
      this.sendControl({ type: "unsubscribe", documentId });
    }
    if (this.channels.size === 0) {
      this.channelIndexToDocument.clear();
      this.socket.teardown();
    }
  }

  private handleSocketMessage(data: unknown): void {
    if (typeof data === "string") {
      this.handleControlFrame(data);
      return;
    }
    void this.readMessageData(data).then((bytes) => {
      if (!bytes) return;
      this.handleBinaryFrame(bytes);
    });
  }

  private handleControlFrame(raw: string): void {
    const frame = parseYjsServerControlFrame(raw);
    if (!frame) return;

    if (frame.type === "subscribed") {
      const channel = this.channels.get(frame.documentId);
      if (!channel) return;
      this.channelIndexToDocument.set(frame.channelIndex, frame.documentId);
      channel.onSubscribed(frame.channelIndex);
      return;
    }

    // error frame: isolate to the offending channel when addressable.
    const error: DocumentChannelError = { code: frame.code, reason: frame.reason };
    if (frame.documentId) {
      this.channels.get(frame.documentId)?.emitError(error);
      return;
    }
    if (frame.channelIndex !== undefined) {
      const documentId = this.channelIndexToDocument.get(frame.channelIndex);
      if (documentId) this.channels.get(documentId)?.emitError(error);
      return;
    }
    // Socket-wide error (no document/channel): surface to every channel.
    for (const channel of this.channels.values()) channel.emitError(error);
  }

  private handleBinaryFrame(bytes: Uint8Array): void {
    const envelope = decodeYjsBinaryEnvelope(bytes);
    if (!envelope) return;
    const documentId = this.channelIndexToDocument.get(envelope.channelIndex);
    if (!documentId) return;
    this.channels.get(documentId)?.handlePayload(envelope.payload);
  }

  private sendControl(message: { type: "subscribe" | "unsubscribe"; documentId: string }): void {
    this.socket.send(encodeYjsControlFrame(message));
  }

  private sendBinary(channelIndex: number, payload: Uint8Array): void {
    if (!this.socket.isSocketOpen()) return;
    const frame = encodeYjsBinaryEnvelope(channelIndex, payload);
    this.socket.send(new Uint8Array(frame).buffer);
  }

  private async readMessageData(data: unknown): Promise<Uint8Array | null> {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    return null;
  }

  private fanOutConnectionState(state: ConnectionState): void {
    for (const channel of this.channels.values()) {
      // On a fresh non-connected socket state, channels lose their index and
      // must re-sync once re-subscribed.
      if (state.kind !== "connected") {
        channel.onDisconnected(state);
      } else {
        channel.publishConnectionState(state);
      }
    }
  }
}

/** Process-wide shared socket. Document collab multiplexes through this one. */
let sharedTransport: DocumentSessionTransport | null = null;

export function getDocumentSessionTransport(): DocumentSessionTransport {
  if (!sharedTransport) {
    sharedTransport = new DocumentSessionTransport();
  }
  return sharedTransport;
}

/** Test seam: install a transport (e.g. with a fake socket) or reset to default. */
export function setDocumentSessionTransport(transport: DocumentSessionTransport | null): void {
  sharedTransport = transport;
}

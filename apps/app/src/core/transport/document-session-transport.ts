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
import { serverWebSocketUrl } from "@/client/server-origin";
import type { ConnectionState } from "./connection-state";

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

export type DocumentChannelProvider = {
  awareness: Awareness;
  synced: boolean;
  whenSynced: Promise<void>;
  subscribeStatus(listener: (state: ConnectionState) => void): () => void;
  onError(listener: (error: DocumentChannelError) => void): () => void;
  destroy: () => void;
};

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
    return () => this.connectionListeners.delete(listener);
  }

  onError(listener: (error: DocumentChannelError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.document.off("update", this.handleDocumentUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.onDispose(this.documentId);
  }

  onSubscribed(channelIndex: number): void {
    if (this.destroyed) return;
    this.channelIndex = channelIndex;
    this.send(encodeSyncStep1Message(this.document));
    this.sendLocalAwareness();
  }

  onDisconnected(state: ConnectionState): void {
    this.channelIndex = null;
    this.publishConnectionState(state);
  }

  publishConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    for (const listener of this.connectionListeners) listener(state);
  }

  emitError(error: DocumentChannelError): void {
    for (const listener of this.errorListeners) listener(error);
  }

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
          (error: Error) => console.error("document-session-transport: sync error", error),
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
  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private readonly channels = new Map<string, DocumentChannel>();
  private readonly channelIndexToDocument = new Map<number, string>();

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
      onSynced: () => undefined,
    });
    this.channels.set(documentId, channel);
    this.ensureConnected();
    if (this.socket?.readyState === WebSocket.OPEN) {
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
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendControl({ type: "unsubscribe", documentId });
    }
    if (this.channels.size === 0) {
      this.channelIndexToDocument.clear();
      this.socket?.close();
      this.socket = null;
      this.socketGeneration += 1;
    }
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.socketGeneration === generation;
  }

  private ensureConnected(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const socket = new WebSocket(serverWebSocketUrl(yjsWsPath()));
    socket.binaryType = "arraybuffer";
    const generation = this.socketGeneration + 1;
    this.socketGeneration = generation;
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.channelIndexToDocument.clear();
      for (const documentId of this.channels.keys()) {
        this.sendControl({ type: "subscribe", documentId });
      }
      for (const channel of this.channels.values()) {
        channel.publishConnectionState({ kind: "connecting", attempt: 1 });
      }
    });

    socket.addEventListener("message", (event) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      void this.handleSocketMessage(event.data, socket, generation);
    });

    socket.addEventListener("close", () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.channelIndexToDocument.clear();
      for (const channel of this.channels.values()) {
        channel.onDisconnected({ kind: "disconnected" });
      }
      if (this.channels.size > 0) {
        this.socket = null;
        this.ensureConnected();
      }
    });

    socket.addEventListener("error", () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      for (const channel of this.channels.values()) {
        channel.publishConnectionState({ kind: "degraded", attempt: 1, nextRetryAt: Date.now() });
      }
    });
  }

  private handleSocketMessage(data: unknown, socket: WebSocket, generation: number): void {
    if (!this.isCurrentSocket(socket, generation)) return;
    if (typeof data === "string") {
      this.handleControlFrame(data);
      return;
    }
    void this.readMessageData(data).then((bytes) => {
      if (!this.isCurrentSocket(socket, generation) || !bytes) return;
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
    this.socket?.send(encodeYjsControlFrame(message));
  }

  private sendBinary(channelIndex: number, payload: Uint8Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const frame = encodeYjsBinaryEnvelope(channelIndex, payload);
    const bytes = new ArrayBuffer(frame.byteLength);
    new Uint8Array(bytes).set(frame);
    this.socket.send(bytes);
  }

  private async readMessageData(data: unknown): Promise<Uint8Array | null> {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    return null;
  }
}

let sharedTransport: DocumentSessionTransport | null = null;

export function getDocumentSessionTransport(): DocumentSessionTransport {
  if (!sharedTransport) {
    sharedTransport = new DocumentSessionTransport();
  }
  return sharedTransport;
}

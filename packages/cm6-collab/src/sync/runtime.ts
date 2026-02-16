import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

import {
  envelopeFromSyncType,
  frameEnvelope,
  MeridianEnvelopeType,
  unwrapEnvelope,
  type SyncMessageType,
} from "./envelope";

export type CollabSyncStatus = "disconnected" | "syncing" | "connected";

export interface CollabServerErrorEvent {
  type: "error";
  code: string;
  message: string;
}

export interface CollabHeartbeatEvent {
  type: "heartbeat";
}

export type CollabServerTextEvent =
  | CollabHeartbeatEvent
  | CollabServerErrorEvent;

export interface CreateCollabSyncRuntimeOptions {
  documentId: string;
  textKey?: string;
  sendBinary: (frame: Uint8Array) => void;
  onStatusChange?: (status: CollabSyncStatus) => void;
}

/**
 * Yjs sync runtime that is transport-agnostic.
 * The host app owns websocket lifecycle and routes binary/text frames into this runtime.
 */
export class CollabSyncRuntime {
  public readonly documentId: string;
  public readonly ydoc: Y.Doc;
  public readonly ytext: Y.Text;
  public readonly awareness: Awareness;
  public readonly undoManager: Y.UndoManager;
  public readonly extensions: Extension[];

  private readonly sendBinary: (frame: Uint8Array) => void;
  private readonly onStatusChange?: (status: CollabSyncStatus) => void;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwarenessUpdate: (
    data: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  private status: CollabSyncStatus = "disconnected";

  constructor(options: CreateCollabSyncRuntimeOptions) {
    this.documentId = options.documentId;
    this.sendBinary = options.sendBinary;
    this.onStatusChange = options.onStatusChange;

    this.ydoc = new Y.Doc({ guid: options.documentId });
    this.ytext = this.ydoc.getText(options.textKey ?? "content");

    this.awareness = new Awareness(this.ydoc);
    this.undoManager = new Y.UndoManager(this.ytext);

    this.extensions = [
      yCollab(this.ytext, this.awareness, { undoManager: this.undoManager }),
      Prec.highest(keymap.of(yUndoManagerKeymap)),
    ];

    this.onDocUpdate = (update, origin) => {
      if (origin === this) {
        return;
      }

      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      this.sendEnvelope(MeridianEnvelopeType.Update, encoding.toUint8Array(encoder));
    };

    this.onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this) {
        return;
      }

      const clients = added.concat(updated, removed);
      if (clients.length === 0) {
        return;
      }

      const payload = encodeAwarenessUpdate(this.awareness, clients);
      this.sendEnvelope(MeridianEnvelopeType.Awareness, payload);
    };

    this.ydoc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
  }

  getStatus(): CollabSyncStatus {
    return this.status;
  }

  setLocalAwarenessState(state: Record<string, unknown> | null): void {
    this.awareness.setLocalState(state as Record<string, unknown> | null);
  }

  startSync(): void {
    this.setStatus("syncing");

    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.ydoc);
    this.sendEnvelope(MeridianEnvelopeType.SyncStep1, encoding.toUint8Array(encoder));
  }

  /**
   * Bootstrap legacy REST content only when the synced doc is still empty.
   * Returns true when bootstrap text was inserted.
   */
  bootstrapTextIfEmpty(text: string): boolean {
    if (!text || this.ytext.length > 0) {
      return false;
    }

    this.ydoc.transact(() => {
      if (this.ytext.length === 0) {
        this.ytext.insert(0, text);
      }
    }, "bootstrap");

    return this.ytext.length > 0;
  }

  handleBinaryFrame(frame: Uint8Array): void {
    const { envelope, payload } = unwrapEnvelope(frame);
    if (envelope == null) {
      return;
    }

    switch (envelope) {
      case MeridianEnvelopeType.SyncStep1:
      case MeridianEnvelopeType.SyncStep2:
      case MeridianEnvelopeType.Update:
        this.handleSyncPayload(payload);
        return;
      case MeridianEnvelopeType.Awareness:
        applyAwarenessUpdate(this.awareness, payload, this);
        return;
      default:
        return;
    }
  }

  destroy(): void {
    this.setStatus("disconnected");
    this.ydoc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.awareness.destroy();
    this.undoManager.destroy();
    this.ydoc.destroy();
  }

  private handleSyncPayload(payload: Uint8Array): void {
    const decoder = decoding.createDecoder(payload);
    const encoder = encoding.createEncoder();

    syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, this);

    const response = encoding.toUint8Array(encoder);
    if (response.length > 0) {
      const syncType = readSyncType(response);
      this.sendEnvelope(envelopeFromSyncType(syncType), response);
    }

    if (this.status !== "connected") {
      this.setStatus("connected");
    }
  }

  private sendEnvelope(envelope: MeridianEnvelopeType, payload: Uint8Array): void {
    this.sendBinary(frameEnvelope(envelope, payload));
  }

  private setStatus(next: CollabSyncStatus): void {
    if (this.status === next) {
      return;
    }

    this.status = next;
    this.onStatusChange?.(next);
  }
}

function readSyncType(syncPayload: Uint8Array): SyncMessageType {
  const decoder = decoding.createDecoder(syncPayload);
  return decoding.readVarUint(decoder) as SyncMessageType;
}

export function parseCollabServerTextEvent(raw: string): CollabServerTextEvent | null {
  try {
    const parsed = JSON.parse(raw) as CollabServerTextEvent;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildHeartbeatAckMessage(): string {
  return JSON.stringify({ type: "heartbeat" });
}

export function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  return new Uint8Array(data);
}

export function createCollabSyncRuntime(
  options: CreateCollabSyncRuntimeOptions,
): CollabSyncRuntime {
  return new CollabSyncRuntime(options);
}

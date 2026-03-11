import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { makeLogger } from "@/core/lib/logger";
import type {
  ProposalGroupAcceptResultEvent,
  ProposalNewEvent,
  ProposalSnapshotEvent,
  ProposalStatusChangedEvent,
} from "../proposals/contracts";

const log = makeLogger("cm6-collab-runtime");
const DOC_WS_PREFIX_SYNC = 0x00;
const DOC_WS_PREFIX_AWARENESS = 0x01;
const SYNC_MESSAGE_STEP2 = 1;

export type CollabSyncStatus = "disconnected" | "syncing" | "connected";

export interface CollabServerErrorEvent {
  type: "error";
  code: string;
  message: string;
}

export interface CollabHeartbeatEvent {
  type: "heartbeat";
}

export interface CollabUnknownTextEvent {
  type: string;
  [key: string]: unknown;
}

export type CollabServerTextEvent =
  | CollabHeartbeatEvent
  | CollabServerErrorEvent
  | ProposalSnapshotEvent
  | ProposalNewEvent
  | ProposalStatusChangedEvent
  | ProposalGroupAcceptResultEvent
  | CollabUnknownTextEvent;

export interface CreateCollabSyncRuntimeOptions {
  documentId: string;
  textKey?: string;
  sendBinary: (frame: Uint8Array) => void;
  onStatusChange?: (status: CollabSyncStatus) => void;
  /** Fires once after the first SyncStep2 is processed (server diff = initial sync done).
   *  Does NOT re-fire on subsequent messages. */
  onInitialSyncComplete?: () => void;
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
  private readonly onInitialSyncComplete?: () => void;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwarenessUpdate: (
    data: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  private status: CollabSyncStatus = "disconnected";
  private didFireInitialSync = false;
  // Defense-in-depth: prevents duplicate start calls from re-sending SyncStep1
  // within the same websocket lifecycle.
  private didStartSync = false;

  constructor(options: CreateCollabSyncRuntimeOptions) {
    this.documentId = options.documentId;
    this.sendBinary = options.sendBinary;
    this.onStatusChange = options.onStatusChange;
    this.onInitialSyncComplete = options.onInitialSyncComplete;

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
      this.sendBinary(
        frameWithPrefix(
          DOC_WS_PREFIX_SYNC,
          encoding.toUint8Array(encoder),
        ),
      );
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
      this.sendBinary(frameWithPrefix(DOC_WS_PREFIX_AWARENESS, payload));
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
    if (this.didStartSync) {
      log.debug("startSync already called, skipping duplicate", {
        documentId: this.documentId,
      });
      return;
    }
    this.didStartSync = true;
    this.setStatus("syncing");

    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.ydoc);
    this.sendBinary(
      frameWithPrefix(DOC_WS_PREFIX_SYNC, encoding.toUint8Array(encoder)),
    );
  }

  reset(): void {
    this.didStartSync = false;
    this.didFireInitialSync = false;
    this.setStatus("disconnected");
  }

  handleBinaryFrame(frame: Uint8Array): void {
    if (frame.length < 1) {
      return;
    }

    const prefix = frame[0];
    const payload = frame.subarray(1);
    switch (prefix) {
      case DOC_WS_PREFIX_SYNC: {
        const syncType = readSyncType(payload);
        this.handleSyncPayload(payload);
        // SyncStep2 = server's diff response = initial sync is complete.
        // Fire callback once so consumers know server state is in ytext.
        if (syncType === SYNC_MESSAGE_STEP2 && !this.didFireInitialSync) {
          this.didFireInitialSync = true;
          this.onInitialSyncComplete?.();
        }
        return;
      }
      case DOC_WS_PREFIX_AWARENESS:
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
      this.sendBinary(frameWithPrefix(DOC_WS_PREFIX_SYNC, response));
    }

    if (this.status !== "connected") {
      this.setStatus("connected");
    }
  }

  private setStatus(next: CollabSyncStatus): void {
    if (this.status === next) {
      return;
    }

    this.status = next;
    this.onStatusChange?.(next);
  }
}

function readSyncType(syncPayload: Uint8Array): number {
  if (syncPayload.length === 0) {
    return -1;
  }

  const decoder = decoding.createDecoder(syncPayload);
  return decoding.readVarUint(decoder);
}

function frameWithPrefix(prefix: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(1 + payload.length);
  framed[0] = prefix;
  framed.set(payload, 1);
  return framed;
}

export function parseCollabServerTextEvent(
  raw: string,
): CollabServerTextEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      !("type" in parsed) ||
      typeof parsed.type !== "string"
    ) {
      return null;
    }
    return parsed as CollabServerTextEvent;
  } catch (error) {
    log.warn("failed to parse collab text event", {
      error: error instanceof Error ? error.message : String(error),
    });
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

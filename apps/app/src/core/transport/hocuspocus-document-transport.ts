/**
 * hocuspocus-document-transport — binds HocuspocusProvider to DocumentSession.
 *
 * DocumentSession remains the owner of the Y.Doc, Awareness, and IndexedDB
 * cache. This adapter owns one socket per room because WebSocket closes are
 * connection-wide, while schema refusals are room-specific. It maps those
 * provider/socket events back to the unchanged DocumentSessionTransportProvider
 * seam.
 */
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  type onAuthenticationFailedParameters,
  type onCloseParameters,
  type onStatelessParameters,
  type onStatusParameters,
  type onSyncedParameters,
  type onUnsyncedChangesParameters,
  WebSocketStatus,
} from "@hocuspocus/provider";
import {
  type ChangeEventWsMessage,
  parseYjsStatelessMessage,
  WS_CLOSE,
  yjsWsPath,
} from "@meridian/contracts/protocol";
import { COLLAB_SCHEMA_VERSION, formatCollabSchemaSubprotocol } from "@meridian/prosemirror-schema";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type {
  DocumentSessionConnectionState,
  DocumentSessionResetReason,
  DocumentSessionTransportProvider,
} from "@/core/editor/document-session";

import type { ConnectivityHintsPort } from "./connectivity-hints";
import { buildSameOriginWsUrl } from "./dev-transport";
import { notifyYjsRoomAttached, TappedWebSocket } from "./tapped-websocket";

const TERMINAL_DENIAL_CODES = new Set<number>([
  WS_CLOSE.AUTH_FAILED.code,
  WS_CLOSE.PERMISSION_DENIED.code,
]);

class RoomScopedHocuspocusWebsocket extends HocuspocusProviderWebsocket {
  private permanentlyDestroyed = false;

  private reconnectGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  override async connect() {
    if (this.permanentlyDestroyed || this.status === WebSocketStatus.Connected) return;
    this.reconnectGeneration += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    // Settle the superseded attempt before replacing its shared resolve/reject
    // slot. super.connect cancels that retryer's next attempt synchronously.
    this.rejectConnectionAttempt();
    return super.connect();
  }

  override async onOpen(event: Event) {
    // 4.3 clears cancellation on native open, before the first frame settles
    // the attempt. Keep it until resolution so retry-now can fence that loop.
    const cancel = this.cancelWebsocketRetry;
    void super.onOpen(event);
    this.cancelWebsocketRetry = cancel;
  }

  override resolveConnectionAttempt(): void {
    super.resolveConnectionAttempt();
    this.cancelWebsocketRetry = undefined;
  }

  override onClose(parameters: onCloseParameters): void {
    const shouldConnect = this.shouldConnect;
    // Retain library cleanup/status/queue semantics, but own its otherwise
    // untracked delayed-close timer. The abortable retry still owns failures
    // before the first frame, with its cancellation handle retained above.
    this.shouldConnect = false;
    super.onClose(parameters);
    this.shouldConnect = shouldConnect && !this.permanentlyDestroyed;
    if (!this.shouldConnect || this.cancelWebsocketRetry) return;
    const generation = this.reconnectGeneration;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (generation !== this.reconnectGeneration || !this.shouldConnect) return;
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.configuration.delay);
  }

  suspectOffline(): void {
    if (this.permanentlyDestroyed || this.status !== WebSocketStatus.Connected) return;
    // Drive normal cleanup now: native close handshakes can stall offline.
    this.emit("close", {
      event: new CloseEvent("close", { code: 1000, reason: "browser_offline" }),
    });
  }

  override destroy(): void {
    this.permanentlyDestroyed = true;
    this.reconnectGeneration += 1;
    clearTimeout(this.reconnectTimer);
    this.cancelWebsocketRetry?.();
    super.destroy();
  }
}

// Keep the build-time gate local so production removes the tap adapter while
// the authenticated composition root owns dev-time installation.
const DocumentWebSocket =
  import.meta.env.DEV || import.meta.env.VITE_DEBUG_OVERLAY === "1" ? TappedWebSocket : WebSocket;

export class CollabSchemaWebSocket extends DocumentWebSocket {
  constructor(url: string | URL) {
    super(url, [formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION)]);
  }
}

function mapStatus(status: WebSocketStatus): DocumentSessionConnectionState {
  if (status === WebSocketStatus.Connected) return { kind: "connected" };
  if (status === WebSocketStatus.Connecting) return { kind: "connecting", attempt: 1 };
  return { kind: "disconnected" };
}

function isTerminalDenialClose(event: onCloseParameters["event"]): boolean {
  return TERMINAL_DENIAL_CODES.has(event.code);
}

function terminalState(reason: string, code?: number): DocumentSessionConnectionState {
  return { kind: "unauthorized", reason, code };
}

function resetState(
  reason: DocumentSessionResetReason,
  code?: number,
): DocumentSessionConnectionState {
  return { kind: "reset", reason, code };
}

function branchResetReason(reason: string): DocumentSessionResetReason | null {
  if (reason === "branch-generation-stale") return "branch-generation-stale";
  if (reason === WS_CLOSE.BRANCH_STALE.reason) return WS_CLOSE.BRANCH_STALE.reason;
  return null;
}

export function classifyDocumentTransportClose(
  roomName: string,
  event: { code: number; reason: string },
): DocumentSessionConnectionState | null {
  if (isTerminalDenialClose(event)) return terminalState(event.reason, event.code);
  if (event.code === WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.code) {
    return resetState(WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason, event.code);
  }
  if (event.code === WS_CLOSE.DOCUMENT_SCHEMA_STALE.code) {
    return resetState(WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason, event.code);
  }
  const branchReason = branchResetReason(event.reason);
  if (roomName.startsWith("branch:") && branchReason) {
    return resetState(branchReason, event.code);
  }
  return null;
}

export type HocuspocusDocumentTransportOptions = {
  roomName: string;
  document: Y.Doc;
  awareness: Awareness;
  connectivityHints?: ConnectivityHintsPort;
};

/** Initial SyncStep2 plus a later zero-count SyncStatus acknowledgement. */
export function createDurableSyncBarrier(): {
  promise: Promise<void>;
  markInitialSyncComplete: (unsyncedChanges: number) => void;
  noteUnsyncedChanges: (unsyncedChanges: number) => void;
} {
  let initialSyncComplete = false;
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  const settleIfReady = (unsyncedChanges: number) => {
    if (initialSyncComplete && unsyncedChanges === 0) resolve();
  };
  return {
    promise,
    markInitialSyncComplete(unsyncedChanges) {
      initialSyncComplete = true;
      settleIfReady(unsyncedChanges);
    },
    noteUnsyncedChanges: settleIfReady,
  };
}

export function createHocuspocusDocumentTransport({
  roomName,
  document,
  awareness,
  connectivityHints,
}: HocuspocusDocumentTransportOptions): DocumentSessionTransportProvider {
  const listeners = new Set<(state: DocumentSessionConnectionState) => void>();
  const changeEventListeners = new Set<(message: ChangeEventWsMessage) => void>();
  const websocket = new RoomScopedHocuspocusWebsocket({
    url: buildSameOriginWsUrl(yjsWsPath()),
    WebSocketPolyfill: CollabSchemaWebSocket,
    autoConnect: false,
  });
  let currentState = mapStatus(websocket.status);
  let terminal = false;
  let destroyed = false;
  let resolveSynced!: () => void;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  const durableSync = createDurableSyncBarrier();

  const source = {};
  let stopHints = () => {};

  function publish(state: DocumentSessionConnectionState): void {
    if (state.kind === "connected") connectivityHints?.reportConnected(source);
    else connectivityHints?.reportDisconnected(source);
    currentState = state;
    for (const listener of listeners) listener(state);
  }

  function publishTerminal(state: DocumentSessionConnectionState): void {
    if (terminal) return;
    terminal = true;
    stopHints();
    publish(state);
    provider.destroy();
    websocket.destroy();
  }

  function handleStatus({ status }: onStatusParameters): void {
    if (terminal || destroyed) return;
    publish(mapStatus(status));
  }

  function handleSynced(_event: onSyncedParameters): void {
    if (terminal || destroyed) return;
    resolveSynced();
    durableSync.markInitialSyncComplete(provider.unsyncedChanges);
    publish({ kind: "connected" });
  }

  function handleUnsyncedChanges({ number }: onUnsyncedChangesParameters): void {
    if (terminal || destroyed) return;
    durableSync.noteUnsyncedChanges(number);
  }

  function handleAuthenticationFailed({ reason }: onAuthenticationFailedParameters): void {
    if (destroyed) return;
    publishTerminal(terminalState(reason));
  }

  function handleClose({ event }: onCloseParameters): void {
    if (terminal || destroyed) return;
    const state = classifyDocumentTransportClose(roomName, event);
    if (state) publishTerminal(state);
  }

  function handleStateless({ payload }: onStatelessParameters): void {
    const message = parseYjsStatelessMessage(payload);
    if (message?.type !== "change_event") return;
    for (const listener of changeEventListeners) listener(message);
  }

  const provider = new HocuspocusProvider({
    name: roomName,
    document,
    awareness,
    websocketProvider: websocket,
    onStatus: handleStatus,
    onSynced: handleSynced,
    onUnsyncedChanges: handleUnsyncedChanges,
    onAuthenticationFailed: handleAuthenticationFailed,
    onClose: handleClose,
    onStateless: handleStateless,
  });
  if (import.meta.env.DEV || import.meta.env.VITE_DEBUG_OVERLAY === "1") {
    notifyYjsRoomAttached(roomName, document.clientID);
  }

  stopHints =
    connectivityHints?.subscribe(source, (hint) => {
      if (terminal || destroyed) return;
      if (hint === "suspect-offline") {
        // Do not use disconnect(): it disables Hocuspocus's normal retry loop.
        websocket.suspectOffline();
      } else if (websocket.status !== WebSocketStatus.Connected) {
        // The room adapter fences both the delayed-close and abortable retries.
        void websocket.connect();
      }
    }) ?? (() => {});

  // External websocketProvider: Hocuspocus v4.2.0 only auto-attaches when it owns the socket.
  provider.attach();
  void websocket.connect();

  if (provider.synced) {
    resolveSynced();
    durableSync.markInitialSyncComplete(provider.unsyncedChanges);
  }

  return {
    get synced() {
      return provider.synced;
    },
    whenSynced,
    whenDurablySynced: durableSync.promise,
    subscribeStatus(listener) {
      listeners.add(listener);
      listener(currentState);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeChangeEvents(listener) {
      changeEventListeners.add(listener);
      return () => changeEventListeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopHints();
      provider.destroy();
      websocket.destroy();
      listeners.clear();
      changeEventListeners.clear();
    },
  };
}

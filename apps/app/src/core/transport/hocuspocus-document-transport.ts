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

import { buildSameOriginWsUrl } from "./dev-transport";
import { notifyYjsRoomAttached, TappedWebSocket } from "./tapped-websocket";

const TERMINAL_DENIAL_CODES = new Set<number>([
  WS_CLOSE.AUTH_FAILED.code,
  WS_CLOSE.PERMISSION_DENIED.code,
]);

class RoomScopedHocuspocusWebsocket extends HocuspocusProviderWebsocket {
  private permanentlyDestroyed = false;

  // Hocuspocus 4.3 schedules an untracked reconnect from its close handler.
  // Guard connect itself so a terminal room cannot resurrect after destroy().
  override async connect() {
    if (this.permanentlyDestroyed) return;
    return super.connect();
  }

  override destroy(): void {
    this.permanentlyDestroyed = true;
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
}: HocuspocusDocumentTransportOptions): DocumentSessionTransportProvider {
  const listeners = new Set<(state: DocumentSessionConnectionState) => void>();
  const changeEventListeners = new Set<(message: ChangeEventWsMessage) => void>();
  const websocket = new RoomScopedHocuspocusWebsocket({
    url: buildSameOriginWsUrl(yjsWsPath()),
    WebSocketPolyfill: CollabSchemaWebSocket,
  });
  let currentState = mapStatus(websocket.status);
  let terminal = false;
  let destroyed = false;
  let resolveSynced!: () => void;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  const durableSync = createDurableSyncBarrier();

  function publish(state: DocumentSessionConnectionState): void {
    currentState = state;
    for (const listener of listeners) listener(state);
  }

  function publishTerminal(state: DocumentSessionConnectionState): void {
    if (terminal) return;
    terminal = true;
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

  // External websocketProvider: Hocuspocus v4.2.0 only auto-attaches when it owns the socket.
  provider.attach();

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
      provider.destroy();
      websocket.destroy();
      listeners.clear();
      changeEventListeners.clear();
    },
  };
}

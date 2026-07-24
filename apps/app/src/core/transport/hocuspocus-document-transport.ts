/**
 * hocuspocus-document-transport — binds HocuspocusProvider to DocumentSession.
 *
 * DocumentSession remains the owner of the Y.Doc, Awareness, and IndexedDB
 * cache. This adapter only attaches Hocuspocus' document provider to those
 * existing objects and maps provider/socket events back to the unchanged
 * DocumentSessionTransportProvider seam.
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
  yjsWsPath,
} from "@meridian/contracts/protocol";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { DocumentSessionTransportProvider } from "@/core/editor/document-session";

import { buildSameOriginWsUrl } from "./dev-transport";
import type { ConnectionState } from "./ThreadTransport";
import { notifyYjsRoomAttached, TappedWebSocket } from "./tapped-websocket";

const TERMINAL_DENIAL_CODES = new Set([4401, 4403]);
const HOCUSPOCUS_BRANCH_RESET_REASONS = new Set(["branch-generation-stale", "branch-stale-doc"]);

let sharedWebsocket: HocuspocusProviderWebsocket | null = null;

function getSharedWebsocket(): HocuspocusProviderWebsocket {
  sharedWebsocket ??= new HocuspocusProviderWebsocket({
    url: buildSameOriginWsUrl(yjsWsPath()),
    // Keep the build-time gate local so production removes the tap adapter,
    // while the authenticated composition root owns dev-time installation.
    ...(import.meta.env.DEV || import.meta.env.VITE_DEBUG_OVERLAY === "1"
      ? { WebSocketPolyfill: TappedWebSocket }
      : {}),
  });
  return sharedWebsocket;
}

function mapStatus(status: WebSocketStatus): ConnectionState {
  if (status === WebSocketStatus.Connected) return { kind: "connected" };
  if (status === WebSocketStatus.Connecting) return { kind: "connecting", attempt: 1 };
  return { kind: "disconnected" };
}

function isTerminalDenialClose(event: onCloseParameters["event"]): boolean {
  return TERMINAL_DENIAL_CODES.has(event.code);
}

function terminalState(reason: string, code?: number): ConnectionState {
  return { kind: "unauthorized", reason, code };
}

function resetState(reason: string, code?: number): ConnectionState {
  return { kind: "reset", reason, code };
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
  const listeners = new Set<(state: ConnectionState) => void>();
  const changeEventListeners = new Set<(message: ChangeEventWsMessage) => void>();
  let currentState = mapStatus(getSharedWebsocket().status);
  let terminal = false;
  let destroyed = false;
  let resolveSynced!: () => void;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  const durableSync = createDurableSyncBarrier();

  function publish(state: ConnectionState): void {
    currentState = state;
    for (const listener of listeners) listener(state);
  }

  function publishTerminal(state: ConnectionState): void {
    if (terminal) return;
    terminal = true;
    publish(state);
    provider.destroy();
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
    if (isTerminalDenialClose(event)) {
      publishTerminal(terminalState(event.reason, event.code));
      return;
    }
    if (roomName.startsWith("branch:") && HOCUSPOCUS_BRANCH_RESET_REASONS.has(event.reason)) {
      publishTerminal(resetState(event.reason, event.code));
    }
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
    websocketProvider: getSharedWebsocket(),
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
    awareness,
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
      listeners.clear();
      changeEventListeners.clear();
    },
  };
}

/**
 * hocuspocus-document-transport — binds HocuspocusProvider to DocumentSession.
 *
 * DocumentSession remains the owner of the Y.Doc, Awareness, and IndexedDB
 * cache. This adapter owns one socket per document because WebSocket closes
 * are connection-wide, while schema refusals are room-specific. It maps those
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
import { type SafetyNoticeWsMessage, YJS_WS_CLOSE, yjsWsPath } from "@meridian/contracts/protocol";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import type { DocumentSessionTransportProvider } from "@/core/editor/document-session";

import { buildSameOriginWsUrl } from "./dev-transport";
import type { ConnectionState } from "./ThreadTransport";

const TERMINAL_DENIAL_CODES = new Set([4401, 4403]);
const SCHEMA_REFUSAL_CODES: ReadonlySet<number> = new Set([
  YJS_WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.code,
  YJS_WS_CLOSE.DOCUMENT_SCHEMA_STALE.code,
]);
const HOCUSPOCUS_BRANCH_RESET_REASONS = new Set(["branch-generation-stale", "branch-stale-doc"]);

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

export function schemaVersionedYjsWsPath(): string {
  return `${yjsWsPath()}?schema=${COLLAB_SCHEMA_VERSION}`;
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

export function classifyDocumentTransportClose(
  roomName: string,
  event: { code: number; reason: string },
): ConnectionState | null {
  if (isTerminalDenialClose(event)) return terminalState(event.reason, event.code);
  if (SCHEMA_REFUSAL_CODES.has(event.code)) return resetState(event.reason, event.code);
  if (roomName.startsWith("branch:") && HOCUSPOCUS_BRANCH_RESET_REASONS.has(event.reason)) {
    return resetState(event.reason, event.code);
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
  const listeners = new Set<(state: ConnectionState) => void>();
  const safetyNoticeListeners = new Set<(notice: SafetyNoticeWsMessage) => void>();
  const websocket = new RoomScopedHocuspocusWebsocket({
    url: buildSameOriginWsUrl(schemaVersionedYjsWsPath()),
  });
  let currentState = mapStatus(websocket.status);
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
    const notice = parseSafetyNotice(payload);
    if (!notice) return;
    for (const listener of safetyNoticeListeners) listener(notice);
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
    subscribeSafetyNotices(listener) {
      safetyNoticeListeners.add(listener);
      return () => safetyNoticeListeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      provider.destroy();
      websocket.destroy();
      listeners.clear();
      safetyNoticeListeners.clear();
    },
  };
}

export function parseSafetyNotice(payload: string): SafetyNoticeWsMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "safety_notice" ||
    typeof candidate.documentId !== "string" ||
    typeof candidate.kind !== "string" ||
    typeof candidate.message !== "string" ||
    !candidate.data ||
    typeof candidate.data !== "object" ||
    Array.isArray(candidate.data)
  ) {
    return null;
  }
  return candidate as unknown as SafetyNoticeWsMessage;
}

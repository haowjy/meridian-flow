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
import { type SafetyNoticeWsMessage, yjsWsPath } from "@meridian/contracts/protocol";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import type { DocumentSessionTransportProvider } from "@/core/editor/document-session";

import { buildSameOriginWsUrl } from "./dev-transport";
import type { ConnectionState } from "./ThreadTransport";

const TERMINAL_DENIAL_CODES = new Set([4401, 4403]);
const HOCUSPOCUS_BRANCH_RESET_REASONS = new Set(["branch-generation-stale", "branch-stale-doc"]);

let sharedWebsocket: HocuspocusProviderWebsocket | null = null;

function getSharedWebsocket(): HocuspocusProviderWebsocket {
  sharedWebsocket ??= new HocuspocusProviderWebsocket({
    url: buildSameOriginWsUrl(yjsWsPath()),
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

export function createHocuspocusDocumentTransport({
  roomName,
  document,
  awareness,
}: HocuspocusDocumentTransportOptions): DocumentSessionTransportProvider {
  const listeners = new Set<(state: ConnectionState) => void>();
  const safetyNoticeListeners = new Set<(notice: SafetyNoticeWsMessage) => void>();
  let currentState = mapStatus(getSharedWebsocket().status);
  let terminal = false;
  let destroyed = false;
  let resolveSynced!: () => void;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  let initialSyncComplete = false;
  let resolveDurablySynced!: () => void;
  const whenDurablySynced = new Promise<void>((resolve) => {
    resolveDurablySynced = resolve;
  });

  function resolveDurableBarrierIfReady(unsyncedChanges: number): void {
    if (initialSyncComplete && unsyncedChanges === 0) resolveDurablySynced();
  }

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
    initialSyncComplete = true;
    resolveSynced();
    resolveDurableBarrierIfReady(provider.unsyncedChanges);
    publish({ kind: "connected" });
  }

  function handleUnsyncedChanges({ number }: onUnsyncedChangesParameters): void {
    if (terminal || destroyed) return;
    resolveDurableBarrierIfReady(number);
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
    const notice = parseSafetyNotice(payload);
    if (!notice) return;
    for (const listener of safetyNoticeListeners) listener(notice);
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

  // External websocketProvider: Hocuspocus v4.2.0 only auto-attaches when it owns the socket.
  provider.attach();

  if (provider.synced) {
    initialSyncComplete = true;
    resolveSynced();
    resolveDurableBarrierIfReady(provider.unsyncedChanges);
  }

  return {
    awareness,
    get synced() {
      return provider.synced;
    },
    whenSynced,
    whenDurablySynced,
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

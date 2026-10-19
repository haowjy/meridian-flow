/**
 * hocuspocus-document-transport — binds HocuspocusProvider to DocumentSession.
 *
 * DocumentSession remains the owner of the Y.Doc, Awareness, and IndexedDB
 * cache. This adapter owns one socket per room because WebSocket closes are
 * connection-wide, while schema refusals are room-specific. It maps those
 * provider/socket events back to the unchanged DocumentSessionTransportProvider
 * seam.
 *
 * It also reports whether the server has acknowledged every local change
 * (`server-acknowledgement.ts`). That is read off the socket's own send and
 * receive path rather than provider events: the provider emits its outgoing
 * message before the socket decides to queue it, and queued messages can be
 * dropped, so only the socket knows what actually reached the wire.
 *
 * The transport also owns the room's access scope. The server names it on every
 * (re)connect through Hocuspocus's authenticated message; a 4409
 * `access-changed` close freezes the room until the reconnect names the new
 * scope. Local edits still unacknowledged at that close were refused, and a
 * reconnect would replay them from this Y.Doc, so the transport resets instead
 * and the owner rebuilds the room from the server's state.
 *
 * A draft room's update refusal (`1008`) is bounded. One refusal reconnects
 * and resends, as any close does; after `MAX_DRAFT_UPDATE_REFUSALS` in a row
 * with no acknowledgement between them, the room ends `DRAFT_UPDATES_REFUSED`
 * and keeps its outbox for the owner to show. Live rooms never count. A
 * `4207 draft-prefix-missing` close is not a refusal: the server received an
 * update before the bytes it depends on, and the reconnect's handshake repairs
 * that, so it reconnects like any drop and never counts.
 *
 * A draft room's handshake upload goes first. The client's SyncStep2 is the
 * whole Y.Doc diffed against the server's state vector, so it carries every
 * byte the server lacks, including edits replayed before this transport
 * existed. Updates offered on an open socket before its SyncStep2 (the offline
 * queue's flush, keys typed during the handshake) would reach the server ahead
 * of the bytes they depend on; the socket holds them and releases them, in
 * order, right after the SyncStep2. Only transmission waits, never typing.
 * Live rooms keep the provider's order: their server marks the SyncStep2 for
 * offline collision reconciliation, and moving queued bytes into it would
 * change what is reconciled.
 */
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  type onAuthenticatedParameters,
  type onAuthenticationFailedParameters,
  type onCloseParameters,
  type onStatelessParameters,
  type onStatusParameters,
  type onSyncedParameters,
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
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  type DocumentSessionAccess,
  type DocumentSessionConnectionState,
  type DocumentSessionResetReason,
  type DocumentSessionTransportProvider,
  DRAFT_UPDATES_REFUSED,
  type ResetDisposition,
} from "@/core/editor/document-session";

import type { ConnectivityHintsPort } from "./connectivity-hints";
import { buildSameOriginWsUrl } from "./dev-transport";
import {
  createServerAcknowledgementTracker,
  readDocumentSyncType,
  type ServerAcknowledgementTracker,
} from "./server-acknowledgement";
import { notifyYjsRoomAttached, TappedWebSocket } from "./tapped-websocket";

const TERMINAL_DENIAL_CODES = new Set<number>([
  WS_CLOSE.AUTH_FAILED.code,
  WS_CLOSE.PERMISSION_DENIED.code,
]);

// WebSocket.OPEN; the provider's own queue-or-send decision uses the same test.
const SOCKET_OPEN = 1;

// The server's close for a draft frame it would not admit (policy violation).
const DRAFT_UPDATE_REFUSED_CODE = 1008;
const MAX_DRAFT_UPDATE_REFUSALS = 3;

function isDraftRoom(roomName: string): boolean {
  return roomName.startsWith("draft:");
}

class RoomScopedHocuspocusWebsocket extends HocuspocusProviderWebsocket {
  private permanentlyDestroyed = false;
  private reconnectGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly acknowledgement: ServerAcknowledgementTracker;
  private readonly handshakeUploadFirst: boolean;
  // Per socket: whether its SyncStep2 has been written, and the Updates held until then.
  private handshakeUploaded = false;
  private heldUpdates: Uint8Array[] = [];

  constructor(
    configuration: ConstructorParameters<typeof HocuspocusProviderWebsocket>[0],
    acknowledgement: ServerAcknowledgementTracker,
    handshakeUploadFirst: boolean,
  ) {
    super(configuration);
    this.acknowledgement = acknowledgement;
    this.handshakeUploadFirst = handshakeUploadFirst;
  }

  // The provider emits "open" only after this listener (registered in the base
  // constructor), so counting starts before the handshake's first frame.
  // 4.3 also clears retry cancellation on native open, before the first frame
  // settles the attempt. Keep it until resolution so retry-now can fence that loop.
  override async onOpen(event: Event) {
    this.dropHeldUpdates();
    this.acknowledgement.beginConnection();
    const cancel = this.cancelWebsocketRetry;
    void super.onOpen(event);
    this.cancelWebsocketRetry = cancel;
  }

  // Every document frame passes here, whether the provider sent it directly,
  // flushed it from the offline queue, or replied to a server SyncStep1.
  // Counted before the write so a synchronous reply cannot overtake it. A frame
  // the base class will queue (socket not open) invalidates instead. A held
  // Update is counted only when it is released and written.
  override send(message: unknown) {
    if (message instanceof Uint8Array) {
      const open = this.webSocket?.readyState === SOCKET_OPEN;
      if (open && this.handshakeUploadFirst && !this.handshakeUploaded) {
        const syncType = readDocumentSyncType(message);
        if (syncType === messageYjsUpdate) {
          this.heldUpdates.push(message);
          return;
        }
        if (syncType === messageYjsSyncStep2) {
          this.acknowledgement.noteFrameSent(message);
          super.send(message);
          this.handshakeUploaded = true;
          const released = this.heldUpdates;
          this.heldUpdates = [];
          for (const update of released) this.send(update);
          return;
        }
      }
      if (open) this.acknowledgement.noteFrameSent(message);
      else this.acknowledgement.noteFrameQueued(message);
    }
    super.send(message);
  }

  // A socket that closes before its SyncStep2 never writes what it held; the
  // next socket's SyncStep2 carries those bytes.
  private dropHeldUpdates(): void {
    this.handshakeUploaded = false;
    this.heldUpdates = [];
  }

  override onMessage(event: MessageEvent) {
    try {
      super.onMessage(event);
    } finally {
      // Same read the base class makes: frames arrive as ArrayBuffer.
      this.acknowledgement.noteFrameReceived(new Uint8Array(event.data));
    }
  }

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

  override resolveConnectionAttempt(): void {
    super.resolveConnectionAttempt();
    this.cancelWebsocketRetry = undefined;
  }

  override onClose(parameters: onCloseParameters): void {
    this.dropHeldUpdates();
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

const RESET_DISPOSITIONS: Readonly<Record<DocumentSessionResetReason, ResetDisposition>> = {
  [WS_CLOSE.DRAFT_GENERATION_STALE.reason]: "superseded",
  [WS_CLOSE.DRAFT_STALE.reason]: "closed",
  [WS_CLOSE.ACCESS_CHANGED.reason]: "refused",
  [WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason]: "schema",
  [WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason]: "schema",
  [WS_CLOSE.DOCUMENT_DELETED.reason]: "removed",
};

export function classifyDocumentTransportClose(
  roomName: string,
  event: { code?: number; reason: string },
  hasUnacknowledgedEdits = false,
): DocumentSessionConnectionState | null {
  const reason = event.reason as DocumentSessionResetReason;
  const disposition = Object.hasOwn(RESET_DISPOSITIONS, reason) ? RESET_DISPOSITIONS[reason] : null;
  if (disposition) {
    if ((disposition === "superseded" || disposition === "closed") && !isDraftRoom(roomName))
      return null;
    if (disposition === "refused" && !hasUnacknowledgedEdits) return null;
    return { kind: "reset", reason, disposition, code: event.code };
  }
  if (event.code !== undefined && isTerminalDenialClose({ code: event.code, reason: event.reason }))
    return terminalState(event.reason, event.code);
  return null;
}

export type HocuspocusDocumentTransportOptions = {
  roomName: string;
  document: Y.Doc;
  awareness: Awareness;
  connectivityHints?: ConnectivityHintsPort;
};

export function createHocuspocusDocumentTransport({
  roomName,
  document,
  awareness,
  connectivityHints,
}: HocuspocusDocumentTransportOptions): DocumentSessionTransportProvider {
  const listeners = new Set<(state: DocumentSessionConnectionState) => void>();
  const accessListeners = new Set<(access: DocumentSessionAccess) => void>();
  const changeEventListeners = new Set<(message: ChangeEventWsMessage) => void>();
  const acknowledgementListeners = new Set<(acknowledged: boolean) => void>();
  const acknowledgement = createServerAcknowledgementTracker((acknowledged) => {
    if (acknowledged && !terminal) {
      outbox = null;
      refusals = 0;
    }
    for (const listener of acknowledgementListeners) listener(acknowledged);
  });
  const websocket = new RoomScopedHocuspocusWebsocket(
    {
      url: buildSameOriginWsUrl(yjsWsPath()),
      WebSocketPolyfill: CollabSchemaWebSocket,
      autoConnect: false,
    },
    acknowledgement,
    isDraftRoom(roomName),
  );
  let currentState = mapStatus(websocket.status);
  // Only the server names a scope; until it does, the session keeps its own.
  let currentAccess: DocumentSessionAccess | null = null;
  let outbox: Uint8Array | null = null;
  let refusals = 0;
  let terminal = false;
  let destroyed = false;
  let resolveSynced!: () => void;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });

  const source = {};
  let stopHints = () => {};

  function publish(state: DocumentSessionConnectionState): void {
    if (state.kind === "connected") connectivityHints?.reportConnected(source);
    else connectivityHints?.reportDisconnected(source);
    currentState = state;
    for (const listener of listeners) listener(state);
  }

  function publishAccess(access: DocumentSessionAccess): void {
    if (access === currentAccess) return;
    currentAccess = access;
    for (const listener of accessListeners) listener(access);
  }

  function publishTerminal(state: DocumentSessionConnectionState): void {
    if (terminal) return;
    terminal = true;
    document.off("update", handleDocumentUpdate);
    stopHints();
    acknowledgement.endConnection();
    publish(state);
    provider.destroy();
    websocket.destroy();
  }

  function handleStatus({ status }: onStatusParameters): void {
    if (terminal || destroyed) return;
    // Cleared before the status goes out so no subscriber sees "offline" with a
    // stale "saved". The tracker restarts on the next socket open.
    if (status !== WebSocketStatus.Connected) acknowledgement.endConnection();
    publish(mapStatus(status));
  }

  function handleSynced(_event: onSyncedParameters): void {
    if (terminal || destroyed) return;
    resolveSynced();
    publish({ kind: "connected" });
  }

  let observedClientID = document.clientID;
  function handleDocumentUpdate(update: Uint8Array, origin: unknown): void {
    if (observedClientID !== document.clientID) {
      observedClientID = document.clientID;
      if (import.meta.env.DEV || import.meta.env.VITE_DEBUG_OVERLAY === "1") {
        notifyYjsRoomAttached(roomName, observedClientID);
      }
    }
    if (origin !== provider) {
      const wasEmpty = outbox === null;
      outbox = outbox ? Y.mergeUpdates([outbox, update]) : update.slice();
      if (wasEmpty) for (const listener of acknowledgementListeners) listener(false);
    }
  }

  function handleAuthenticated({ scope }: onAuthenticatedParameters): void {
    if (terminal || destroyed) return;
    publishAccess(scope === "readonly" ? "read" : "edit");
  }

  function handleAuthenticationFailed({ reason }: onAuthenticationFailedParameters): void {
    if (destroyed) return;
    publishTerminal(classifyDocumentTransportClose(roomName, { reason }) ?? terminalState(reason));
  }

  function handleClose({ event }: onCloseParameters): void {
    if (terminal || destroyed) return;
    if (
      event.reason === WS_CLOSE.ACCESS_CHANGED.reason ||
      event.reason === WS_CLOSE.DOCUMENT_DELETED.reason
    ) {
      // Frozen until the reconnect's authenticated message names the new scope;
      // a removed document has no reconnect, so it stays read-only.
      publishAccess("read");
    }
    const state = classifyDocumentTransportClose(roomName, event, outbox !== null);
    if (state) {
      publishTerminal(state);
      return;
    }
    // Only a genuine refusal counts; 4207 draft-prefix-missing is a plain reconnect.
    if (
      event.code === DRAFT_UPDATE_REFUSED_CODE &&
      isDraftRoom(roomName) &&
      outbox !== null &&
      ++refusals >= MAX_DRAFT_UPDATE_REFUSALS
    )
      publishTerminal({ kind: "terminal", reason: DRAFT_UPDATES_REFUSED, code: event.code });
  }

  function handleStateless({ payload }: onStatelessParameters): void {
    const message = parseYjsStatelessMessage(payload);
    if (message?.type !== "change_event") return;
    for (const listener of changeEventListeners) listener(message);
  }

  // Store local bytes before the provider's listener sends and publishes its
  // acknowledgement edge. Session observers must see one complete pending edge.
  document.on("update", handleDocumentUpdate);
  const provider = new HocuspocusProvider({
    name: roomName,
    document,
    awareness,
    websocketProvider: websocket,
    onStatus: handleStatus,
    onSynced: handleSynced,
    onAuthenticated: handleAuthenticated,
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

  if (provider.synced) resolveSynced();

  return {
    whenCurrentChangesAcknowledged: () => acknowledgement.whenCurrentChangesAcknowledged(),
    unacknowledgedUpdates: () => outbox,
    get synced() {
      return provider.synced;
    },
    whenSynced,
    subscribeServerAcknowledgement(listener) {
      acknowledgementListeners.add(listener);
      listener(acknowledgement.acknowledged);
      return () => {
        acknowledgementListeners.delete(listener);
      };
    },
    subscribeStatus(listener) {
      listeners.add(listener);
      listener(currentState);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeAccess(listener) {
      accessListeners.add(listener);
      if (currentAccess) listener(currentAccess);
      return () => {
        accessListeners.delete(listener);
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
      document.off("update", handleDocumentUpdate);
      acknowledgement.endConnection();
      provider.destroy();
      websocket.destroy();
      listeners.clear();
      accessListeners.clear();
      acknowledgementListeners.clear();
      changeEventListeners.clear();
    },
  };
}

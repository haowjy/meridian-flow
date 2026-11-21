/**
 * hocuspocus-document-transport — binds HocuspocusProvider to DocumentSession.
 *
 * DocumentSession remains the owner of the Y.Doc, Awareness, and IndexedDB
 * cache. The patched provider (`patches/@hocuspocus__provider@4.8.0.patch`)
 * destroys only an Awareness it created, so `provider.destroy()` here removes
 * its listeners and leaves presence to the session. This adapter owns one
 * socket per room because WebSocket closes are connection-wide, while schema
 * refusals are room-specific. It maps those
 * provider/socket events back to the unchanged DocumentSessionTransportProvider
 * seam.
 *
 * It also reports whether the server has acknowledged every local change
 * (`server-acknowledgement.ts`), and what the server holds (`server-has.ts`): after each server
 * frame an editable room sends what the document holds beyond that, which a local peer's pending
 * items released in the provider's transaction would otherwise never upload. That is read off the socket's own send and
 * receive path rather than provider events: the provider emits its outgoing
 * message before the socket decides to queue it, and queued messages can be
 * dropped, so only the socket knows what actually reached the wire.
 *
 * The transport also owns the room's access scope. The server names it on every
 * (re)connect through Hocuspocus's authenticated message; a 4409
 * `access-changed` close freezes the room until the reconnect names the new
 * scope. It never resets the room: unacknowledged local edits stay in this
 * Y.Doc, and the reconnect's admission decides. An edit admission's handshake
 * delivers them. A read-only one never gets an Update frame (the socket drops
 * it), and each of its handshakes says what the document holds that the server
 * lacks (`handshake-difference.ts`); the session decides what to do with that.
 *
 * A frame the server could not store closes `1013` (`WS_CLOSE.WRITER_ADMISSION_FAILED`). One
 * reconnects and resends, as any close does; after `MAX_UPDATE_REFUSALS` in a row with
 * no acknowledgement between them, the room ends `UPDATES_REFUSED` instead of
 * resending forever, and the session's owner replaces it (`DocumentSession.holdsUndeliverableEdits`).
 *
 * The handshake upload goes first. The client's SyncStep2 is the
 * whole Y.Doc diffed against the server's state vector, so it carries every
 * byte the server lacks, including edits replayed before this transport
 * existed and frames lost with the previous socket (a server restart). Updates
 * offered on an open socket before its SyncStep2 (the offline queue's flush,
 * keys typed during the handshake) would reach the server ahead of the bytes
 * they depend on, and the server refuses a frame that starts past its room's
 * clock; the socket holds them and releases them, in order, right after the
 * SyncStep2. Only transmission waits, never typing.
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
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import {
  accessChangedWhy,
  type ChangeEventWsMessage,
  isAccessChangedClose,
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
  type HandshakeDifference,
  type ResetDisposition,
  UPDATES_REFUSED,
} from "@/core/editor/document-session";

import type { ConnectivityHintsPort } from "./connectivity-hints";
import { buildSameOriginWsUrl } from "./dev-transport";
import {
  createHandshakeDifferenceReader,
  type HandshakeDifferenceReader,
  readServerStateVector,
} from "./handshake-difference";
import {
  createServerAcknowledgementTracker,
  readDocumentSyncType,
  type ServerAcknowledgementTracker,
} from "./server-acknowledgement";
import { createServerHasTracker, type ServerHasTracker } from "./server-has";
import { notifyYjsRoomAttached, TappedWebSocket } from "./tapped-websocket";

const TERMINAL_DENIAL_CODES = new Set<number>([
  WS_CLOSE.AUTH_FAILED.code,
  WS_CLOSE.PERMISSION_DENIED.code,
]);

// WebSocket.OPEN; the provider's own queue-or-send decision uses the same test.
const SOCKET_OPEN = 1;

const MAX_UPDATE_REFUSALS = 3;

class RoomScopedHocuspocusWebsocket extends HocuspocusProviderWebsocket {
  private permanentlyDestroyed = false;
  private reconnectGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly acknowledgement: ServerAcknowledgementTracker;
  private readonly difference: HandshakeDifferenceReader;
  private readonly serverHas: ServerHasTracker;
  private readonly onServerFrame: (frame: Uint8Array) => void;
  // Per socket: whether its SyncStep2 has been written, and the Updates held until then.
  private handshakeUploaded = false;
  private heldUpdates: Uint8Array[] = [];

  constructor(
    configuration: ConstructorParameters<typeof HocuspocusProviderWebsocket>[0],
    acknowledgement: ServerAcknowledgementTracker,
    difference: HandshakeDifferenceReader,
    serverHas: ServerHasTracker,
    onServerFrame: (frame: Uint8Array) => void,
  ) {
    super(configuration);
    this.acknowledgement = acknowledgement;
    this.difference = difference;
    this.serverHas = serverHas;
    this.onServerFrame = onServerFrame;
  }

  // The provider emits "open" only after this listener (registered in the base
  // constructor), so counting starts before the handshake's first frame.
  // 4.3 also clears retry cancellation on native open, before the first frame
  // settles the attempt. Keep it until resolution so retry-now can fence that loop.
  override async onOpen(event: Event) {
    this.dropHeldUpdates();
    this.acknowledgement.beginConnection();
    this.difference.reset();
    this.serverHas.reset();
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
      // The server drops a read-admitted connection's updates and answers each `false`.
      if (this.acknowledgement.readOnly && readDocumentSyncType(message) === messageYjsUpdate)
        return;
      const open = this.webSocket?.readyState === SOCKET_OPEN;
      if (open && !this.handshakeUploaded) {
        const syncType = readDocumentSyncType(message);
        if (syncType === messageYjsUpdate) {
          this.heldUpdates.push(message);
          return;
        }
        if (syncType === messageYjsSyncStep2) {
          this.acknowledgement.noteFrameSent(message);
          this.serverHas.noteFrameSent(message);
          super.send(message);
          this.handshakeUploaded = true;
          const released = this.heldUpdates;
          this.heldUpdates = [];
          for (const update of released) this.send(update);
          return;
        }
      }
      if (open) {
        this.acknowledgement.noteFrameSent(message);
        this.serverHas.noteFrameSent(message);
      } else this.acknowledgement.noteFrameQueued(message);
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
    // Same read the base class makes: frames arrive as ArrayBuffer.
    const frame = new Uint8Array(event.data);
    const sync = this.serverHas.noteFrameReceived(frame);
    try {
      super.onMessage(event);
    } finally {
      // Before the acknowledgement: what the frame left unsent goes out first, so the server
      // acknowledging everything still means it holds the whole document.
      if (sync) this.onServerFrame(frame);
      this.acknowledgement.noteFrameReceived(frame);
      if (this.acknowledgement.readOnly) this.difference.noteFrameReceived(frame);
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
  [WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason]: "schema",
  [WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason]: "schema",
  [WS_CLOSE.DOCUMENT_DELETED.reason]: "removed",
};

export function classifyDocumentTransportClose(event: {
  code?: number;
  reason: string;
}): DocumentSessionConnectionState | null {
  const reason = event.reason as DocumentSessionResetReason;
  if (Object.hasOwn(RESET_DISPOSITIONS, reason))
    return { kind: "reset", reason, disposition: RESET_DISPOSITIONS[reason], code: event.code };
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
  const accessListeners = new Set<
    (
      access: DocumentSessionAccess,
      closedWhy: ClosedOwnerWhy | null,
      reasonPending: boolean,
    ) => void
  >();
  const changeEventListeners = new Set<(message: ChangeEventWsMessage) => void>();
  const acknowledgementListeners = new Set<(acknowledged: boolean) => void>();
  const differenceListeners = new Set<(difference: HandshakeDifference | null) => void>();
  const serverHasListeners = new Set<(vector: Uint8Array, handshake: boolean) => void>();
  const reportServerHas = (vector: Uint8Array, handshake: boolean) => {
    for (const listener of serverHasListeners) listener(vector, handshake);
  };
  const serverHas = createServerHasTracker();
  const acknowledgement = createServerAcknowledgementTracker((acknowledged) => {
    if (acknowledged && !terminal) {
      outbox = null;
      refusals = 0;
      // Everything written on this socket is applied.
      reportServerHas(serverHas.vector, false);
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
    createHandshakeDifferenceReader(document, (difference) => {
      for (const listener of differenceListeners) listener(difference);
    }),
    serverHas,
    handleServerFrame,
  );
  let currentState = mapStatus(websocket.status);
  // Only the server names a scope; until it does, the session keeps its own.
  let currentAccess: DocumentSessionAccess | null = null;
  // Why a read-only room is read-only, when its owner is closed: named by the admission's
  // message or the closing 4409, never inferred. It survives a reconnect until the next
  // admission's message replaces it, and `reasonPending` holds from a read admission until then.
  let currentClosedWhy: ClosedOwnerWhy | null = null;
  let reasonPending = false;
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

  function publishAccess(
    access: DocumentSessionAccess,
    closedWhy: ClosedOwnerWhy | null,
    pending = false,
  ): void {
    if (access === currentAccess && closedWhy === currentClosedWhy && pending === reasonPending)
      return;
    currentAccess = access;
    currentClosedWhy = closedWhy;
    reasonPending = pending;
    for (const listener of accessListeners) listener(access, closedWhy, pending);
  }

  function publishTerminal(state: DocumentSessionConnectionState): void {
    if (terminal) return;
    terminal = true;
    // No admission is coming to name a reason.
    if (currentAccess && reasonPending) publishAccess(currentAccess, currentClosedWhy);
    document.off("update", handleDocumentUpdate);
    stopHints();
    acknowledgement.terminate();
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
    if (origin !== provider) noteUnacknowledged(update);
  }

  function noteUnacknowledged(update: Uint8Array): void {
    const wasEmpty = outbox === null;
    outbox = outbox ? Y.mergeUpdates([outbox, update]) : update.slice();
    if (wasEmpty) for (const listener of acknowledgementListeners) listener(false);
  }

  // After the provider applied the frame and every transaction it opened (`server-has.ts`).
  function handleServerFrame(frame: Uint8Array): void {
    if (terminal || destroyed) return;
    const vector = readServerStateVector(frame);
    if (vector) reportServerHas(vector, true);
    // What the server sent, it holds: without this a mark stops at the handshake's vector until
    // this client's own typing is acknowledged, and the copy then offers the server's own words.
    else reportServerHas(serverHas.shown, false);
    // A read admission's socket drops every update; its handshakes report the difference instead.
    if (acknowledgement.readOnly) return;
    const lacking = serverHas.lacking(document);
    if (!lacking) return;
    provider.documentUpdateHandler(lacking, null);
    noteUnacknowledged(lacking);
  }

  function handleAuthenticated({ scope }: onAuthenticatedParameters): void {
    if (terminal || destroyed) return;
    if (scope === "readonly") {
      acknowledgement.admitReadOnly();
      publishAccess("read", currentClosedWhy, true);
    } else publishAccess("edit", null);
  }

  // A read admission's document can no longer upload, so a change it did not make while drawing
  // asks for one handshake, and that handshake decides. The server's answer is applied with the
  // provider as origin, so this cannot loop; one per task.
  let handshakeRequested = false;
  function requestHandshake(): void {
    if (handshakeRequested || terminal || destroyed || !acknowledgement.readOnly) return;
    handshakeRequested = true;
    queueMicrotask(() => {
      handshakeRequested = false;
      if (acknowledgement.readOnly && websocket.status === WebSocketStatus.Connected)
        provider.forceSync();
    });
  }

  function handleAuthenticationFailed({ reason }: onAuthenticationFailedParameters): void {
    if (destroyed) return;
    publishTerminal(classifyDocumentTransportClose({ reason }) ?? terminalState(reason));
  }

  function handleClose({ event }: onCloseParameters): void {
    if (terminal || destroyed) return;
    if (isAccessChangedClose(event)) {
      // Frozen until the reconnect's authenticated message names the new scope. A close that
      // names no reason (an unarchive, a restore) leaves it pending too: the answer is on its way.
      const why = accessChangedWhy(event) ?? null;
      publishAccess("read", why, !why);
    } else if (event.reason === WS_CLOSE.DOCUMENT_DELETED.reason) {
      // A removed document has no reconnect, so it stays read-only.
      publishAccess("read", null);
    }
    const state = classifyDocumentTransportClose(event);
    if (state) {
      publishTerminal(state);
      return;
    }
    // Any 1013 counts, whatever its reason, and whether or not the outbox holds the frame: typing
    // replayed from the copy goes out in each handshake without passing through it. A reconnect
    // that is acknowledged resets the count.
    if (event.code === WS_CLOSE.WRITER_ADMISSION_FAILED.code && ++refusals >= MAX_UPDATE_REFUSALS)
      publishTerminal({ kind: "terminal", reason: UPDATES_REFUSED, code: event.code });
  }

  function handleStateless({ payload }: onStatelessParameters): void {
    const message = parseYjsStatelessMessage(payload);
    if (message?.type === "read_only") publishAccess("read", message.why ?? null);
    else if (message?.type === "change_event")
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
    serverOrigin: provider,
    requestHandshake,
    unacknowledgedUpdates: () => outbox,
    whenCurrentChangesAcknowledged: () => acknowledgement.whenCurrentChangesAcknowledged(),
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
    subscribeDifference(listener) {
      differenceListeners.add(listener);
      return () => {
        differenceListeners.delete(listener);
      };
    },
    subscribeServerHas(listener) {
      serverHasListeners.add(listener);
      return () => {
        serverHasListeners.delete(listener);
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
      if (currentAccess) listener(currentAccess, currentClosedWhy, reasonPending);
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
      acknowledgement.terminate();
      provider.destroy();
      websocket.destroy();
      listeners.clear();
      accessListeners.clear();
      acknowledgementListeners.clear();
      differenceListeners.clear();
      serverHasListeners.clear();
      changeEventListeners.clear();
    },
  };
}

import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import {
  decodeLoroJoinExtra,
  encodeLoroJoinAuth,
  LORO_JOIN_ERROR,
  LORO_ROOM_ERROR,
  LORO_WS_PATH,
  type LoroRoom,
  loroRoomErrorOf,
  loroRoomName,
  WS_CLOSE,
} from "@meridian/contracts/protocol";
import {
  batchEnd,
  type DocKey,
  type DocVersion,
  decodeRoomVersion,
  encodeRoomVersion,
  mergeVersion,
  type RoomVersion,
  versionCovers,
} from "@meridian/document-model";
import { COLLAB_SCHEMA_VERSION, formatCollabSchemaVersion } from "@meridian/prosemirror-schema";
import type { EphemeralStore } from "loro-crdt";
import {
  bytesToHex,
  CrdtType,
  decode,
  encode,
  MAX_MESSAGE_SIZE,
  MessageType,
  type ProtocolMessage,
  RoomErrorCode,
  UpdateStatusCode,
} from "loro-protocol";
import type { DocumentSessionAccess } from "@/core/editor/document-session";
import type { ConnectivityHintsPort } from "./connectivity-hints";
import { buildSameOriginWsUrl } from "./dev-transport";
import { notifyLoroMessage, notifyLoroSocketClose, notifyLoroSocketOpen } from "./wire-tap";

export type RoomResetReason =
  | typeof WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason
  | typeof WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason
  | typeof WS_CLOSE.DOCUMENT_DELETED.reason;

export type ResetDisposition = "schema" | "removed";

export type RoomConnectionState =
  | { kind: "connecting"; attempt: number }
  | { kind: "connected" }
  | { kind: "disconnected" }
  | { kind: "signed-out" }
  | { kind: "reset"; reason: RoomResetReason; disposition: ResetDisposition }
  | { kind: "unauthorized"; reason: string; code?: number }
  | { kind: "terminal"; reason: string };

export type TransportedCopy = {
  version(): RoomVersion;
  exportSince(since: RoomVersion): Uint8Array | null;
  importRemote(batch: Uint8Array): void;
};

export type LoroRoomTransportOptions = {
  room: LoroRoom;
  peer: string;
  copy: TransportedCopy;
  presence?: EphemeralStore;
  onJoined?: (extra: Uint8Array | undefined) => "rejoin" | undefined;
  connectivityHints?: ConnectivityHintsPort;
};

export type LoroRoomTransport = {
  send(batch: Uint8Array): void;
  sendLacking(): void;
  /**
   * Resolves once every batch sent so far is acknowledged. A room that is not joined (offline or
   * signed out) is waited for until it joins and its Join's batch (what the server lacks, the
   * typing done while away included) is acknowledged; it resolves when the room ends.
   */
  whenSentAcknowledged(): Promise<void>;
  serverVersion(): RoomVersion;
  readonly synced: boolean;
  readonly whenSynced: Promise<void>;
  subscribeStatus(listener: (state: RoomConnectionState) => void): () => void;
  subscribeAccess(
    listener: (access: DocumentSessionAccess, closedWhy: ClosedOwnerWhy | null) => void,
  ): () => void;
  subscribeServerAcknowledgement(listener: (acknowledged: boolean) => void): () => void;
  destroy(): void;
};

const RESET_REASONS: Readonly<Record<string, RoomResetReason>> = {
  [LORO_JOIN_ERROR.DOCUMENT_DELETED.appCode]: WS_CLOSE.DOCUMENT_DELETED.reason,
  [LORO_JOIN_ERROR.CLIENT_SCHEMA_SUPERSEDED.appCode]: WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason,
  [LORO_JOIN_ERROR.DOCUMENT_SCHEMA_STALE.appCode]: WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason,
};

const RETRY_MS = [250, 1_000, 2_500, 5_000, 10_000];
/** Room payload per fragment, under the protocol's 256 KiB message limit with header room. */
const FRAGMENT_BYTES = MAX_MESSAGE_SIZE - 4 * 1024;

function resetState(reason: RoomResetReason): RoomConnectionState {
  return {
    kind: "reset",
    reason,
    disposition: reason === WS_CLOSE.DOCUMENT_DELETED.reason ? "removed" : "schema",
  };
}

function randomBatchId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

const frame = (message: ProtocolMessage) => encode(message) as Uint8Array<ArrayBuffer>;

export function createLoroRoomTransport({
  room,
  peer,
  copy,
  presence,
  onJoined,
  connectivityHints,
}: LoroRoomTransportOptions): LoroRoomTransport {
  const roomId = loroRoomName(room);
  const statusListeners = new Set<(state: RoomConnectionState) => void>();
  const accessListeners = new Set<
    (access: DocumentSessionAccess, closedWhy: ClosedOwnerWhy | null) => void
  >();
  const ackListeners = new Set<(acknowledged: boolean) => void>();
  let state: RoomConnectionState = { kind: "connecting", attempt: 1 };
  let access: { access: DocumentSessionAccess; why: ClosedOwnerWhy | null } | null = null;
  let socket: WebSocket | null = null;
  let joined = false;
  let destroyed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const unacked = new Map<string, RoomVersion>();
  const sentWaiters = new Set<{ ids: Set<string> | null; resolve: () => void }>();
  const settleSentWaiters = () => {
    for (const waiter of sentWaiters) {
      if (!destroyed && !ended()) {
        if (!connected()) {
          waiter.ids = null;
          continue;
        }
        waiter.ids ??= new Set(unacked.keys());
        if ([...waiter.ids].some((id) => unacked.has(id))) continue;
      }
      sentWaiters.delete(waiter);
      waiter.resolve();
    }
  };
  const server = new Map<DocKey, DocVersion>();
  const fragments = new Map<string, { count: number; parts: Uint8Array[] }>();
  let resolveSynced!: () => void;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  let synced = false;
  /**
   * Until synced: the Join's version, and what the transport handed the copy (its version at the
   * Join and each batch received since). Decided from what was handed, not `copy.version()`: the
   * composition guard can hold a batch and import it later without the transport seeing it.
   */
  let catchUp: { want: RoomVersion; handed: Map<DocKey, DocVersion> } | null = null;
  const settleSynced = () => {
    if (synced || !catchUp || !versionCovers(catchUp.handed, catchUp.want)) return;
    synced = true;
    catchUp = null;
    resolveSynced();
  };

  const emitStatus = (next: RoomConnectionState) => {
    state = next;
    for (const listener of statusListeners) listener(state);
    emitAck();
  };
  const connected = () => state.kind === "connected" && joined;
  const acknowledged = () => connected() && unacked.size === 0;
  let lastAck: boolean | null = null;
  const emitAck = () => {
    settleSentWaiters();
    const value = acknowledged();
    if (value === lastAck) return;
    lastAck = value;
    for (const listener of ackListeners) listener(value);
  };
  const emitAccess = (next: DocumentSessionAccess, why: ClosedOwnerWhy | null) => {
    access = { access: next, why };
    for (const listener of accessListeners) listener(next, why);
  };
  const ended = () =>
    state.kind === "reset" || state.kind === "terminal" || state.kind === "unauthorized";

  const transmit = (ws: WebSocket, message: ProtocolMessage) => {
    const bytes = frame(message);
    notifyLoroMessage("client_to_server", roomId, message, bytes.byteLength);
    ws.send(bytes);
  };
  const write = (message: ProtocolMessage) => {
    if (socket?.readyState === WebSocket.OPEN) transmit(socket, message);
  };
  const sendBatch = (
    crdt: typeof CrdtType.Loro | typeof CrdtType.LoroEphemeralStore,
    bytes: Uint8Array,
  ) => {
    const batchId = randomBatchId();
    if (bytes.length <= FRAGMENT_BYTES) {
      write({ type: MessageType.DocUpdate, crdt, roomId, updates: [bytes], batchId });
      return batchId;
    }
    const count = Math.ceil(bytes.length / FRAGMENT_BYTES);
    write({
      type: MessageType.DocUpdateFragmentHeader,
      crdt,
      roomId,
      batchId,
      fragmentCount: count,
      totalSizeBytes: bytes.length,
    });
    for (let index = 0; index < count; index++)
      write({
        type: MessageType.DocUpdateFragment,
        crdt,
        roomId,
        batchId,
        index,
        fragment: bytes.subarray(index * FRAGMENT_BYTES, (index + 1) * FRAGMENT_BYTES),
      });
    return batchId;
  };
  const sendDoc = (bytes: Uint8Array) => {
    if (!joined || access?.access === "read") return;
    unacked.set(sendBatch(CrdtType.Loro, bytes), batchEnd(bytes));
    emitAck();
  };
  const sendLacking = () => {
    if (!joined) return;
    const carried = new Map(server);
    for (const version of unacked.values()) mergeVersion(carried, version);
    const lacking = copy.exportSince(carried);
    if (lacking) sendDoc(lacking);
  };

  const receiveBatch = (bytes: Uint8Array) => {
    const received = batchEnd(bytes);
    // Before the import: the session reads the server's version to learn another tab's ops landed.
    mergeVersion(server, received);
    copy.importRemote(bytes);
    if (catchUp) mergeVersion(catchUp.handed, received);
    settleSynced();
  };

  const onMessage = (message: ProtocolMessage) => {
    if (message.roomId !== roomId) return;
    if (message.crdt === CrdtType.LoroEphemeralStore) {
      if (presence && message.type === MessageType.DocUpdate)
        for (const update of message.updates) presence.apply(update);
      return;
    }
    switch (message.type) {
      case MessageType.JoinResponseOk: {
        if (onJoined?.(message.extra) === "rejoin") {
          socket?.close(1000, "rejoin");
          return;
        }
        joined = true;
        attempt = 0;
        server.clear();
        const joinVersion = decodeRoomVersion(message.version);
        mergeVersion(server, joinVersion);
        const { readOnlyWhy } = decodeLoroJoinExtra(message.extra);
        if (message.permission === "write") emitAccess("edit", null);
        else emitAccess("read", readOnlyWhy ?? null);
        if (presence) {
          write({
            type: MessageType.JoinRequest,
            crdt: CrdtType.LoroEphemeralStore,
            roomId,
            auth: new Uint8Array(),
            version: new Uint8Array(),
          });
          const local = presence.encodeAll();
          if (local.length > 0) sendBatch(CrdtType.LoroEphemeralStore, local);
        }
        sendLacking();
        if (!synced) catchUp = { want: joinVersion, handed: new Map(copy.version()) };
        settleSynced();
        emitStatus({ kind: "connected" });
        return;
      }
      case MessageType.JoinError: {
        const reset = message.appCode ? RESET_REASONS[message.appCode] : undefined;
        if (reset) return end(resetState(reset));
        if (message.appCode === LORO_JOIN_ERROR.PERMISSION_DENIED.appCode)
          return end({ kind: "unauthorized", reason: message.appCode, code: message.code });
        if (message.appCode === LORO_JOIN_ERROR.BAD_AUTH.appCode)
          return end({ kind: "terminal", reason: message.appCode });
        socket?.close(1000, "join-refused");
        return;
      }
      case MessageType.DocUpdate:
        for (const update of message.updates) receiveBatch(update);
        return;
      case MessageType.DocUpdateFragmentHeader:
        fragments.set(message.batchId, { count: message.fragmentCount, parts: [] });
        return;
      case MessageType.DocUpdateFragment: {
        const pending = fragments.get(message.batchId);
        if (!pending) return;
        pending.parts[message.index] = message.fragment;
        if (pending.parts.filter(Boolean).length < pending.count) return;
        fragments.delete(message.batchId);
        let size = 0;
        for (const part of pending.parts) size += part.length;
        const whole = new Uint8Array(size);
        let at = 0;
        for (const part of pending.parts) {
          whole.set(part, at);
          at += part.length;
        }
        receiveBatch(whole);
        return;
      }
      case MessageType.Ack: {
        const version = unacked.get(message.refId);
        // A refused batch stays outstanding: the next Join sends what the server lacks.
        if (!version || message.status !== UpdateStatusCode.Ok) return;
        unacked.delete(message.refId);
        mergeVersion(server, version);
        emitAck();
        return;
      }
      case MessageType.RoomError: {
        const known = loroRoomErrorOf(message.message);
        if (known === LORO_ROOM_ERROR.DOCUMENT_DELETED)
          return end(resetState(WS_CLOSE.DOCUMENT_DELETED.reason));
        if (message.code === RoomErrorCode.RejoinSuggested) {
          if (known === LORO_ROOM_ERROR.ACCESS_CHANGED) {
            const why = message.message.split(":")[1] as ClosedOwnerWhy | undefined;
            emitAccess("read", why ?? null);
          }
          socket?.close(1000, "rejoin");
          return;
        }
        return end({ kind: "terminal", reason: known?.reason ?? message.message });
      }
    }
  };

  const connect = () => {
    if (destroyed || ended()) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    attempt += 1;
    if (state.kind !== "signed-out") emitStatus({ kind: "connecting", attempt });
    const ws = new WebSocket(buildSameOriginWsUrl(LORO_WS_PATH));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      notifyLoroSocketOpen(roomId, attempt);
      if (socket !== ws) return;
      transmit(ws, {
        type: MessageType.JoinRequest,
        crdt: CrdtType.Loro,
        roomId,
        auth: encodeLoroJoinAuth({
          schema: formatCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
          peer,
        }),
        version: encodeRoomVersion(copy.version()),
      });
    };
    ws.onmessage = (event) => {
      if (socket !== ws || !(event.data instanceof ArrayBuffer)) return;
      const message = decode(new Uint8Array(event.data));
      notifyLoroMessage("server_to_client", roomId, message, event.data.byteLength);
      onMessage(message);
    };
    ws.onclose = (event) => {
      notifyLoroSocketClose(roomId, attempt, event.code, event.wasClean);
      if (socket !== ws) return;
      socket = null;
      joined = false;
      unacked.clear();
      fragments.clear();
      if (destroyed || ended()) return;
      if (event.code === WS_CLOSE.PERMISSION_DENIED.code) {
        emitStatus({ kind: "unauthorized", reason: event.reason, code: event.code });
        connectivityHints?.reportDisconnected(source);
        return;
      }
      emitStatus(
        event.code === WS_CLOSE.AUTH_FAILED.code || state.kind === "signed-out"
          ? { kind: "signed-out" }
          : { kind: "disconnected" },
      );
      connectivityHints?.reportDisconnected(source);
      const delay =
        event.reason === "rejoin" ? 0 : RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      retryTimer = setTimeout(connect, delay);
    };
  };

  const end = (next: RoomConnectionState) => {
    emitStatus(next);
    const ws = socket;
    socket = null;
    joined = false;
    ws?.close(1000, "room-ended");
  };

  const source = {};
  const unsubscribeHints = connectivityHints?.subscribe(source, (hint) => {
    if (hint === "retry-now" && !socket && !destroyed) connect();
    if (hint === "suspect-offline" && socket) socket.close(1000, "browser_offline");
  });
  const unsubscribePresence = presence?.subscribeLocalUpdates((bytes) => {
    if (joined) sendBatch(CrdtType.LoroEphemeralStore, bytes);
  });

  connect();

  return {
    send: sendDoc,
    sendLacking,
    whenSentAcknowledged() {
      if (destroyed || ended() || acknowledged()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        sentWaiters.add({ ids: connected() ? new Set(unacked.keys()) : null, resolve });
      });
    },
    serverVersion: () => server,
    get synced() {
      return synced;
    },
    whenSynced,
    subscribeStatus(listener) {
      statusListeners.add(listener);
      listener(state);
      return () => statusListeners.delete(listener);
    },
    subscribeAccess(listener) {
      accessListeners.add(listener);
      if (access) listener(access.access, access.why);
      return () => accessListeners.delete(listener);
    },
    subscribeServerAcknowledgement(listener) {
      ackListeners.add(listener);
      listener(acknowledged());
      return () => ackListeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      settleSentWaiters();
      clearTimeout(retryTimer);
      unsubscribeHints?.();
      unsubscribePresence?.();
      const ws = socket;
      socket = null;
      if (ws?.readyState === WebSocket.OPEN)
        transmit(ws, { type: MessageType.Leave, crdt: CrdtType.Loro, roomId });
      ws?.close(1000, "destroyed");
    },
  };
}

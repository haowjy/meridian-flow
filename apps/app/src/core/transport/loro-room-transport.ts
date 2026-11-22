/**
 * The room transport on `loro-protocol`, for a document's room and a tree list's (design §4 and §6): one socket per room, a Join that
 * exchanges versions, local batches sent as `DocUpdate`s and acknowledged one `Ack` each, peers'
 * batches handed to the session (which imports them through the composition guard), and presence
 * on the room's ephemeral store.
 *
 * The Join exchange, which the server's handler speaks too (design §4, "The Join exchange"):
 * the client sends `JoinRequest` with its room version; the server answers `JoinResponseOk` with
 * the permission and its own room version, then sends what the copy lacks as one `DocUpdate`
 * (fragmented when large); the client sends what the server lacks as one `DocUpdate`, which is
 * acknowledged like any other. Server `DocUpdate`s are not acknowledged.
 */
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
import type { DocKey, Envelope } from "@meridian/document-model";
import { decodeEnvelope, decodeRoomVersion, encodeRoomVersion } from "@meridian/document-model";
import { COLLAB_SCHEMA_VERSION, formatCollabSchemaVersion } from "@meridian/prosemirror-schema";
import { decodeImportBlobMeta, type EphemeralStore, VersionVector } from "loro-crdt";
import {
  bytesToHex,
  CrdtType,
  decode,
  encode,
  MAX_MESSAGE_SIZE,
  MessageType,
  type ProtocolMessage,
  RoomErrorCode,
} from "loro-protocol";
import type {
  DocumentSessionAccess,
  DocumentSessionConnectionState,
  DocumentSessionResetReason,
} from "@/core/editor/document-session";
import type { ConnectivityHintsPort } from "./connectivity-hints";
import { buildSameOriginWsUrl } from "./dev-transport";

export type RoomVersion = Map<DocKey, VersionVector>;

/** What the transport needs from the copy it carries. */
export type TransportedCopy = {
  /** The copy's room version now. */
  version(): RoomVersion;
  /** What the copy holds beyond `since`, as an envelope; null when nothing. */
  exportSince(since: RoomVersion): Uint8Array | null;
  /** A peer's batch from the server: the session imports it through the composition guard. */
  importRemote(batch: Uint8Array): void;
};

export type LoroRoomTransportOptions = {
  room: LoroRoom;
  peer: string;
  copy: TransportedCopy;
  /** The room's presence; a room without one (a tree list) joins no presence channel. */
  presence?: EphemeralStore;
  /**
   * Called with each `JoinResponseOk`'s `extra` before anything is sent. `"rejoin"` closes the
   * socket and joins again: the copy changed under the Join (a tree copy of another list).
   */
  onJoined?: (extra: Uint8Array | undefined) => "rejoin" | undefined;
  connectivityHints?: ConnectivityHintsPort;
};

export type LoroRoomTransport = {
  /** Send a local batch; it is acknowledged once the room imported it. */
  send(batch: Uint8Array): void;
  /**
   * Resolves once the server holds everything this copy holds now (its acked batches and the
   * batches it sent cover the version taken at the call). Rejects when the room ends first.
   */
  whenCurrentChangesAcknowledged(): Promise<void>;
  /** What the server is known to hold: its Join version, the batches it acked and sent. */
  serverVersion(): RoomVersion;
  readonly synced: boolean;
  readonly whenSynced: Promise<void>;
  subscribeStatus(listener: (state: DocumentSessionConnectionState) => void): () => void;
  subscribeAccess(
    listener: (access: DocumentSessionAccess, closedWhy: ClosedOwnerWhy | null) => void,
  ): () => void;
  /** True while connected, joined, and every batch sent on this connection is acknowledged. */
  subscribeServerAcknowledgement(listener: (acknowledged: boolean) => void): () => void;
  destroy(): void;
};

const RESET_REASONS: Readonly<Record<string, DocumentSessionResetReason>> = {
  [LORO_JOIN_ERROR.DOCUMENT_DELETED.appCode]: WS_CLOSE.DOCUMENT_DELETED.reason,
  [LORO_JOIN_ERROR.CLIENT_SCHEMA_SUPERSEDED.appCode]: WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason,
  [LORO_JOIN_ERROR.DOCUMENT_SCHEMA_STALE.appCode]: WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason,
};

const RETRY_MS = [250, 1_000, 2_500, 5_000, 10_000];
/** Room payload per fragment, under the protocol's 256 KiB message limit with header room. */
const FRAGMENT_BYTES = MAX_MESSAGE_SIZE - 4 * 1024;

function resetState(reason: DocumentSessionResetReason): DocumentSessionConnectionState {
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

/** `into` takes, per doc and peer, the larger counter of the two. */
export function mergeVersion(into: RoomVersion, from: ReadonlyMap<DocKey, VersionVector>) {
  for (const [key, vv] of from) {
    const have = into.get(key);
    if (!have) {
      into.set(key, VersionVector.decode(vv.encode()));
      continue;
    }
    const merged = new Map(have.toJSON());
    for (const [peer, counter] of vv.toJSON())
      if ((merged.get(peer) ?? 0) < counter) merged.set(peer, counter);
    into.set(key, new VersionVector(merged));
  }
}

/** Whether `have` covers every op of `want`. */
export function versionCovers(
  have: ReadonlyMap<DocKey, VersionVector>,
  want: ReadonlyMap<DocKey, VersionVector>,
): boolean {
  for (const [key, vv] of want) {
    const own = have.get(key)?.toJSON();
    for (const [peer, counter] of vv.toJSON()) if ((own?.get(peer) ?? 0) < counter) return false;
  }
  return true;
}

/** A message as one frame. `encode` allocates the frame's own buffer, so it is never shared. */
const frame = (message: ProtocolMessage) => encode(message) as Uint8Array<ArrayBuffer>;

/** Each doc's version once an envelope's updates are imported, from their metadata. */
function batchEnd(batch: Envelope): RoomVersion {
  const out: RoomVersion = new Map();
  for (const [key, bytes] of batch)
    out.set(key, decodeImportBlobMeta(bytes, false).partialEndVersionVector);
  return out;
}

export function createLoroRoomTransport({
  room,
  peer,
  copy,
  presence,
  onJoined,
  connectivityHints,
}: LoroRoomTransportOptions): LoroRoomTransport {
  const roomId = loroRoomName(room);
  const statusListeners = new Set<(state: DocumentSessionConnectionState) => void>();
  const accessListeners = new Set<
    (access: DocumentSessionAccess, closedWhy: ClosedOwnerWhy | null) => void
  >();
  const ackListeners = new Set<(acknowledged: boolean) => void>();
  const barriers = new Set<{
    want: RoomVersion;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  let state: DocumentSessionConnectionState = { kind: "connecting", attempt: 1 };
  let access: { access: DocumentSessionAccess; why: ClosedOwnerWhy | null } | null = null;
  let socket: WebSocket | null = null;
  let joined = false;
  let destroyed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Batches sent on this connection and not yet acked, with each doc's version once imported. */
  const unacked = new Map<string, RoomVersion>();
  const server: RoomVersion = new Map();
  /** Fragments of a server batch being reassembled, by batch id. */
  const fragments = new Map<string, { count: number; parts: Uint8Array[] }>();
  let resolveSynced!: () => void;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  let synced = false;

  const emitStatus = (next: DocumentSessionConnectionState) => {
    state = next;
    for (const listener of statusListeners) listener(state);
    emitAck();
  };
  const acknowledged = () => state.kind === "connected" && joined && unacked.size === 0;
  let lastAck: boolean | null = null;
  const emitAck = () => {
    const value = acknowledged();
    if (value === lastAck) return;
    lastAck = value;
    for (const listener of ackListeners) listener(value);
  };
  const emitAccess = (next: DocumentSessionAccess, why: ClosedOwnerWhy | null) => {
    access = { access: next, why };
    for (const listener of accessListeners) listener(next, why);
  };
  const settleBarriers = () => {
    for (const barrier of [...barriers])
      if (versionCovers(server, barrier.want)) {
        barriers.delete(barrier);
        barrier.resolve();
      }
  };
  const ended = () =>
    state.kind === "reset" || state.kind === "terminal" || state.kind === "unauthorized";
  const failBarriers = () => {
    for (const barrier of barriers) barrier.reject(new Error(`room ${roomId} ended`));
    barriers.clear();
  };

  const write = (message: ProtocolMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(frame(message));
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
    unacked.set(sendBatch(CrdtType.Loro, bytes), batchEnd(decodeEnvelope(bytes)));
    emitAck();
  };

  const receiveBatch = (bytes: Uint8Array) => {
    copy.importRemote(bytes);
    mergeVersion(server, batchEnd(decodeEnvelope(bytes)));
    settleBarriers();
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
        mergeVersion(server, decodeRoomVersion(message.version));
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
        const lacking = copy.exportSince(server);
        if (lacking) sendDoc(lacking);
        if (!synced) {
          synced = true;
          resolveSynced();
        }
        settleBarriers();
        emitStatus({ kind: "connected" });
        return;
      }
      case MessageType.JoinError: {
        const reset = message.appCode ? RESET_REASONS[message.appCode] : undefined;
        if (reset) return end(resetState(reset));
        if (
          message.appCode === LORO_JOIN_ERROR.BAD_AUTH.appCode ||
          message.appCode === LORO_JOIN_ERROR.PERMISSION_DENIED.appCode
        )
          return end({ kind: "unauthorized", reason: message.appCode, code: message.code });
        // `document-unknown`: the server has not seen this browser's `create` yet.
        socket?.close(1000, "rejoin");
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
        if (!version) return;
        unacked.delete(message.refId);
        mergeVersion(server, version);
        settleBarriers();
        emitAck();
        return;
      }
      case MessageType.RoomError: {
        const known = loroRoomErrorOf(message.message);
        if (known === LORO_ROOM_ERROR.DOCUMENT_DELETED)
          return end(resetState(WS_CLOSE.DOCUMENT_DELETED.reason));
        if (message.code === RoomErrorCode.RejoinSuggested) {
          // An access change shows read-only at once; the rejoin's admission decides. Any other
          // rejoin (a server error) resends what was not acked.
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
    emitStatus({ kind: "connecting", attempt });
    const ws = new WebSocket(buildSameOriginWsUrl(LORO_WS_PATH));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      ws.send(
        frame({
          type: MessageType.JoinRequest,
          crdt: CrdtType.Loro,
          roomId,
          auth: encodeLoroJoinAuth({
            schema: formatCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
            peer,
          }),
          version: encodeRoomVersion(copy.version()),
        }),
      );
    };
    ws.onmessage = (event) => {
      if (socket !== ws || !(event.data instanceof ArrayBuffer)) return;
      onMessage(decode(new Uint8Array(event.data)));
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      joined = false;
      unacked.clear();
      fragments.clear();
      if (destroyed || ended()) return;
      if (
        event.code === WS_CLOSE.AUTH_FAILED.code ||
        event.code === WS_CLOSE.PERMISSION_DENIED.code
      ) {
        emitStatus({ kind: "unauthorized", reason: event.reason, code: event.code });
        if (event.code === WS_CLOSE.PERMISSION_DENIED.code) failBarriers();
        connectivityHints?.reportDisconnected(source);
        return;
      }
      emitStatus({ kind: "disconnected" });
      connectivityHints?.reportDisconnected(source);
      const delay =
        event.reason === "rejoin" ? 0 : RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      retryTimer = setTimeout(connect, delay);
    };
  };

  const end = (next: DocumentSessionConnectionState) => {
    emitStatus(next);
    failBarriers();
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
    whenCurrentChangesAcknowledged() {
      const want = copy.version();
      if (versionCovers(server, want)) return Promise.resolve();
      if (ended()) return Promise.reject(new Error(`room ${roomId} ended`));
      return new Promise((resolve, reject) => barriers.add({ want, resolve, reject }));
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
      clearTimeout(retryTimer);
      unsubscribeHints?.();
      unsubscribePresence?.();
      const ws = socket;
      socket = null;
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(frame({ type: MessageType.Leave, crdt: CrdtType.Loro, roomId }));
      ws?.close(1000, "destroyed");
      failBarriers();
    },
  };
}

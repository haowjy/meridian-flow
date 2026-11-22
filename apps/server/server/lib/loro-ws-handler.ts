/** The `/ws/loro` room server (design §4): `loro-protocol` frames over one socket, many rooms. */

import type { DocumentId, DraftId } from "@meridian/contracts";
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import {
  createFrameReader,
  type DocumentRoom,
  decodeLoroJoinAuth,
  docUpdateFrames,
  encodeLoroJoinExtra,
  freshBatchId,
  LORO_JOIN_ERROR,
  LORO_ROOM_ERROR,
  loroAccessChangedReason,
  loroRoomName,
  parseLoroRoomName,
  type TreeListRef,
  WS_CLOSE,
} from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import { CorruptDocBytesError, EnvelopeError, HistoryCutoffError } from "@meridian/document-model";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  headAdmitsClient,
  parseCollabSchemaVersion,
  serverServesHead,
} from "@meridian/prosemirror-schema";
import {
  CrdtType,
  encode,
  type HexString,
  type JoinRequest,
  MessageType,
  type Permission,
  type ProtocolMessage,
  UpdateStatusCode,
} from "loro-protocol";
import {
  documentAccessKey,
  type FileAccessChanges,
  type FileFacts,
  type FileTarget,
  fileAccessChangeKey,
  grantOwnerLocks,
  isFileAccessDenied,
  ownerAccessKey,
  projectAccessKey,
} from "../domains/file-policy/index.js";
import {
  emitEvent,
  errorMessageOf,
  runWithEventCorrelation,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import type { AppServices } from "./app.js";
import type { TreeRooms } from "./loro-tree-rooms.js";
import { createRoomAccessIndex, type RoomRegistration } from "./room-access.js";

export type LoroGatewayServices = {
  fileAccess: Pick<AppServices["fileAccess"], "authorize" | "historyAccess">;
  fileAccessChanges: Pick<FileAccessChanges, "subscribe">;
  rooms: Pick<DocumentRooms<unknown>, "sync" | "write" | "subscribe"> & { close(): Promise<void> };
  trees: Pick<TreeRooms, "open" | "sync" | "write" | "subscribe" | "dispose">;
  documents: {
    draftsHolding(documentId: DocumentId): Promise<DraftId[]>;
    roomRemoval(documentId: DocumentId): Promise<{ documentId: DocumentId } | null>;
    /** The newest schema that wrote the document's text; null when it has no row. */
    schemaVersion(documentId: DocumentId): Promise<CollabSchemaVersion | null>;
    /** Documents whose rooms end for good (a purge): their sockets are told and dropped. */
    onRoomsEnded(listener: (documentIds: readonly DocumentId[]) => void): () => void;
  };
  eventSink: AppServices["eventSink"];
};

export type LoroGatewayPeer = {
  userId: UserId;
  traceId: string;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
};

type Joined = {
  /** The document a document room holds; null for a tree list's room. */
  documentId: DocumentId | null;
  permission: Permission;
  /** Imports one batch a client sent into the room. */
  write(batch: Uint8Array): Promise<void>;
  /** Batches heard before the Join's answer went out, sent right after it. */
  held: { batch: Uint8Array }[] | null;
  unsubscribe(): void;
  registration: RoomRegistration;
};

export type LoroGatewayConnection = {
  readonly id: string;
  readonly peer: LoroGatewayPeer;
  readonly joined: Map<string, Joined>;
  read: (data: Uint8Array) => ProtocolMessage | null;
  /** A socket's frames are handled one after another, in arrival order. */
  queue: Promise<void>;
  closed: boolean;
};

type JoinRefusal = (typeof LORO_JOIN_ERROR)[keyof typeof LORO_JOIN_ERROR];

class JoinRefused extends Error {
  constructor(readonly refusal: JoinRefusal) {
    super(refusal.appCode);
  }
}

type Admission = {
  permission: Permission;
  readOnlyWhy?: ClosedOwnerWhy;
  target: FileTarget;
  accessKeys: string[];
};

export function createLoroGateway(services: LoroGatewayServices) {
  let accepting = true;
  const connections = new Set<LoroGatewayConnection>();
  const access = createRoomAccessIndex();
  const unsubscribeAccess = services.fileAccessChanges.subscribe((change) =>
    access.revokeOwner(fileAccessChangeKey(change), "closed" in change ? change.closed : undefined),
  );
  const unsubscribeEnds = services.documents.onRoomsEnded((documentIds) => {
    const ended = new Set<string>(documentIds);
    for (const connection of connections)
      for (const [name, joined] of [...connection.joined])
        if (joined.documentId !== null && ended.has(joined.documentId))
          endRoom(connection, name, LORO_ROOM_ERROR.DOCUMENT_DELETED);
    // The access-changed path is how every other change of access reaches a socket.
  });

  function send(connection: LoroGatewayConnection, message: ProtocolMessage) {
    if (!connection.closed) connection.peer.send(encode(message));
  }

  function sendBatch(connection: LoroGatewayConnection, roomId: string, batch: Uint8Array) {
    if (connection.closed) return;
    for (const frame of docUpdateFrames(roomId, batch, freshBatchId())) connection.peer.send(frame);
  }

  function drop(connection: LoroGatewayConnection, name: string) {
    const joined = connection.joined.get(name);
    if (!joined) return;
    connection.joined.delete(name);
    joined.unsubscribe();
    access.unregister(joined.registration);
  }

  function endRoom(
    connection: LoroGatewayConnection,
    name: string,
    error: { code: (typeof LORO_ROOM_ERROR)[keyof typeof LORO_ROOM_ERROR]["code"]; reason: string },
    reason = error.reason,
  ) {
    drop(connection, name);
    send(connection, {
      type: MessageType.RoomError,
      crdt: CrdtType.Loro,
      roomId: name,
      code: error.code,
      message: reason,
    });
  }

  async function findAccess(userId: UserId, target: FileTarget) {
    const edit = await services.fileAccess.authorize({ accountId: userId }, target, "edit");
    if (!isFileAccessDenied(edit))
      return { permission: "write" as const, facts: edit.facts as FileFacts };
    if (edit.level !== "read" || !edit.facts) return null;
    return {
      permission: "read" as const,
      readOnlyWhy: closedOwnerWhy(edit.facts),
      facts: edit.facts,
    };
  }

  /** What the person may do in the room, decided once at Join (file-access §7). */
  async function admit(
    userId: UserId,
    room: DocumentRoom,
    clientSchema: CollabSchemaVersion,
  ): Promise<Admission> {
    const { documentId } = room;
    let target: FileTarget =
      room.kind === "fork"
        ? { kind: "draft", documentId, draftId: room.draftId }
        : // A document in Trash takes text until its node is purged, so the room reads through Trash.
          { kind: "restore", documentId };
    let found = await findAccess(userId, target);
    // A document only a draft holds is Live text that draft's view reads.
    if (!found && room.kind === "live")
      for (const draftId of await services.documents.draftsHolding(documentId)) {
        const draft: FileTarget = { kind: "draft", documentId, draftId };
        found = await findAccess(userId, draft);
        if (found) {
          target = draft;
          break;
        }
      }
    if (!found) {
      const removed = await services.documents.roomRemoval(documentId);
      if (!removed) throw new JoinRefused(LORO_JOIN_ERROR.DOCUMENT_UNKNOWN);
      const history = await services.fileAccess.historyAccess({ accountId: userId }, documentId);
      throw new JoinRefused(
        history === "deleted"
          ? LORO_JOIN_ERROR.DOCUMENT_DELETED
          : LORO_JOIN_ERROR.PERMISSION_DENIED,
      );
    }
    const stored = await services.documents.schemaVersion(documentId);
    if (stored && !serverServesHead(stored, COLLAB_SCHEMA_VERSION))
      throw new JoinRefused(LORO_JOIN_ERROR.DOCUMENT_SCHEMA_STALE);
    if (stored && !headAdmitsClient(clientSchema, stored))
      throw new JoinRefused(LORO_JOIN_ERROR.CLIENT_SCHEMA_SUPERSEDED);
    return {
      permission: found.permission,
      ...(found.permission === "read" && found.readOnlyWhy
        ? { readOnlyWhy: found.readOnlyWhy }
        : {}),
      target,
      accessKeys: accessKeys(found.facts, documentId),
    };
  }

  async function join(connection: LoroGatewayConnection, message: JoinRequest) {
    const name = message.roomId;
    const refuse = (refusal: JoinRefusal) =>
      send(connection, {
        type: MessageType.JoinError,
        crdt: CrdtType.Loro,
        roomId: name,
        code: refusal.code,
        message: refusal.appCode,
        appCode: refusal.appCode,
      });
    const auth = decodeLoroJoinAuth(message.auth);
    const parsedSchema = auth ? parseCollabSchemaVersion(auth.schema) : null;
    if (!auth || !parsedSchema) return refuse(LORO_JOIN_ERROR.BAD_AUTH);
    const room = parseLoroRoomName(name);
    if (!room || loroRoomName(room) !== name) return refuse(LORO_JOIN_ERROR.PERMISSION_DENIED);
    drop(connection, name);
    const { userId } = connection.peer;
    if (room.kind === "tree") return joinTree(connection, message, room.list, refuse);
    let admission: Admission;
    try {
      admission = await admit(userId, room, parsedSchema);
    } catch (cause) {
      if (cause instanceof JoinRefused) return refuse(cause.refusal);
      throw cause;
    }
    // Subscribe before the sync, so no batch falls between the copy's catch-up and the stream.
    const joined: Joined = {
      documentId: room.documentId,
      permission: admission.permission,
      write: async (batch) => {
        await services.rooms.write(room, batch, connection.id);
      },
      held: [],
      unsubscribe: services.rooms.subscribe(room, (batch) => {
        if (batch.origin === connection.id) return;
        if (joined.held) joined.held.push({ batch: batch.batch });
        else sendBatch(connection, name, batch.batch);
      }),
      registration: {
        revoke: (why) =>
          endRoom(connection, name, LORO_ROOM_ERROR.ACCESS_CHANGED, loroAccessChangedReason(why)),
      },
    };
    connection.joined.set(name, joined);
    access.register(joined.registration, admission.accessKeys);
    // A change between admission and registration reached no room. Registered now, the room
    // hears every later change: ask once more, and end the room when the answer moved.
    const settled = await findAccess(userId, admission.target);
    if (
      !settled ||
      settled.permission !== admission.permission ||
      accessKeys(settled.facts, room.documentId).join() !== admission.accessKeys.join()
    ) {
      drop(connection, name);
      return refuse(LORO_JOIN_ERROR.DOCUMENT_UNKNOWN);
    }
    const sync = await services.rooms.sync(room, message.version);
    if (connection.joined.get(name) !== joined) return;
    send(connection, {
      type: MessageType.JoinResponseOk,
      crdt: CrdtType.Loro,
      roomId: name,
      permission: admission.permission,
      version: sync.version,
      extra: encodeLoroJoinExtra({ readOnlyWhy: admission.readOnlyWhy }),
    });
    if (sync.update) sendBatch(connection, name, sync.update);
    const held = joined.held ?? [];
    joined.held = null;
    for (const { batch } of held) sendBatch(connection, name, batch);
    emitEvent(services.eventSink, {
      level: "info",
      source: "collab.rooms",
      name: "room.join",
      correlation: { documentId: room.documentId },
      payload: {
        room: room.kind,
        permission: admission.permission,
        sentBytes: sync.update?.byteLength ?? 0,
      },
    });
  }

  /**
   * A tree list's room: open to the list's owner, always for writing. `extra` names the list, so
   * a client holding a copy of another list (a reset database, a recreated account list) drops it
   * and joins again from nothing.
   */
  async function joinTree(
    connection: LoroGatewayConnection,
    message: JoinRequest,
    list: TreeListRef,
    refuse: (refusal: JoinRefusal) => void,
  ) {
    const name = message.roomId;
    const { userId } = connection.peer;
    const listId = await services.trees.open(list, userId);
    if (listId === null) return refuse(LORO_JOIN_ERROR.PERMISSION_DENIED);
    const joined: Joined = {
      documentId: null,
      permission: "write",
      write: (batch) => services.trees.write(list, userId, batch),
      held: [],
      unsubscribe: services.trees.subscribe(listId, (batch) => {
        if (joined.held) joined.held.push({ batch });
        else sendBatch(connection, name, batch);
      }),
      registration: {
        revoke: (why) =>
          endRoom(connection, name, LORO_ROOM_ERROR.ACCESS_CHANGED, loroAccessChangedReason(why)),
      },
    };
    connection.joined.set(name, joined);
    access.register(joined.registration, [name]);
    // A deletion between the open and the registration reached no room: ask once more.
    if ((await services.trees.open(list, userId)) !== listId) {
      drop(connection, name);
      return refuse(LORO_JOIN_ERROR.PERMISSION_DENIED);
    }
    const sync = await services.trees.sync(listId, message.version);
    if (connection.joined.get(name) !== joined) return;
    send(connection, {
      type: MessageType.JoinResponseOk,
      crdt: CrdtType.Loro,
      roomId: name,
      permission: "write",
      version: sync.version,
      extra: encodeLoroJoinExtra({ list: listId }),
    });
    if (sync.update) sendBatch(connection, name, sync.update);
    const held = joined.held ?? [];
    joined.held = null;
    for (const { batch } of held) sendBatch(connection, name, batch);
    emitEvent(services.eventSink, {
      level: "info",
      source: "collab.rooms",
      name: "room.join",
      payload: { room: "tree", permission: "write", sentBytes: sync.update?.byteLength ?? 0 },
    });
  }

  async function update(
    connection: LoroGatewayConnection,
    name: string,
    batchId: HexString,
    updates: readonly Uint8Array[],
  ) {
    const ack = (status: (typeof UpdateStatusCode)[keyof typeof UpdateStatusCode]) =>
      send(connection, {
        type: MessageType.Ack,
        crdt: CrdtType.Loro,
        roomId: name,
        refId: batchId,
        status,
      });
    const joined = connection.joined.get(name);
    if (!joined || joined.permission !== "write") return ack(UpdateStatusCode.PermissionDenied);
    try {
      for (const batch of updates) await joined.write(batch);
    } catch (cause) {
      if (cause instanceof EnvelopeError || cause instanceof CorruptDocBytesError)
        return endRoom(connection, name, LORO_ROOM_ERROR.CORRUPT_UPDATE);
      if (cause instanceof HistoryCutoffError) {
        emitEvent(services.eventSink, {
          level: "info",
          source: "collab.rooms",
          name: "room.refused_cutoff",
          ...(joined.documentId ? { correlation: { documentId: joined.documentId } } : {}),
          payload: { room: name, doc: cause.key },
        });
        return endRoom(connection, name, LORO_ROOM_ERROR.HISTORY_CUTOFF);
      }
      emitEvent(services.eventSink, {
        level: "error",
        source: "collab.rooms",
        name: "room.write_failed",
        ...(joined.documentId ? { correlation: { documentId: joined.documentId } } : {}),
        payload: { room: name, ...unknownToEventPayload(cause), ...errorMessageOf(cause) },
      });
      return endRoom(connection, name, LORO_ROOM_ERROR.SERVER_ERROR);
    }
    ack(UpdateStatusCode.Ok);
  }

  async function handle(connection: LoroGatewayConnection, message: ProtocolMessage) {
    switch (message.type) {
      case MessageType.JoinRequest:
        return join(connection, message);
      case MessageType.DocUpdate:
        return update(connection, message.roomId, message.batchId, message.updates);
      case MessageType.Leave:
        return drop(connection, message.roomId);
      default:
        // Acks of the server's own batches, and server-to-client frames a client never sends.
        return;
    }
  }

  return {
    connect(peer: LoroGatewayPeer): LoroGatewayConnection | undefined {
      if (!accepting) {
        peer.close(WS_CLOSE.SERVER_SHUTDOWN.code, WS_CLOSE.SERVER_SHUTDOWN.reason);
        return;
      }
      const connection: LoroGatewayConnection = {
        id: `socket:${crypto.randomUUID()}`,
        peer,
        joined: new Map(),
        read: createFrameReader(),
        queue: Promise.resolve(),
        closed: false,
      };
      connections.add(connection);
      return connection;
    },

    message(connection: LoroGatewayConnection | undefined, data: Uint8Array): void {
      if (!connection || connection.closed) return;
      let message: ProtocolMessage | null;
      try {
        message = connection.read(data);
      } catch {
        // Not a protocol frame: nothing a client of ours sends. The socket's other rooms stay.
        return;
      }
      if (!message) return;
      const next = message;
      connection.queue = connection.queue
        .then(() =>
          runWithEventCorrelation({ traceId: connection.peer.traceId }, () =>
            handle(connection, next),
          ),
        )
        .catch((cause) => {
          emitEvent(services.eventSink, {
            level: "error",
            source: "collab.rooms",
            name: "socket.message_failed",
            payload: { ...unknownToEventPayload(cause), ...errorMessageOf(cause) },
          });
          if ("roomId" in next) endRoom(connection, next.roomId, LORO_ROOM_ERROR.SERVER_ERROR);
        });
    },

    close(connection: LoroGatewayConnection | undefined): void {
      if (!connection) return;
      connection.closed = true;
      for (const name of [...connection.joined.keys()]) drop(connection, name);
      connections.delete(connection);
    },

    /** Stops taking sockets, closes the open ones for a reconnect, and saves every room. */
    async drain(): Promise<void> {
      accepting = false;
      unsubscribeAccess();
      unsubscribeEnds();
      for (const connection of [...connections]) {
        connection.peer.close(WS_CLOSE.SERVER_SHUTDOWN.code, WS_CLOSE.SERVER_SHUTDOWN.reason);
        this.close(connection);
      }
      await services.trees.dispose();
      await services.rooms.close();
    },
  };
}

export type LoroGateway = ReturnType<typeof createLoroGateway>;

/** Why the file's owner is closed, if it is: what a read-only Join tells the writer. */
function closedOwnerWhy(facts: FileFacts | null | undefined): ClosedOwnerWhy | undefined {
  const owner = facts?.draftOwner ?? facts?.ownerWork;
  if (!owner) return undefined;
  if ("frozen" in owner && owner.owner?.kind === "lineage") {
    return owner.frozen ? "chat_frozen" : undefined;
  }
  if (owner.deleted) return "work_deleted";
  return owner.archived ? "work_archived" : undefined;
}

/**
 * Room access follows the file's owners (each under its `ownerAccessKey`), its project and the
 * document itself: access is decided once, at Join, so every change that can end it must reach
 * a key the room is under.
 */
function accessKeys(facts: FileFacts, documentId: DocumentId): string[] {
  const { workIds, lineageRootIds } = grantOwnerLocks(facts);
  return [
    ...workIds.map((workId) => ownerAccessKey({ workId })),
    ...lineageRootIds.map((rootThreadId) => ownerAccessKey({ rootThreadId })),
    ...(facts.owner.kind === "project" ? [projectAccessKey(facts.owner.projectId)] : []),
    documentAccessKey(documentId),
  ];
}

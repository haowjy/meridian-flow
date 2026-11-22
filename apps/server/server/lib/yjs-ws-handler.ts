/** Hocuspocus-backed Yjs gateway orchestration behind the thin CrossWS route. */
import { Hocuspocus, type WebSocketLike } from "@hocuspocus/server";
import { isSchemaRepairUpdate } from "@meridian/agent-edit";
import { isDocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import {
  accessChangedClose,
  encodeReadOnlyWsMessage,
  parseYjsRoomName,
  WS_CLOSE,
} from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  clientSchemaVersionFromSubprotocolHeader,
  headAdmitsClient,
  serverServesHead,
} from "@meridian/prosemirror-schema";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  type AdmitLiveWriterUpdateResult,
  isDocumentSchemaMajorMismatchError,
} from "../domains/collab/index.js";
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
import {
  createRoomAccessIndex as createYjsRoomAccessIndex,
  type RoomAccessIndex as YjsRoomAccessIndex,
  type RoomRegistration as YjsRoomRegistration,
} from "./room-access.js";

type HocuspocusConnection = ReturnType<Hocuspocus["handleConnection"]>;

export type YjsGatewayPeer = {
  request: Request;
  userId: UserId;
  traceId: string;
  socket: WebSocketLike;
  close(code?: number, reason?: string): void;
};

export type YjsGatewayConnection = {
  hocuspocus: HocuspocusConnection;
  registration: YjsRoomRegistration;
};

export type YjsGatewayServices = {
  fileAccess: Pick<AppServices["fileAccess"], "authorize" | "historyAccess">;
  fileAccessChanges: Pick<FileAccessChanges, "subscribe">;
  documentSync: AppServices["documentSync"];
  eventSink: AppServices["eventSink"];
};

type TreeYjsRoom = Extract<NonNullable<ReturnType<typeof parseYjsRoomName>>, { kind: "tree" }>;
/** A document's room: what every hook below asks the file policy about. */
type ParsedYjsRoom = Exclude<NonNullable<ReturnType<typeof parseYjsRoomName>>, TreeYjsRoom>;
type SchemaAdmissionRefusal =
  | typeof WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED
  | typeof WS_CLOSE.DOCUMENT_SCHEMA_STALE;

/**
 * What the person may do in the room (file-access §7), decided when the socket opens; it ends
 * when `rooms` closes the socket.
 */
type YjsRoomAccess = { level: "read"; why?: ClosedOwnerWhy } | { level: "edit" };

type YjsConnectionAdmission =
  | {
      kind: "allowed";
      documentId: DocumentId;
      /** The file the room serves, asked again once the room is registered. */
      fileTarget: FileTarget;
      access: YjsRoomAccess;
      /** The owners whose lifecycle decides this access: the file's owner, the draft's owner (its `ownerAccessKey`). */
      accessKeys: string[];
    }
  | {
      kind: "refused";
      close: SchemaAdmissionRefusal;
      documentId: DocumentId;
      clientSchemaVersion: CollabSchemaVersion;
      headSchemaVersion: CollabSchemaVersion;
      serverSchemaVersion: CollabSchemaVersion;
    };

type YjsConnectionContext = {
  userId: UserId;
  traceId: string;
  clientSchemaVersion: CollabSchemaVersion;
  admittedDocumentId?: DocumentId;
  access?: YjsRoomAccess;
  registration: YjsRoomRegistration;
  closeTransport(input: { code: number; reason: string }): void;
};

export function clientSchemaVersionFromRequest(request: Request): CollabSchemaVersion {
  return clientSchemaVersionFromSubprotocolHeader(request.headers.get("sec-websocket-protocol"));
}

function permissionDenied(
  reason: string,
  code?: number,
): Error & { reason: string; code?: number } {
  const error = new Error(reason) as Error & { reason: string; code?: number };
  error.reason = reason;
  if (code !== undefined) error.code = code;
  return error;
}

type RoomClose = { code: number; reason: string };

/**
 * A refusal that closes the transport with its own code. Thrown, never sent here:
 * `withRemovalRefusal` sends it, or `4208` in its place when the room's document was removed.
 */
class RoomRefusal extends Error {
  readonly code: number;
  readonly reason: string;
  constructor(
    readonly close: RoomClose,
    cause?: unknown,
  ) {
    super(close.reason, { cause });
    this.code = close.code;
    this.reason = close.reason;
  }
}

function refuse(close: RoomClose, cause?: unknown): never {
  throw new RoomRefusal(close, cause);
}

/**
 * Every room hook that refuses passes here, so whether a refusal is a removal is decided in
 * one place, with authorization. A refusal caused by a removal, or any refusal of a room whose
 * document was removed when the principal may read that document's history, closes
 * `4208 document-deleted`, terminal; any other refusal sends its own close, if it has one. A
 * principal who can't read the document learns nothing of its removal.
 */
async function withRemovalRefusal<T>(
  services: Pick<YjsGatewayServices, "documentSync" | "fileAccess">,
  room: ParsedYjsRoom,
  userId: UserId,
  context: { closeTransport?(close: RoomClose): void },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const removed = await removedForReader(services, room, userId, cause).catch(
      // A failed probe never hides the refusal it was asked about.
      () => false,
    );
    const close = removed
      ? WS_CLOSE.DOCUMENT_DELETED
      : cause instanceof RoomRefusal
        ? cause.close
        : null;
    if (!close) throw cause;
    context.closeTransport?.(close);
    throw permissionDenied(close.reason, close.code);
  }
}

async function removedForReader(
  services: Pick<YjsGatewayServices, "documentSync" | "fileAccess">,
  room: ParsedYjsRoom,
  userId: UserId,
  cause: unknown,
): Promise<boolean> {
  // Raised only past the room's admission: the principal already reached the document, and
  // the write was refused under its mutation lock, so nothing was journaled.
  const refused = cause instanceof RoomRefusal ? cause.cause : cause;
  if (isDocumentNotFoundError(refused) && refused.removal) return true;
  const removed = await services.documentSync.roomRemoval(room.documentId);
  return (
    removed !== null &&
    (await services.fileAccess.historyAccess({ accountId: userId }, removed.documentId)) ===
      "deleted"
  );
}

function refuseSchemaAdmission(input: {
  services: Pick<YjsGatewayServices, "eventSink">;
  roomKey: string;
  documentId: DocumentId;
  close: SchemaAdmissionRefusal;
  clientSchemaVersion: CollabSchemaVersion;
  headSchemaVersion: CollabSchemaVersion;
  serverSchemaVersion: CollabSchemaVersion;
}): never {
  const {
    services,
    roomKey,
    documentId,
    close,
    clientSchemaVersion,
    headSchemaVersion,
    serverSchemaVersion,
  } = input;
  try {
    emitEvent(services.eventSink, {
      level: close.code === WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.code ? "info" : "error",
      source: "collab.schema",
      name: "admission.refused",
      correlation: { documentId },
      payload: {
        code: close.code,
        reason: close.reason,
        roomKey,
        clientSchemaVersion,
        headSchemaVersion,
        serverSchemaVersion,
      },
    });
  } finally {
    refuse(close);
  }
}

function parseAnyRoomOrDeny(documentName: string) {
  const room = parseYjsRoomName(documentName);
  if (!room) throw permissionDenied("invalid-room");
  return room;
}

/** A document's room; a tree list's room is the caller's to branch on first. */
function parseRoomOrDeny(documentName: string): ParsedYjsRoom {
  const room = parseAnyRoomOrDeny(documentName);
  if (room.kind === "tree") throw permissionDenied("invalid-room");
  return room;
}

/**
 * Room admission asks the file policy (file-access §7): `edit`, `read`, or
 * refused with the terminal `permission-denied`.
 */
async function _roomAccess(
  services: YjsGatewayServices,
  userId: UserId,
  target: FileTarget,
): Promise<{ access: YjsRoomAccess; facts: FileFacts }> {
  const admitted = await findRoomAccess(services, userId, target);
  if (!admitted) throw permissionDenied("permission-denied");
  return admitted;
}

async function findRoomAccess(
  services: YjsGatewayServices,
  userId: UserId,
  target: FileTarget,
): Promise<{ access: YjsRoomAccess; facts: FileFacts } | null> {
  const edit = await services.fileAccess.authorize({ accountId: userId }, target, "edit");
  if (!isFileAccessDenied(edit)) return { access: { level: "edit" }, facts: edit.facts };
  if (edit.level !== "read" || !edit.facts) return null;
  return { access: { level: "read", why: closedOwnerWhy(edit.facts) }, facts: edit.facts };
}

async function classifyYjsConnectionAdmission(input: {
  services: YjsGatewayServices;
  room: ParsedYjsRoom;
  userId: UserId;
  clientSchemaVersion: CollabSchemaVersion;
}): Promise<YjsConnectionAdmission> {
  const { services, room, userId, clientSchemaVersion } = input;
  const { documentId } = room;
  // A document in Trash still takes text until its node is purged, so the room reads
  // through Trash like a restore; a purged or unplaced document has no facts and is refused.
  let fileTarget: FileTarget = { kind: "restore", documentId };
  let found = await findRoomAccess(services, userId, fileTarget);
  // A document only a draft holds is Live text that draft's view reads.
  for (const draftId of found ? [] : await services.documentSync.draftsHolding(documentId)) {
    const target: FileTarget = { kind: "draft", documentId, draftId };
    found = await findRoomAccess(services, userId, target);
    if (found) {
      fileTarget = target;
      break;
    }
  }
  if (!found) {
    // A browser connects as soon as it appends a document's `create`, which the server may not
    // have admitted yet: it retries. A purged document is refused for good.
    if (await services.documentSync.roomRemoval(documentId))
      throw permissionDenied("permission-denied");
    refuse(WS_CLOSE.DOCUMENT_UNKNOWN);
  }
  const admitted = found;
  const headSchemaVersion = await services.documentSync.headSchemaVersion(documentId);
  if (headSchemaVersion !== null && !serverServesHead(headSchemaVersion, COLLAB_SCHEMA_VERSION)) {
    return {
      kind: "refused",
      close: WS_CLOSE.DOCUMENT_SCHEMA_STALE,
      documentId,
      clientSchemaVersion,
      headSchemaVersion,
      serverSchemaVersion: COLLAB_SCHEMA_VERSION,
    };
  }
  if (headSchemaVersion !== null && !headAdmitsClient(clientSchemaVersion, headSchemaVersion)) {
    return {
      kind: "refused",
      close: WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED,
      documentId,
      clientSchemaVersion,
      headSchemaVersion,
      serverSchemaVersion: COLLAB_SCHEMA_VERSION,
    };
  }

  return {
    kind: "allowed",
    documentId,
    fileTarget,
    access: admitted.access,
    accessKeys: accessKeys(admitted.facts, documentId),
  };
}

/** Why the file's owner is closed, if it is: the 4409 reason a writer typing into it is told. */
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
 * document itself: access is decided once, when the socket opens, so every change that can end
 * it must reach a key the socket is under.
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

export async function admitWriterSync(input: {
  services: YjsGatewayServices;
  documentName: string;
  document: Y.Doc;
  syncType: number;
  payload: Uint8Array;
  userId: UserId;
}): Promise<AdmitLiveWriterUpdateResult | undefined> {
  const room = parseRoomOrDeny(input.documentName);
  const { services, document } = input;
  if (!carriesUpdate(input.syncType, input.payload)) return;
  const origin = writerOrigin(input);
  try {
    return await services.documentSync.admitLiveWriterUpdate({
      documentId: room.documentId,
      document,
      update: input.payload,
      origin,
    });
  } catch (cause) {
    refuseWriterSync(input, room, cause);
  }
}

/** The client reconnects and its handshake carries what the journal lacks. */
function refuseWriterSync(
  input: Pick<Parameters<typeof admitWriterSync>[0], "services" | "syncType">,
  room: ParsedYjsRoom,
  cause: unknown,
): never {
  emitEvent(input.services.eventSink, {
    level: "warn",
    source: "collab.hocuspocus",
    name: "writer_admission.refused",
    correlation: { documentId: room.documentId },
    payload: {
      syncType: input.syncType,
      ...unknownToEventPayload(cause),
      ...errorMessageOf(cause),
    },
  });
  refuse(WS_CLOSE.WRITER_ADMISSION_FAILED, cause);
}

type WriterSyncInput = Pick<
  Parameters<typeof admitWriterSync>[0],
  "document" | "payload" | "userId"
>;

const documentSchema = buildDocumentSchema();

/** The binding's schema repair is nobody's edit: the journal stores it under no name. */
function writerOrigin(input: WriterSyncInput) {
  return isSchemaRepairUpdate(input.document, input.payload, documentSchema)
    ? ({ type: "system" } as const)
    : ({ type: "user", userId: input.userId } as const);
}

function carriesUpdate(syncType: number, payload: Uint8Array): boolean {
  return (syncType === messageYjsSyncStep2 || syncType === messageYjsUpdate) && payload.length > 0;
}

function assertAdmittedForSync(context: YjsConnectionContext, documentName: string): void {
  if (context.admittedDocumentId !== parseRoomOrDeny(documentName).documentId) {
    throw permissionDenied("permission-denied");
  }
}

export function createHocuspocus(
  services: YjsGatewayServices,
  rooms: YjsRoomAccessIndex,
): Hocuspocus<YjsConnectionContext> {
  const hocuspocus = new Hocuspocus<YjsConnectionContext>({
    name: "meridian-yjs",
    yDocOptions: { gc: false, gcFilter: () => true },
    debounce: 2000,
    maxDebounce: 10000,
    async onConnect({ documentName, context, connectionConfig }) {
      return runWithEventCorrelation({ traceId: context.traceId }, async () => {
        const userId = context.userId;
        if (!userId) throw permissionDenied("permission-denied");

        const anyRoom = parseAnyRoomOrDeny(documentName);
        // A tree list's room is on `/ws/loro`.
        if (anyRoom.kind === "tree") throw permissionDenied("invalid-room");
        const room = anyRoom;
        await withRemovalRefusal(services, room, userId, context, async () => {
          const admission = await classifyYjsConnectionAdmission({
            services,
            room,
            userId,
            clientSchemaVersion: context.clientSchemaVersion,
          });
          if (admission.kind === "refused") {
            refuseSchemaAdmission({
              services,
              roomKey: documentName,
              ...admission,
            });
          }
          context.admittedDocumentId = admission.documentId;
          context.access = admission.access;
          // Hocuspocus sends this as the authenticated scope: `readonly` or `read-write`.
          connectionConfig.readOnly = admission.access.level === "read";
          rooms.register(context.registration, admission.accessKeys);
          // A change between admission and registration reached no room. Registered now, the
          // room hears every later change; ask once more, and refuse when the level or the
          // owners the socket should be under differ (a document moved to another Work).
          const settled = await findRoomAccess(services, userId, admission.fileTarget);
          if (
            !settled ||
            settled.access.level !== admission.access.level ||
            accessKeys(settled.facts, admission.documentId).join() !== admission.accessKeys.join()
          )
            refuse(accessChangedClose(closedOwnerWhy(settled?.facts)));
        });
      });
    },
    async beforeHandleMessage({ context }) {
      return runWithEventCorrelation({ traceId: context.traceId }, async () => {
        const userId = context.userId;
        if (!userId) throw permissionDenied("permission-denied");
      });
    },
    async beforeSync({ documentName, document, type, payload, context }) {
      return runWithEventCorrelation({ traceId: context.traceId }, async () => {
        const userId = context.userId;
        if (!userId) throw permissionDenied("permission-denied");
        const anyRoom = parseAnyRoomOrDeny(documentName);
        if (anyRoom.kind === "tree") throw permissionDenied("invalid-room");
        const room = anyRoom;
        await withRemovalRefusal(services, room, userId, context, async () => {
          assertAdmittedForSync(context, documentName);
          const access = context.access;
          if (!access) throw permissionDenied("permission-denied");
          // Runs before Hocuspocus's own read-only check: a read connection's
          // update must not reach the journal. Hocuspocus then drops it and
          // answers SyncStatus(false).
          if (
            access.level === "read" &&
            (type === messageYjsSyncStep2 || type === messageYjsUpdate)
          ) {
            return;
          }
          // A frame is judged in the room and stored with one insert; the connection's access
          // was decided when the socket opened and ends when `rooms` closes the socket.
          await admitWriterSync({
            services,
            documentName,
            document,
            syncType: type,
            payload,
            userId,
          });
        });
      });
    },
    async onLoadDocument({ documentName, document, context }) {
      return runWithEventCorrelation({ traceId: context.traceId }, async () => {
        const anyRoom = parseAnyRoomOrDeny(documentName);
        if (anyRoom.kind === "tree") throw permissionDenied("invalid-room");
        const room = anyRoom;
        await withRemovalRefusal(services, room, context.userId, context, async () => {
          let state: Uint8Array | undefined;
          try {
            state = await services.documentSync.loadHocuspocusDocument(room.documentId, document);
          } catch (cause) {
            if (!isDocumentSchemaMajorMismatchError(cause)) throw cause;
            refuseSchemaAdmission({
              services,
              roomKey: documentName,
              documentId: cause.docId as DocumentId,
              close: WS_CLOSE.DOCUMENT_SCHEMA_STALE,
              clientSchemaVersion: context.clientSchemaVersion,
              headSchemaVersion: cause.storedVersion,
              serverSchemaVersion: cause.expectedVersion,
            });
          }
          if (state) Y.applyUpdate(document, state);
        });
      });
    },
    async afterLoadDocument({ documentName, document }) {
      const room = parseAnyRoomOrDeny(documentName);
      if (room.kind === "live")
        await services.documentSync.validateHocuspocusDocument(room.documentId, document);
    },
    async connected({ documentName, connection, context }) {
      const room = parseAnyRoomOrDeny(documentName);
      if (room.kind === "tree") return;
      // The authenticated scope says `readonly`; this says why (for a closed owner), so the client never has to guess.
      if (context.access?.level === "read")
        connection.sendStateless(encodeReadOnlyWsMessage(context.access.why));
      // This hook's refusal also closes the connection Hocuspocus has already made.
      const closing = {
        closeTransport(close: RoomClose) {
          context.closeTransport?.(close);
          connection.close(close);
        },
      };
      await withRemovalRefusal(services, room, context.userId, closing, async () => {
        try {
          // A retired room can finish loading after its connections were closed. Validate
          // after connection creation too, so the late join is closed and retries.
          await services.documentSync.validateHocuspocusDocument(
            room.documentId,
            connection.document,
          );
        } catch (cause) {
          refuse({ code: 1013, reason: "retired-durable-authority" }, cause);
        }
      });
    },
    async onStoreDocument({ documentName, document }) {
      const room = parseAnyRoomOrDeny(documentName);
      if (room.kind === "tree") return;
      return runWithEventCorrelation(
        {
          traceId: crypto.randomUUID(),
        },
        () => services.documentSync.storeHocuspocusDocument(room.documentId, document),
      );
    },
  });
  services.documentSync.bindHocuspocus(hocuspocus);
  return hocuspocus;
}

export function createYjsGateway(services: YjsGatewayServices) {
  let acceptingConnections = true;
  const rooms = createYjsRoomAccessIndex();
  const hocuspocus = createHocuspocus(services, rooms);
  const unsubscribe = services.fileAccessChanges.subscribe((change) =>
    rooms.revokeOwner(fileAccessChangeKey(change), "closed" in change ? change.closed : undefined),
  );

  function closeConnection(
    connection: YjsGatewayConnection,
    event: { code: number; reason: string },
  ) {
    rooms.unregister(connection.registration);
    // Hocuspocus unloads the room once its last connection is gone.
    connection.hocuspocus.handleClose(event);
  }

  return {
    hocuspocus,

    connect(peer: YjsGatewayPeer): YjsGatewayConnection | undefined {
      if (!acceptingConnections) {
        peer.close(1012, "server-shutdown");
        return;
      }

      const registration: YjsRoomRegistration = { revoke: () => undefined };
      const connection: YjsGatewayConnection = {
        registration,
        hocuspocus: hocuspocus.handleConnection(peer.socket, peer.request, {
          userId: peer.userId,
          traceId: peer.traceId,
          clientSchemaVersion: clientSchemaVersionFromRequest(peer.request),
          registration,
          closeTransport: ({ code, reason }: { code: number; reason: string }) =>
            peer.close(code, reason),
        }),
      };
      registration.revoke = (why) => {
        // Close the socket first, so Hocuspocus's own protocol CLOSE (which the
        // provider reports as 1000) never reaches the client ahead of 4409.
        const close = accessChangedClose(why);
        peer.close(close.code, close.reason);
        closeConnection(connection, close);
      };
      return connection;
    },

    message(connection: YjsGatewayConnection | undefined, message: Uint8Array): void {
      connection?.hocuspocus.handleMessage(message);
    },

    close(
      connection: YjsGatewayConnection | undefined,
      event?: { code?: number; reason?: string },
    ): void {
      if (!connection) return;
      closeConnection(connection, { code: event?.code ?? 1000, reason: event?.reason ?? "close" });
    },

    error(connection: YjsGatewayConnection | undefined): void {
      if (!connection) return;
      closeConnection(connection, { code: 1011, reason: "error" });
    },

    async drain(): Promise<void> {
      acceptingConnections = false;
      unsubscribe();
      hocuspocus.closeConnections();
      emitEvent(services.eventSink, {
        level: "info",
        source: "collab.hocuspocus",
        name: "persistence_queue.drain",
        payload: services.documentSync.getPersistenceQueueMetrics(),
      });
      await services.documentSync.drainHocuspocusPersistence();
    },
  };
}

export type YjsGateway = ReturnType<typeof createYjsGateway>;

export function selectYjsGatewayServices(app: AppServices): YjsGatewayServices {
  return {
    fileAccess: app.fileAccess,
    fileAccessChanges: app.fileAccessChanges,
    documentSync: app.documentSync,
    eventSink: app.eventSink,
  };
}

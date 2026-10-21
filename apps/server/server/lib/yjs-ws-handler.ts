/** Hocuspocus-backed Yjs gateway orchestration behind the thin CrossWS route. */
import { Hocuspocus, type WebSocketLike } from "@hocuspocus/server";
import { isDocumentNotFoundError } from "@meridian/agent-edit/integration";
import { parseYjsRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import type { DocumentId, UserId, WorkId } from "@meridian/contracts/runtime";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  clientSchemaVersionFromSubprotocolHeader,
  headAdmitsClient,
  serverServesHead,
} from "@meridian/prosemirror-schema";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  type AdmitLiveWriterUpdateResult,
  DraftPrefixMissingError,
  DraftStaleUpdateError,
  isDocumentSchemaMajorMismatchError,
} from "../domains/collab/index.js";
import { LIVE_TREE, type TreeReader } from "../domains/context/tree/tree-view.js";
import {
  type FileAccessChanges,
  FileEditRefusedError,
  type FileFacts,
  type FileGrant,
  type FileTarget,
  grantWorkIds,
  isFileAccessDenied,
  runWithEditGrants,
} from "../domains/file-policy/index.js";
import {
  emitEvent,
  runWithEventCorrelation,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import type { AppServices } from "./app.js";
import {
  createYjsRoomAccessIndex,
  type YjsRoomAccessIndex,
  type YjsRoomRegistration,
} from "./yjs-room-access.js";
export type DraftHandshakeState = "pending" | "passed" | "rejected";

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
  draftSyncState: Map<string, DraftHandshakeState>;
  registration: YjsRoomRegistration;
};

export type YjsGatewayServices = {
  liveDocuments: Pick<TreeReader, "findById">;
  fileAccess: Pick<AppServices["fileAccess"], "authorize" | "confirmEdit" | "historyAccess">;
  fileAccessChanges: Pick<FileAccessChanges, "subscribe">;
  documentSync: AppServices["documentSync"];
  eventSink: AppServices["eventSink"];
};

type ParsedYjsRoom = NonNullable<ReturnType<typeof parseYjsRoomName>>;
type SchemaAdmissionRefusal =
  | typeof WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED
  | typeof WS_CLOSE.DOCUMENT_SCHEMA_STALE;

type YjsAdmissionTarget =
  | {
      kind: "live";
      documentId: DocumentId;
      liveGeneration: bigint;
    }
  | {
      kind: "draft";
      draftId: Extract<ParsedYjsRoom, { kind: "draft" }>["draftId"];
      documentId: DocumentId;
    };

/**
 * What the person may do in the room (file-access §7). An `edit` connection
 * holds its grant for the session and every frame confirms it.
 */
type YjsRoomAccess = { level: "read" } | { level: "edit"; grant: FileGrant<"edit"> };

type YjsConnectionAdmission =
  | {
      kind: "allowed";
      target: YjsAdmissionTarget;
      /** The file the room serves, asked again once the room is registered. */
      fileTarget: FileTarget;
      access: YjsRoomAccess;
      /** The Works whose lifecycle decides this access: the file's owner, the draft's origin Work. */
      accessWorkIds: WorkId[];
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
  draftSyncState: Map<string, DraftHandshakeState>;
  admissionTarget?: YjsAdmissionTarget;
  access?: YjsRoomAccess;
  registration: YjsRoomRegistration;
  closeTransport(input: { code: number; reason: string }): void;
};

export function clientSchemaVersionFromRequest(request: Request): CollabSchemaVersion {
  return clientSchemaVersionFromSubprotocolHeader(request.headers.get("sec-websocket-protocol"));
}

export async function hasLiveDocument(
  tree: Pick<TreeReader, "findById">,
  documentId: DocumentId,
): Promise<boolean> {
  return (await tree.findById(LIVE_TREE, documentId)).kind === "found";
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
  const removed = await services.documentSync.roomRemoval(
    room.kind === "live" ? { documentId: room.documentId } : { draftId: room.draftId },
  );
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

function parseRoomOrDeny(documentName: string) {
  const room = parseYjsRoomName(documentName);
  if (!room) throw permissionDenied("invalid-room");
  return room;
}

/**
 * Room admission asks the file policy (file-access §7): `edit`, `read`, or
 * refused with the terminal `permission-denied`.
 */
async function roomAccess(
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
  if (!isFileAccessDenied(edit))
    return { access: { level: "edit", grant: edit }, facts: edit.facts };
  if (edit.level !== "read" || !edit.facts) return null;
  return { access: { level: "read" }, facts: edit.facts };
}

async function classifyYjsConnectionAdmission(input: {
  services: YjsGatewayServices;
  room: ParsedYjsRoom;
  userId: UserId;
  clientSchemaVersion: CollabSchemaVersion;
}): Promise<YjsConnectionAdmission> {
  const { services, room, userId, clientSchemaVersion } = input;
  let documentId: DocumentId;
  let headSchemaVersion: CollabSchemaVersion | null;
  let admitted: Awaited<ReturnType<typeof roomAccess>>;
  let fileTarget: FileTarget;

  if (room.kind === "live") {
    documentId = room.documentId;
    fileTarget = { kind: "document", documentId };
    // The file policy denies a removed document; `withRemovalRefusal` answers it.
    admitted = await roomAccess(services, userId, fileTarget);
    if (!(await hasLiveDocument(services.liveDocuments, documentId))) {
      throw permissionDenied("permission-denied");
    }
    // The room's explicit touch: a living document missing its authority is repaired from
    // its projection before the first generation read, which never creates one.
    await services.documentSync.repairDocumentAuthority(documentId);
    headSchemaVersion = await services.documentSync.headSchemaVersion(documentId);
  } else {
    const documentDraft = await services.documentSync.resolveDraftHocuspocusRoom(room.draftId);
    if (!documentDraft) refuse(WS_CLOSE.DRAFT_CLOSED);
    documentId = documentDraft.documentId;
    headSchemaVersion = documentDraft.schemaVersion;
    fileTarget = { kind: "draft", documentId, workId: documentDraft.workId };
    admitted = await roomAccess(services, userId, fileTarget);
  }
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

  const access = {
    fileTarget,
    access: admitted.access,
    accessWorkIds: grantWorkIds(admitted.facts),
  };
  if (room.kind === "live") {
    return {
      kind: "allowed",
      target: {
        kind: "live",
        documentId,
        liveGeneration: await services.documentSync.currentLiveGeneration(documentId),
      },
      ...access,
    };
  }
  return {
    kind: "allowed",
    ...access,
    target: {
      kind: "draft",
      draftId: room.draftId,
      documentId,
    },
  };
}

async function enforceDraftHandshake(input: {
  services: YjsGatewayServices;
  document: Y.Doc;
  room: Extract<ReturnType<typeof parseRoomOrDeny>, { kind: "draft" }>;
  syncType: number;
  payload: Uint8Array;
  context?: { draftSyncState?: Map<string, DraftHandshakeState> };
}): Promise<void> {
  const key = input.room.draftId;
  if (input.syncType === messageYjsSyncStep1) {
    const active = await input.services.documentSync.reconcileHocuspocusDraftRoom({
      draftId: input.room.draftId,
      room: input.document,
    });
    if (input.context?.draftSyncState?.get(key) === "rejected") {
      refuse(WS_CLOSE.DRAFT_PREFIX_MISSING);
    }
    if (!active) {
      input.context?.draftSyncState?.set(key, "rejected");
      refuse(WS_CLOSE.DRAFT_CLOSED);
    }
    input.context?.draftSyncState?.set(key, "passed");
    return;
  }
  if (input.syncType !== messageYjsSyncStep2 && input.syncType !== messageYjsUpdate) return;
  const state = input.context?.draftSyncState?.get(key) ?? "pending";
  if (state === "passed") return;
  input.context?.draftSyncState?.set(key, "rejected");
  refuse(WS_CLOSE.DRAFT_PREFIX_MISSING);
}

export async function admitWriterSync(input: {
  services: YjsGatewayServices;
  documentName: string;
  document: Y.Doc;
  syncType: number;
  payload: Uint8Array;
  userId: UserId;
  expectedGeneration?: bigint;
  context?: {
    draftSyncState?: Map<string, DraftHandshakeState>;
  };
}): Promise<AdmitLiveWriterUpdateResult | undefined> {
  const room = parseRoomOrDeny(input.documentName);
  if (room.kind === "draft") {
    return admitDraftSync(input, room);
  }
  return admitLiveSync(input, room);
}

type WriterSyncInput = Parameters<typeof admitWriterSync>[0];

function carriesUpdate(syncType: number, payload: Uint8Array): boolean {
  return (syncType === messageYjsSyncStep2 || syncType === messageYjsUpdate) && payload.length > 0;
}

async function admitDraftSync(
  input: WriterSyncInput,
  room: Extract<ReturnType<typeof parseRoomOrDeny>, { kind: "draft" }>,
): Promise<undefined> {
  await enforceDraftHandshake({
    services: input.services,
    document: input.document,
    room,
    syncType: input.syncType,
    payload: input.payload,
    context: input.context,
  });
  if (!carriesUpdate(input.syncType, input.payload)) return;
  // A draft room is a collaborative room like any other: the writer is
  // one more peer in it. Client frames run the same durable admission the
  // agent's own draft writes do.
  try {
    await input.services.documentSync.admitDraftWriterUpdate({
      draftId: room.draftId,
      update: input.payload,
      origin: { type: "user", userId: input.userId },
      document: input.document,
    });
    return;
  } catch (cause) {
    // The bound edit grant was refused under the seam's locks; `beforeSync` answers it.
    if (cause instanceof FileEditRefusedError) throw cause;
    // Not a refusal (D30): the client reconnects and its handshake carries the missing prefix.
    if (cause instanceof DraftPrefixMissingError) refuse(WS_CLOSE.DRAFT_PREFIX_MISSING, cause);
    if (cause instanceof DraftStaleUpdateError) {
      if (!(await input.services.documentSync.resolveDraftHocuspocusRoom(room.draftId)))
        refuse(WS_CLOSE.DRAFT_CLOSED, cause);
      refuse(WS_CLOSE.ACCESS_CHANGED, cause);
    }
    refuse({ code: 1008, reason: "draft-update-admission-failed" }, cause);
  }
}

async function admitLiveSync(
  input: WriterSyncInput,
  room: Extract<ReturnType<typeof parseRoomOrDeny>, { kind: "live" }>,
): Promise<AdmitLiveWriterUpdateResult | undefined> {
  if (!carriesUpdate(input.syncType, input.payload)) return;
  if (input.expectedGeneration === undefined) {
    throw permissionDenied("permission-denied");
  }
  try {
    const admission = await input.services.documentSync.admitLiveWriterUpdate({
      documentId: room.documentId,
      document: input.document,
      update: input.payload,
      origin: { type: "user", userId: input.userId },
      expectedGeneration: input.expectedGeneration,
    });
    return admission;
  } catch (cause) {
    // The bound edit grant was refused under the seam's locks; `beforeSync` answers it.
    if (cause instanceof FileEditRefusedError) throw cause;
    refuse({ code: 1013, reason: "writer-journal-admission-failed" }, cause);
  }
}

function admittedTargetForSync(
  context: YjsConnectionContext,
  documentName: string,
): YjsAdmissionTarget {
  const target = context.admissionTarget;
  const room = parseRoomOrDeny(documentName);
  if (
    !target ||
    (room.kind === "live" && (target.kind !== "live" || target.documentId !== room.documentId)) ||
    (room.kind === "draft" && (target.kind !== "draft" || target.draftId !== room.draftId))
  ) {
    throw permissionDenied("permission-denied");
  }
  return target;
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

        const room = parseRoomOrDeny(documentName);
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
          context.admissionTarget = admission.target;
          context.access = admission.access;
          // Hocuspocus sends this as the authenticated scope: `readonly` or `read-write`.
          connectionConfig.readOnly = admission.access.level === "read";
          rooms.register(context.registration, admission.accessWorkIds);
          // A Work change between admission and registration reached no room.
          // Registered now, the room hears every later change; ask once more.
          const settled = await findRoomAccess(services, userId, admission.fileTarget);
          if (settled?.access.level !== admission.access.level) refuse(WS_CLOSE.ACCESS_CHANGED);

          if (admission.target.kind === "draft") {
            const target = admission.target;
            // Do not delay room admission: a cold room may briefly render its persisted
            // state before this pull arrives. A pull that commits while the room loads is
            // brought in by the room's enrollment once Hocuspocus registers it.
            void services.documentSync
              .flushDraftLivePull(target.documentId)
              .catch((cause: unknown) => {
                emitEvent(services.eventSink, {
                  level: "warn",
                  source: "collab.hocuspocus",
                  name: "draft_review.live_pull_failed",
                  correlation: { documentId: target.documentId, draftId: target.draftId },
                  payload: unknownToEventPayload(cause),
                });
              });
          }
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
        const room = parseRoomOrDeny(documentName);
        await withRemovalRefusal(services, room, userId, context, async () => {
          const target = admittedTargetForSync(context, documentName);
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
          const admit = () =>
            admitWriterSync({
              services,
              documentName,
              document,
              syncType: type,
              payload,
              userId,
              expectedGeneration: target.kind === "live" ? target.liveGeneration : undefined,
              context,
            });
          if (access.level === "read") {
            await admit();
            return;
          }
          const admitted = await runWithEditGrants(services.fileAccess, [access.grant], admit);
          if (!admitted.ok) refuse(WS_CLOSE.ACCESS_CHANGED);
        });
      });
    },
    async onLoadDocument({ documentName, document, context }) {
      return runWithEventCorrelation({ traceId: context.traceId }, async () => {
        const room = parseRoomOrDeny(documentName);
        await withRemovalRefusal(services, room, context.userId, context, async () => {
          let state: Uint8Array | undefined;
          try {
            state =
              room.kind === "live"
                ? await services.documentSync.loadHocuspocusDocument(room.documentId, document)
                : (await services.documentSync.loadHocuspocusDraftState(room.draftId))?.state;
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
          if (!state && room.kind === "draft") refuse(WS_CLOSE.DRAFT_CLOSED);
          if (state) Y.applyUpdate(document, state);
          if (room.kind === "live") services.documentSync.primeReservedNamespaceIndex(document);
        });
      });
    },
    async afterLoadDocument({ documentName, document }) {
      const room = parseRoomOrDeny(documentName);
      if (room.kind === "live") {
        await services.documentSync.validateHocuspocusDocument(room.documentId, document);
        return;
      }
      // Not awaited: Hocuspocus registers the room only after this hook returns.
      services.documentSync.enrollHocuspocusDraftRoom({
        draftId: room.draftId,
        document,
      });
    },
    async connected({ documentName, connection, context }) {
      const room = parseRoomOrDeny(documentName);
      // This hook's refusal also closes the connection Hocuspocus has already made.
      const closing = {
        closeTransport(close: RoomClose) {
          context.closeTransport?.(close);
          connection.close(close);
        },
      };
      await withRemovalRefusal(services, room, context.userId, closing, async () => {
        if (room.kind === "draft") {
          // A close can commit between admission and registration; the ended draft
          // must not take a late connection.
          if (!(await services.documentSync.resolveDraftHocuspocusRoom(room.draftId)))
            refuse(WS_CLOSE.DRAFT_CLOSED);
          return;
        }
        try {
          // The room can finish loading after restore's disconnection. Validate
          // after connection creation too, so the late join is closed and retries.
          await services.documentSync.validateHocuspocusDocument(
            room.documentId,
            connection.document,
          );
        } catch (cause) {
          refuse({ code: 1013, reason: "retired-durable-authority-generation" }, cause);
        }
      });
    },
    async onStoreDocument({ documentName, document }) {
      const room = parseRoomOrDeny(documentName);
      return runWithEventCorrelation(
        {
          traceId: crypto.randomUUID(),
        },
        async () => {
          if (room.kind === "live") {
            await services.documentSync.storeHocuspocusDocument(room.documentId, document);
            return;
          }
          await services.documentSync.storeHocuspocusDraft(room.draftId, document);
        },
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
  const unsubscribe = services.fileAccessChanges.subscribe(({ workId }) =>
    rooms.revokeWork(workId),
  );

  function closeConnection(
    connection: YjsGatewayConnection,
    event: { code: number; reason: string },
  ) {
    rooms.unregister(connection.registration);
    // Hocuspocus unloads the room once its last connection is gone.
    connection.hocuspocus.handleClose(event);
    connection.draftSyncState.clear();
  }

  return {
    hocuspocus,

    connect(peer: YjsGatewayPeer): YjsGatewayConnection | undefined {
      if (!acceptingConnections) {
        peer.close(1012, "server-shutdown");
        return;
      }

      const registration: YjsRoomRegistration = { revoke: () => undefined };
      const draftSyncState = new Map<string, DraftHandshakeState>();
      const connection: YjsGatewayConnection = {
        draftSyncState,
        registration,
        hocuspocus: hocuspocus.handleConnection(peer.socket, peer.request, {
          userId: peer.userId,
          traceId: peer.traceId,
          clientSchemaVersion: clientSchemaVersionFromRequest(peer.request),
          draftSyncState,
          registration,
          closeTransport: ({ code, reason }: { code: number; reason: string }) =>
            peer.close(code, reason),
        }),
      };
      registration.revoke = () => {
        // Close the socket first, so Hocuspocus's own protocol CLOSE (which the
        // provider reports as 1000) never reaches the client ahead of 4409.
        peer.close(WS_CLOSE.ACCESS_CHANGED.code, WS_CLOSE.ACCESS_CHANGED.reason);
        closeConnection(connection, WS_CLOSE.ACCESS_CHANGED);
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
    liveDocuments: app.liveDocuments,
    fileAccess: app.fileAccess,
    fileAccessChanges: app.fileAccessChanges,
    documentSync: app.documentSync,
    eventSink: app.eventSink,
  };
}

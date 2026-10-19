/** Hocuspocus-backed Yjs gateway orchestration behind the thin CrossWS route. */
import {
  Hocuspocus,
  isTransactionOrigin,
  type TransactionOrigin,
  type WebSocketLike,
} from "@hocuspocus/server";
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
  isDocumentSchemaMajorMismatchError,
  type UpdateOrigin,
} from "../domains/collab/index.js";
import { DocumentRemovedError } from "../domains/context/index.js";
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
  offlineSyncUpdates: Set<string>;
  registration: YjsRoomRegistration;
};

export type YjsGatewayServices = {
  liveDocuments: Pick<TreeReader, "findById">;
  fileAccess: Pick<AppServices["fileAccess"], "authorize" | "confirmEdit">;
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
      generation: number;
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
  offlineSyncUpdates: Set<string>;
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

function refuseConnection(context: YjsConnectionContext, close: SchemaAdmissionRefusal): never {
  context.closeTransport(close);
  throw permissionDenied(close.reason, close.code);
}

function refuseSchemaAdmission(input: {
  services: Pick<YjsGatewayServices, "eventSink">;
  context: YjsConnectionContext;
  roomKey: string;
  documentId: DocumentId;
  close: SchemaAdmissionRefusal;
  clientSchemaVersion: CollabSchemaVersion;
  headSchemaVersion: CollabSchemaVersion;
  serverSchemaVersion: CollabSchemaVersion;
}): never {
  const {
    services,
    context,
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
    refuseConnection(context, close);
  }
}

function deriveOrigin(
  transactionOrigin: unknown,
):
  | { source: "connection"; origin: UpdateOrigin }
  | { source: "local"; origin: UpdateOrigin | null }
  | { source: "redis" }
  | { source: "unknown" } {
  if (!isTransactionOrigin(transactionOrigin)) return { source: "unknown" };
  const origin = transactionOrigin as TransactionOrigin;
  if (origin.source === "connection") {
    const userId = origin.connection.context.userId as UserId | undefined;
    return userId
      ? { source: "connection", origin: { type: "user", userId } }
      : { source: "unknown" };
  }
  if (origin.source === "local") {
    return {
      source: "local",
      origin: (origin.context?.origin as UpdateOrigin | undefined) ?? null,
    };
  }
  return { source: "redis" };
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
  context: YjsConnectionContext;
}): Promise<YjsConnectionAdmission> {
  const { services, room, userId, clientSchemaVersion, context } = input;
  let documentId: DocumentId;
  let headSchemaVersion: CollabSchemaVersion | null;
  let admitted: Awaited<ReturnType<typeof roomAccess>>;
  let fileTarget: FileTarget;

  if (room.kind === "live") {
    documentId = room.documentId;
    fileTarget = { kind: "document", documentId };
    admitted = await roomAccess(services, userId, fileTarget);
    if (!(await hasLiveDocument(services.liveDocuments, documentId))) {
      await refuseIfRemoved(services, context, { documentId });
      throw permissionDenied("permission-denied");
    }
    // The room's explicit touch: a living document missing its authority is repaired from
    // its projection before the first generation read, which never creates one.
    try {
      await services.documentSync.repairDocumentAuthority(documentId);
    } catch (cause) {
      if (cause instanceof DocumentRemovedError) refuseRemoved(context);
      throw cause;
    }
    headSchemaVersion = await services.documentSync.headSchemaVersion(documentId);
  } else {
    const documentDraft = await services.documentSync.resolveDraftHocuspocusRoom(
      room.draftId,
      room.generation,
    );
    if (!documentDraft) {
      await refuseIfRemoved(services, context, { draftId: room.draftId });
      throw permissionDenied(WS_CLOSE.DRAFT_GENERATION_STALE.reason);
    }
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
      generation: room.generation,
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
  const key = `${input.room.draftId}:${input.room.generation}`;
  if (input.syncType === messageYjsSyncStep1) {
    const stale = await input.services.documentSync.rejectStaleDraftSyncStep1({
      draftId: input.room.draftId,
      generation: input.room.generation,
      clientStateVector: input.payload,
      room: input.document,
    });
    if (input.context?.draftSyncState?.get(key) === "rejected") {
      throw permissionDenied(WS_CLOSE.DRAFT_STALE.reason, WS_CLOSE.DRAFT_STALE.code);
    }
    if (stale) {
      input.context?.draftSyncState?.set(key, "rejected");
      throw permissionDenied(WS_CLOSE.DRAFT_STALE.reason, WS_CLOSE.DRAFT_STALE.code);
    }
    input.context?.draftSyncState?.set(key, "passed");
    return;
  }
  if (input.syncType !== messageYjsSyncStep2 && input.syncType !== messageYjsUpdate) return;
  const state = input.context?.draftSyncState?.get(key) ?? "pending";
  if (state === "passed") return;
  input.context?.draftSyncState?.set(key, "rejected");
  throw permissionDenied(WS_CLOSE.DRAFT_STALE.reason, WS_CLOSE.DRAFT_STALE.code);
}

export async function admitWriterSync(input: {
  services: YjsGatewayServices;
  documentName: string;
  document: Y.Doc;
  syncType: number;
  payload: Uint8Array;
  userId: UserId;
  closeTransport?(input: { code: number; reason: string }): void;
  expectedGeneration?: bigint;
  context?: {
    draftSyncState?: Map<string, DraftHandshakeState>;
    offlineSyncUpdates?: Set<string>;
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
      expectedGeneration: room.generation,
      update: input.payload,
      origin: { type: "user", userId: input.userId },
      document: input.document,
    });
    return;
  } catch (cause) {
    // The bound edit grant was refused under the seam's locks; `beforeSync` answers it.
    if (cause instanceof FileEditRefusedError) throw cause;
    await refuseIfRemoved(input.services, input, room);
    // Not a refusal (D30): the client reconnects and its handshake carries the missing prefix.
    if (cause instanceof DraftPrefixMissingError) {
      const { code, reason } = WS_CLOSE.DRAFT_PREFIX_MISSING;
      input.closeTransport?.({ code, reason });
      throw permissionDenied(reason, code);
    }
    input.closeTransport?.({ code: 1008, reason: "draft-update-admission-failed" });
    throw permissionDenied("draft-update-admission-failed", 1008);
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
    if (admission.admitted && input.syncType === messageYjsSyncStep2) {
      input.context?.offlineSyncUpdates?.add(updateIdentity(input.payload));
    }
    return admission;
  } catch (cause) {
    // The bound edit grant was refused under the seam's locks; `beforeSync` answers it.
    if (cause instanceof FileEditRefusedError) throw cause;
    // Admission refuses a removed document under its mutation lock: nothing was journaled.
    if (cause instanceof DocumentRemovedError) refuseRemoved(input);
    input.closeTransport?.({ code: 1013, reason: "writer-journal-admission-failed" });
    throw permissionDenied("writer-journal-admission-failed", 1013);
  }
}

function updateIdentity(update: Uint8Array): string {
  return Buffer.from(update).toString("base64");
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
    (room.kind === "draft" &&
      (target.kind !== "draft" ||
        target.draftId !== room.draftId ||
        target.generation !== room.generation))
  ) {
    throw permissionDenied("permission-denied");
  }
  return target;
}

function roomOf(target: YjsAdmissionTarget) {
  return target.kind === "live" ? { documentId: target.documentId } : { draftId: target.draftId };
}

/** Terminal: the room's document was removed. The client never reconnects into it. */
function refuseRemoved(context: {
  closeTransport?(input: { code: number; reason: string }): void;
}): never {
  const { code, reason } = WS_CLOSE.DOCUMENT_DELETED;
  context.closeTransport?.({ code, reason });
  throw permissionDenied(reason, code);
}

/** Where the gateway is already refusing: a removed document answers `4208` instead. */
async function refuseIfRemoved(
  services: Pick<YjsGatewayServices, "documentSync">,
  context: { closeTransport?(input: { code: number; reason: string }): void },
  room: { documentId: DocumentId } | { draftId: string },
): Promise<void> {
  if (await services.documentSync.roomRemoval(room)) refuseRemoved(context);
}

function refuseAccessChanged(context: YjsConnectionContext): never {
  const { code, reason } = WS_CLOSE.ACCESS_CHANGED;
  context.closeTransport({ code, reason });
  throw permissionDenied(reason, code);
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
        const admission = await classifyYjsConnectionAdmission({
          services,
          room,
          userId,
          clientSchemaVersion: context.clientSchemaVersion,
          context,
        });
        if (admission.kind === "refused") {
          refuseSchemaAdmission({
            services,
            context,
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
        if (settled?.access.level !== admission.access.level) refuseAccessChanged(context);

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
            closeTransport: context.closeTransport,
            expectedGeneration: target.kind === "live" ? target.liveGeneration : undefined,
            context,
          });
        if (access.level === "read") {
          await admit();
          return;
        }
        const admitted = await runWithEditGrants(services.fileAccess, [access.grant], admit);
        if (!admitted.ok) {
          await refuseIfRemoved(services, context, roomOf(target));
          refuseAccessChanged(context);
        }
      });
    },
    async onLoadDocument({ documentName, document, context }) {
      return runWithEventCorrelation({ traceId: context.traceId }, async () => {
        const room = parseRoomOrDeny(documentName);
        let state: Uint8Array | undefined;
        try {
          state =
            room.kind === "live"
              ? await services.documentSync.loadHocuspocusDocument(room.documentId, document)
              : (
                  await services.documentSync.loadHocuspocusDraftState(
                    room.draftId,
                    room.generation,
                  )
                )?.state;
        } catch (cause) {
          if (!isDocumentSchemaMajorMismatchError(cause)) throw cause;
          refuseSchemaAdmission({
            services,
            context,
            roomKey: documentName,
            documentId: cause.docId as DocumentId,
            close: WS_CLOSE.DOCUMENT_SCHEMA_STALE,
            clientSchemaVersion: context.clientSchemaVersion,
            headSchemaVersion: cause.storedVersion,
            serverSchemaVersion: cause.expectedVersion,
          });
        }
        if (!state && room.kind === "draft")
          throw permissionDenied(WS_CLOSE.DRAFT_GENERATION_STALE.reason);
        if (state) Y.applyUpdate(document, state);
        if (room.kind === "live") services.documentSync.primeReservedNamespaceIndex(document);
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
        generation: room.generation,
        document,
      });
    },
    async connected({ documentName, connection, context }) {
      const room = parseRoomOrDeny(documentName);
      if (room.kind === "draft") {
        // As for a live room: a reset can commit between this connection's admission and
        // its room's registration, and the old generation's room must not take the tab.
        if (await services.documentSync.resolveDraftHocuspocusRoom(room.draftId, room.generation))
          return;
        const { code, reason } = WS_CLOSE.DRAFT_GENERATION_STALE;
        connection.close({ code, reason });
        context.closeTransport?.({ code, reason });
        throw permissionDenied(reason, code);
      }
      try {
        // The room can finish loading after restore's disconnection. Validate
        // after connection creation too, so the late join is closed and retries.
        await services.documentSync.validateHocuspocusDocument(
          room.documentId,
          connection.document,
        );
      } catch {
        connection.close({ code: 1013, reason: "retired-durable-authority-generation" });
        context.closeTransport?.({ code: 1013, reason: "retired-durable-authority-generation" });
        throw permissionDenied("retired-durable-authority-generation", 1013);
      }
    },
    async onChange({ documentName, update, transactionOrigin, document, connection }) {
      const operation = () => {
        const origin = deriveOrigin(transactionOrigin);
        if (origin.source !== "connection") return;

        const room = parseRoomOrDeny(documentName);
        if (room.kind === "live") {
          services.documentSync.persistConnectionUpdate({
            documentId: room.documentId,
            update,
            origin: origin.origin,
            document,
            reconcileOffline:
              connection?.context.offlineSyncUpdates?.delete(updateIdentity(update)) ?? false,
          });
        }
      };
      const traceId = connection?.context.traceId;
      return traceId ? runWithEventCorrelation({ traceId }, operation) : operation();
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
    connection.offlineSyncUpdates.clear();
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
      const offlineSyncUpdates = new Set<string>();
      const connection: YjsGatewayConnection = {
        draftSyncState,
        offlineSyncUpdates,
        registration,
        hocuspocus: hocuspocus.handleConnection(peer.socket, peer.request, {
          userId: peer.userId,
          traceId: peer.traceId,
          clientSchemaVersion: clientSchemaVersionFromRequest(peer.request),
          draftSyncState,
          offlineSyncUpdates,
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

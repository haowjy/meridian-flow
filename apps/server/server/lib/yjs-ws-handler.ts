/** Hocuspocus-backed Yjs gateway orchestration behind the thin CrossWS route. */
import {
  Hocuspocus,
  isTransactionOrigin,
  type TransactionOrigin,
  type WebSocketLike,
} from "@hocuspocus/server";
import { parseYjsRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
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
  isDocumentSchemaMajorMismatchError,
  type UpdateOrigin,
} from "../domains/collab/index.js";
import { emitEvent, unknownToEventPayload } from "../domains/observability/index.js";
import type { AppServices } from "./app.js";
export type BranchHandshakeState = "pending" | "passed" | "rejected";

type HocuspocusConnection = ReturnType<Hocuspocus["handleConnection"]>;

export type YjsGatewayPeer = {
  request: Request;
  userId: UserId;
  socket: WebSocketLike;
  close(code?: number, reason?: string): void;
};

export type YjsGatewayConnection = {
  hocuspocus: HocuspocusConnection;
  branchSyncState: Map<string, BranchHandshakeState>;
  offlineSyncUpdates: Set<string>;
};

export type YjsGatewayServices = {
  documentAccess: AppServices["documentAccess"];
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
      kind: "branch";
      branchId: Extract<ParsedYjsRoom, { kind: "branch" }>["branchId"];
      documentId: DocumentId;
      generation: number;
    };

type YjsConnectionAdmission =
  | { kind: "allowed"; target: YjsAdmissionTarget }
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
  clientSchemaVersion: CollabSchemaVersion;
  branchSyncState: Map<string, BranchHandshakeState>;
  offlineSyncUpdates: Set<string>;
  admissionTarget?: YjsAdmissionTarget;
  closeTransport(input: { code: number; reason: string }): void;
};

export function clientSchemaVersionFromRequest(request: Request): CollabSchemaVersion {
  return clientSchemaVersionFromSubprotocolHeader(request.headers.get("sec-websocket-protocol"));
}

export async function hasLiveManifestMembership(
  documentSync: Pick<
    AppServices["documentSync"],
    "reconcileProjectManifest" | "resolveManifestMembership"
  >,
  projectId: string,
  documentId: string,
): Promise<boolean> {
  let membership = await documentSync.resolveManifestMembership({ projectId: projectId as never });
  if (membership.members.includes(documentId)) return true;
  await documentSync.reconcileProjectManifest(projectId as never);
  membership = await documentSync.resolveManifestMembership({ projectId: projectId as never });
  return membership.members.includes(documentId);
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

async function classifyYjsConnectionAdmission(input: {
  services: YjsGatewayServices;
  room: ParsedYjsRoom;
  userId: UserId;
  clientSchemaVersion: CollabSchemaVersion;
}): Promise<YjsConnectionAdmission> {
  const { services, room, userId, clientSchemaVersion } = input;
  let documentId: DocumentId;
  let headSchemaVersion: CollabSchemaVersion | null;

  if (room.kind === "live") {
    documentId = room.documentId;
    if (!(await services.documentAccess.canAccessDocument(userId, documentId))) {
      throw permissionDenied("permission-denied");
    }
    const projectId = await services.documentAccess.projectIdForDocument(documentId);
    if (!projectId) throw permissionDenied("permission-denied");
    try {
      if (!(await hasLiveManifestMembership(services.documentSync, projectId, documentId))) {
        throw permissionDenied("permission-denied");
      }
    } catch (cause) {
      if (!isDocumentSchemaMajorMismatchError(cause)) throw cause;
      return {
        kind: "refused",
        close: WS_CLOSE.DOCUMENT_SCHEMA_STALE,
        documentId,
        clientSchemaVersion,
        headSchemaVersion: cause.storedVersion,
        serverSchemaVersion: cause.expectedVersion,
      };
    }
    headSchemaVersion = await services.documentSync.headSchemaVersion(documentId);
  } else {
    const branch = await services.documentSync.resolveBranchHocuspocusRoom(
      room.branchId,
      room.generation,
    );
    if (!branch) throw permissionDenied("branch-generation-stale");
    documentId = branch.documentId;
    headSchemaVersion = branch.schemaVersion;
    if (!(await services.documentAccess.canAccessDocument(userId, documentId))) {
      throw permissionDenied("permission-denied");
    }
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

  if (room.kind === "live") {
    return {
      kind: "allowed",
      target: {
        kind: "live",
        documentId,
        liveGeneration: await services.documentSync.currentLiveGeneration(documentId),
      },
    };
  }
  return {
    kind: "allowed",
    target: {
      kind: "branch",
      branchId: room.branchId,
      documentId,
      generation: room.generation,
    },
  };
}

async function enforceBranchHandshake(input: {
  services: YjsGatewayServices;
  room: Extract<ReturnType<typeof parseRoomOrDeny>, { kind: "branch" }>;
  syncType: number;
  payload: Uint8Array;
  context?: { branchSyncState?: Map<string, BranchHandshakeState> };
}): Promise<void> {
  const key = `${input.room.branchId}:${input.room.generation}`;
  if (input.syncType === messageYjsSyncStep1) {
    const stale = await input.services.documentSync.rejectStaleBranchSyncStep1({
      branchId: input.room.branchId,
      generation: input.room.generation,
      clientStateVector: input.payload,
    });
    if (input.context?.branchSyncState?.get(key) === "rejected") {
      throw permissionDenied(WS_CLOSE.BRANCH_STALE.reason, WS_CLOSE.BRANCH_STALE.code);
    }
    if (stale) {
      input.context?.branchSyncState?.set(key, "rejected");
      throw permissionDenied(WS_CLOSE.BRANCH_STALE.reason, WS_CLOSE.BRANCH_STALE.code);
    }
    input.context?.branchSyncState?.set(key, "passed");
    return;
  }
  if (input.syncType !== messageYjsSyncStep2 && input.syncType !== messageYjsUpdate) return;
  const state = input.context?.branchSyncState?.get(key) ?? "pending";
  if (state === "passed") return;
  input.context?.branchSyncState?.set(key, "rejected");
  throw permissionDenied(WS_CLOSE.BRANCH_STALE.reason, WS_CLOSE.BRANCH_STALE.code);
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
    branchSyncState?: Map<string, BranchHandshakeState>;
    offlineSyncUpdates?: Set<string>;
  };
}): Promise<AdmitLiveWriterUpdateResult | undefined> {
  const room = parseRoomOrDeny(input.documentName);
  if (room.kind === "branch") {
    return admitBranchSync(input, room);
  }
  return admitLiveSync(input, room);
}

type WriterSyncInput = Parameters<typeof admitWriterSync>[0];

function carriesUpdate(syncType: number, payload: Uint8Array): boolean {
  return (syncType === messageYjsSyncStep2 || syncType === messageYjsUpdate) && payload.length > 0;
}

async function admitBranchSync(
  input: WriterSyncInput,
  room: Extract<ReturnType<typeof parseRoomOrDeny>, { kind: "branch" }>,
): Promise<undefined> {
  await enforceBranchHandshake({
    services: input.services,
    room,
    syncType: input.syncType,
    payload: input.payload,
    context: input.context,
  });
  if (!carriesUpdate(input.syncType, input.payload)) return;
  // A draft branch room is a collaborative room like any other: the writer is
  // one more peer in it. Client frames run the same durable admission the
  // agent's own branch writes do.
  try {
    await input.services.documentSync.admitBranchWriterUpdate({
      branchId: room.branchId,
      expectedGeneration: room.generation,
      update: input.payload,
      origin: { type: "user", userId: input.userId },
      document: input.document,
    });
    return;
  } catch {
    input.closeTransport?.({ code: 1008, reason: "branch-update-admission-failed" });
    throw permissionDenied("branch-update-admission-failed", 1008);
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
  } catch {
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
    (room.kind === "branch" &&
      (target.kind !== "branch" ||
        target.branchId !== room.branchId ||
        target.generation !== room.generation))
  ) {
    throw permissionDenied("permission-denied");
  }
  return target;
}

export function createHocuspocus(services: YjsGatewayServices): Hocuspocus<YjsConnectionContext> {
  const hocuspocus = new Hocuspocus<YjsConnectionContext>({
    name: "meridian-yjs",
    yDocOptions: { gc: false, gcFilter: () => true },
    debounce: 2000,
    maxDebounce: 10000,
    async onConnect({ documentName, context }) {
      const userId = context.userId;
      if (!userId) throw permissionDenied("permission-denied");

      const room = parseRoomOrDeny(documentName);
      const admission = await classifyYjsConnectionAdmission({
        services,
        room,
        userId,
        clientSchemaVersion: context.clientSchemaVersion,
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

      if (admission.target.kind === "branch") {
        const target = admission.target;
        // Do not delay room admission: a cold room may briefly render its persisted
        // state before this pull arrives, then normal CRDT sync catches it up.
        void services.documentSync
          .flushBranchLivePull(target.documentId)
          .catch((cause: unknown) => {
            emitEvent(services.eventSink, {
              level: "warn",
              source: "collab.hocuspocus",
              name: "branch_review.live_pull_failed",
              payload: {
                documentId: target.documentId,
                branchId: target.branchId,
                ...unknownToEventPayload(cause),
              },
            });
          });
      }
    },
    async beforeHandleMessage({ context }) {
      const userId = context.userId;
      if (!userId) throw permissionDenied("permission-denied");
    },
    async beforeSync({ documentName, document, type, payload, context }) {
      const userId = context.userId;
      if (!userId) throw permissionDenied("permission-denied");
      const target = admittedTargetForSync(context, documentName);
      await admitWriterSync({
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
    },
    async onLoadDocument({ documentName, document, context }) {
      const room = parseRoomOrDeny(documentName);
      let state: Uint8Array | undefined;
      try {
        state =
          room.kind === "live"
            ? await services.documentSync.loadHocuspocusDocument(room.documentId)
            : (
                await services.documentSync.loadHocuspocusBranchState(
                  room.branchId,
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
      if (!state && room.kind === "branch") throw permissionDenied("branch-generation-stale");
      if (state) Y.applyUpdate(document, state);
      if (room.kind === "live") services.documentSync.primeReservedNamespaceIndex(document);
    },
    async onChange({ documentName, update, transactionOrigin, document, connection }) {
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
    },
    async onStoreDocument({ documentName, document }) {
      const room = parseRoomOrDeny(documentName);
      if (room.kind === "live") {
        await services.documentSync.storeHocuspocusDocument(room.documentId, document);
        return;
      }
      await services.documentSync.storeHocuspocusBranch(room.branchId, document);
    },
  });
  services.documentSync.bindHocuspocus(hocuspocus);
  return hocuspocus;
}

export function createYjsGateway(services: YjsGatewayServices) {
  let acceptingConnections = true;
  const hocuspocus = createHocuspocus(services);

  return {
    hocuspocus,

    connect(peer: YjsGatewayPeer): YjsGatewayConnection | undefined {
      if (!acceptingConnections) {
        peer.close(1012, "server-shutdown");
        return;
      }

      const connection = {
        branchSyncState: new Map<string, BranchHandshakeState>(),
        offlineSyncUpdates: new Set<string>(),
      };
      const hocuspocusConnection = hocuspocus.handleConnection(peer.socket, peer.request, {
        userId: peer.userId,
        clientSchemaVersion: clientSchemaVersionFromRequest(peer.request),
        branchSyncState: connection.branchSyncState,
        offlineSyncUpdates: connection.offlineSyncUpdates,
        closeTransport: ({ code, reason }: { code: number; reason: string }) =>
          peer.close(code, reason),
      });
      return { ...connection, hocuspocus: hocuspocusConnection };
    },

    message(connection: YjsGatewayConnection | undefined, message: Uint8Array): void {
      connection?.hocuspocus.handleMessage(message);
    },

    close(
      connection: YjsGatewayConnection | undefined,
      event?: { code?: number; reason?: string },
    ): void {
      if (!connection) return;
      connection.hocuspocus.handleClose({
        code: event?.code ?? 1000,
        reason: event?.reason ?? "close",
      });
      connection.branchSyncState.clear();
      connection.offlineSyncUpdates.clear();
    },

    error(connection: YjsGatewayConnection | undefined): void {
      if (!connection) return;
      connection.hocuspocus.handleClose({ code: 1011, reason: "error" });
      connection.branchSyncState.clear();
      connection.offlineSyncUpdates.clear();
    },

    async drain(): Promise<void> {
      acceptingConnections = false;
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
    documentAccess: app.documentAccess,
    documentSync: app.documentSync,
    eventSink: app.eventSink,
  };
}

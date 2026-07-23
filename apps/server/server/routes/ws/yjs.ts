/** Hocuspocus-backed Yjs document collaboration socket mounted through Nitro crossws. */
import {
  Hocuspocus,
  isTransactionOrigin,
  type TransactionOrigin,
  type WebSocketLike,
} from "@hocuspocus/server";
import { encodeSafetyNoticeWsMessage, parseYjsRoomName } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import { defineWebSocketHandler } from "nitro";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { primeReservedNamespaceIndex } from "../../domains/collab/domain/provenance.js";
import type { AdmitLiveWriterUpdateResult, UpdateOrigin } from "../../domains/collab/index.js";
import { emitEvent, unknownToEventPayload } from "../../domains/observability/index.js";
import type { AppServices } from "../../lib/app.js";
import { getApp } from "../../lib/app.js";
import {
  deferWsClose,
  resolveWsUpgradeAuth,
  type WsDeferredClose,
} from "../../lib/ws-upgrade-auth.js";

type YjsRouteContext =
  | {
      kind: "authenticated";
      app: AppServices;
      userId: UserId;
      branchSyncState: Map<string, BranchHandshakeState>;
      offlineSyncUpdates: Set<string>;
      liveGenerations: Map<string, bigint>;
    }
  | { kind: "deferred-close"; close: WsDeferredClose };

export type BranchHandshakeState = "pending" | "passed" | "rejected";

type HocuspocusConnection = ReturnType<Hocuspocus["handleConnection"]>;

type YjsRoutePeer = {
  request: Request;
  context?: YjsRouteContext;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  websocket?: { readyState?: number };
  _hocuspocus?: HocuspocusConnection;
};

type YjsRouteServices = {
  documentAccess: AppServices["documentAccess"];
  documentSync: AppServices["documentSync"];
  eventSink: AppServices["eventSink"];
  notices: AppServices["notices"];
};

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

type WriterNoticeDocument = {
  getConnectionsCount(): number;
  broadcastStateless(payload: string): void;
};

export function subscribeWriterNoticeTransport(input: {
  notices: AppServices["notices"];
  documentsForId(documentId: string): Promise<readonly WriterNoticeDocument[]>;
  eventSink: AppServices["eventSink"];
}): () => void {
  return input.notices.subscribeWriterVisible((event) => {
    void (async () => {
      const documents = (await input.documentsForId(event.documentId)).filter(
        (document) => document.getConnectionsCount() > 0,
      );
      if (documents.length === 0) return;
      const payload = encodeSafetyNoticeWsMessage({
        documentId: event.documentId as never,
        kind: event.kind,
        message: event.message,
        data: event.data,
      });
      for (const document of documents) document.broadcastStateless(payload);
      await input.notices.drainForWriter(event.documentId);
    })().catch((cause) => {
      emitEvent(input.eventSink, {
        level: "warn",
        source: "collab.hocuspocus",
        name: "writer_notice.delivery_failed",
        payload: { documentId: event.documentId, cause: String(cause) },
      });
    });
  });
}

let hocuspocusPromise: Promise<Hocuspocus> | null = null;
let acceptingConnections = true;

function selectYjsRouteServices(app: AppServices): YjsRouteServices {
  return {
    documentAccess: app.documentAccess,
    documentSync: app.documentSync,
    eventSink: app.eventSink,
    notices: app.notices,
  };
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

function socketLike(peer: YjsRoutePeer): WebSocketLike {
  return {
    send: (data) =>
      peer.send(typeof data === "string" ? data : new Uint8Array(data as ArrayBufferLike)),
    close: (code, reason) => peer.close(code, reason),
    get readyState() {
      return peer.websocket?.readyState ?? 1;
    },
  };
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

async function resolveRoomDocumentId(
  services: YjsRouteServices,
  room: ReturnType<typeof parseRoomOrDeny>,
) {
  if (room.kind === "live") return room.documentId;
  const branch = await services.documentSync.resolveBranchHocuspocusRoom(
    room.branchId,
    room.generation,
  );
  if (!branch) throw permissionDenied("branch-generation-stale");
  return branch.documentId;
}

async function enforceBranchHandshake(input: {
  services: YjsRouteServices;
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
      throw permissionDenied("branch-stale-doc", 4205);
    }
    if (stale) {
      input.context?.branchSyncState?.set(key, "rejected");
      throw permissionDenied("branch-stale-doc", 4205);
    }
    input.context?.branchSyncState?.set(key, "passed");
    return;
  }
  if (input.syncType !== messageYjsSyncStep2 && input.syncType !== messageYjsUpdate) return;
  const state = input.context?.branchSyncState?.get(key) ?? "pending";
  if (state === "passed") return;
  input.context?.branchSyncState?.set(key, "rejected");
  throw permissionDenied("branch-stale-doc", 4205);
}

export async function admitWriterSync(input: {
  services: YjsRouteServices;
  documentName: string;
  document: Y.Doc;
  syncType: number;
  payload: Uint8Array;
  userId: UserId;
  closeTransport?(): void;
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
    input.closeTransport?.();
    throw permissionDenied("branch-update-admission-failed", 1008);
  }
}

async function admitLiveSync(
  input: WriterSyncInput,
  room: Extract<ReturnType<typeof parseRoomOrDeny>, { kind: "live" }>,
): Promise<AdmitLiveWriterUpdateResult | undefined> {
  if (!carriesUpdate(input.syncType, input.payload)) return;
  try {
    const admission = await input.services.documentSync.admitLiveWriterUpdate({
      documentId: room.documentId,
      document: input.document,
      update: input.payload,
      origin: { type: "user", userId: input.userId },
      expectedGeneration: input.expectedGeneration ?? 1n,
    });
    if (admission.admitted && input.syncType === messageYjsSyncStep2) {
      input.context?.offlineSyncUpdates?.add(updateIdentity(input.payload));
    }
    return admission;
  } catch {
    input.closeTransport?.();
    throw permissionDenied("writer-journal-admission-failed", 1013);
  }
}

function updateIdentity(update: Uint8Array): string {
  return Buffer.from(update).toString("base64");
}

export function createHocuspocus(services: YjsRouteServices): Hocuspocus {
  const documentsForId = async (documentId: string): Promise<WriterNoticeDocument[]> => {
    const matches: WriterNoticeDocument[] = [];
    for (const [roomName, document] of hocuspocus.documents) {
      const room = parseYjsRoomName(roomName);
      if (!room) continue;
      if (room.kind === "live") {
        if (room.documentId === documentId) matches.push(document);
        continue;
      }
      const branch = await services.documentSync.resolveBranchHocuspocusRoom(
        room.branchId,
        room.generation,
      );
      if (branch?.documentId === documentId) matches.push(document);
    }
    return matches;
  };
  const deliverPendingWriterNotices = async (documentId: string): Promise<void> => {
    const documents = (await documentsForId(documentId)).filter(
      (document) => document.getConnectionsCount() > 0,
    );
    if (documents.length === 0) return;
    const notices = await services.notices.drainForWriter(documentId);
    for (const notice of notices) {
      const payload = encodeSafetyNoticeWsMessage({
        documentId: documentId as never,
        kind: notice.kind,
        message: notice.message,
        data: notice.data,
      });
      for (const document of documents) document.broadcastStateless(payload);
    }
  };
  const hocuspocus = new Hocuspocus({
    name: "meridian-yjs",
    yDocOptions: { gc: false, gcFilter: () => true },
    debounce: 2000,
    maxDebounce: 10000,
    async onConnect({ documentName, context }) {
      const userId = context.userId as UserId | undefined;
      if (!userId) throw permissionDenied("permission-denied");

      const room = parseRoomOrDeny(documentName);
      const documentId = await resolveRoomDocumentId(services, room);
      if (!documentId || !(await services.documentAccess.canAccessDocument(userId, documentId))) {
        throw permissionDenied("permission-denied");
      }
      if (room.kind === "live") {
        const projectId = await services.documentAccess.projectIdForDocument(documentId);
        if (!projectId) throw permissionDenied("permission-denied");
        if (!(await hasLiveManifestMembership(services.documentSync, projectId, documentId))) {
          throw permissionDenied("permission-denied");
        }
        context.liveGenerations?.set(
          documentId,
          await services.documentSync.currentLiveGeneration(documentId),
        );
      } else {
        // Do not delay room admission: a cold room may briefly render its persisted
        // state before this pull arrives, then normal CRDT sync catches it up.
        void services.documentSync.flushBranchLivePull(documentId).catch((cause: unknown) => {
          emitEvent(services.eventSink, {
            level: "warn",
            source: "collab.hocuspocus",
            name: "branch_review.live_pull_failed",
            payload: { documentId, branchId: room.branchId, ...unknownToEventPayload(cause) },
          });
        });
      }
      setTimeout(() => {
        void deliverPendingWriterNotices(documentId).catch((cause) => {
          emitEvent(services.eventSink, {
            level: "warn",
            source: "collab.hocuspocus",
            name: "writer_notice.reconnect_delivery_failed",
            payload: { documentId, cause: String(cause) },
          });
        });
      }, 0);
    },
    async beforeHandleMessage({ context }) {
      const userId = context.userId as UserId | undefined;
      if (!userId) throw permissionDenied("permission-denied");
    },
    async beforeSync({ documentName, document, type, payload, context }) {
      const userId = context.userId as UserId | undefined;
      if (!userId) throw permissionDenied("permission-denied");
      await admitWriterSync({
        services,
        documentName,
        document,
        syncType: type,
        payload,
        userId,
        closeTransport: context.closeWriterTransport as (() => void) | undefined,
        expectedGeneration: context.liveGenerations?.get(documentName),
        context,
      });
    },
    async onLoadDocument({ documentName, document }) {
      const room = parseRoomOrDeny(documentName);
      const state =
        room.kind === "live"
          ? await services.documentSync.loadHocuspocusDocument(room.documentId)
          : (await services.documentSync.loadHocuspocusBranchState(room.branchId, room.generation))
              ?.state;
      if (!state && room.kind === "branch") throw permissionDenied("branch-generation-stale");
      if (state) Y.applyUpdate(document, state);
      if (room.kind === "live") primeReservedNamespaceIndex(document);
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
  subscribeWriterNoticeTransport({
    notices: services.notices,
    documentsForId,
    eventSink: services.eventSink,
  });
  services.documentSync.bindHocuspocus(hocuspocus);
  return hocuspocus;
}

export function getYjsHocuspocus(): Promise<Hocuspocus> {
  hocuspocusPromise ??= getApp().then((app) => createHocuspocus(selectYjsRouteServices(app)));
  return hocuspocusPromise;
}

export async function drainYjsCollabPersistence(): Promise<void> {
  acceptingConnections = false;
  const hocuspocus = await getYjsHocuspocus();
  hocuspocus.closeConnections();
  const app = await getApp();
  const documentSync = app.documentSync;
  emitEvent(app.eventSink, {
    level: "info",
    source: "collab.hocuspocus",
    name: "persistence_queue.drain",
    payload: documentSync.getPersistenceQueueMetrics(),
  });
  await documentSync.drainHocuspocusPersistence();
}

export function createYjsWebSocketHooks() {
  return {
    async upgrade(request: Request) {
      const auth = await resolveWsUpgradeAuth(request, { logPrefix: "ws-yjs-route" });
      if (auth.kind === "deferred-close") {
        return {
          context: deferWsClose(auth.close) satisfies YjsRouteContext,
        };
      }
      return {
        context: {
          kind: "authenticated",
          app: auth.app,
          userId: auth.userId,
          branchSyncState: new Map<string, BranchHandshakeState>(),
          offlineSyncUpdates: new Set<string>(),
          liveGenerations: new Map<string, bigint>(),
        } satisfies YjsRouteContext,
      };
    },

    async open(peer: unknown) {
      const wsPeer = peer as unknown as YjsRoutePeer;
      const context = wsPeer.context;
      if (context?.kind === "deferred-close") {
        wsPeer.close(context.close.code, context.close.reason);
        return;
      }

      if (!acceptingConnections) {
        wsPeer.close(1012, "server-shutdown");
        return;
      }

      const hocuspocus = await getYjsHocuspocus();
      wsPeer._hocuspocus = hocuspocus.handleConnection(socketLike(wsPeer), wsPeer.request, {
        userId: context?.userId,
        branchSyncState: context?.kind === "authenticated" ? context.branchSyncState : undefined,
        offlineSyncUpdates:
          context?.kind === "authenticated" ? context.offlineSyncUpdates : undefined,
        liveGenerations: context?.kind === "authenticated" ? context.liveGenerations : undefined,
        closeWriterTransport: () => wsPeer.close(1013, "writer-journal-admission-failed"),
      });
    },

    async message(peer: unknown, message: { uint8Array(): Uint8Array }) {
      const wsPeer = peer as unknown as YjsRoutePeer;
      const context = wsPeer.context;
      if (context?.kind !== "authenticated") return;
      wsPeer._hocuspocus?.handleMessage(message.uint8Array());
    },

    async close(peer: unknown, event?: { code?: number; reason?: string }) {
      const wsPeer = peer as unknown as YjsRoutePeer;
      const context = wsPeer.context;
      if (context?.kind !== "authenticated") return;
      wsPeer._hocuspocus?.handleClose({
        code: event?.code ?? 1000,
        reason: event?.reason ?? "close",
      });
      context.branchSyncState.clear();
      context.offlineSyncUpdates?.clear();
      context.liveGenerations?.clear();
      delete wsPeer._hocuspocus;
    },

    async error(peer: unknown) {
      const wsPeer = peer as unknown as YjsRoutePeer;
      const context = wsPeer.context;
      if (context?.kind !== "authenticated") return;
      wsPeer._hocuspocus?.handleClose({ code: 1011, reason: "error" });
      context.branchSyncState.clear();
      context.offlineSyncUpdates?.clear();
      context.liveGenerations?.clear();
      delete wsPeer._hocuspocus;
    },
  };
}

export const yjsWebSocketHandler = defineWebSocketHandler(createYjsWebSocketHooks);

export default yjsWebSocketHandler;

/** Hocuspocus-backed Yjs document collaboration socket mounted through Nitro crossws. */
import {
  Hocuspocus,
  isTransactionOrigin,
  MessageType,
  type TransactionOrigin,
  type WebSocketLike,
} from "@hocuspocus/server";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import { defineWebSocketHandler } from "nitro";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import type { UpdateOrigin } from "../../domains/collab/index.js";
import { emitEvent } from "../../domains/observability/index.js";
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
      branchSyncPassed: Set<string>;
    }
  | { kind: "deferred-close"; close: WsDeferredClose };

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
};

let hocuspocusPromise: Promise<Hocuspocus> | null = null;
let acceptingConnections = true;

function selectYjsRouteServices(app: AppServices): YjsRouteServices {
  return {
    documentAccess: app.documentAccess,
    documentSync: app.documentSync,
    eventSink: app.eventSink,
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
  if (room.kind === "draft") {
    return (await services.documentSync.resolveDraftHocuspocusRoom(room.draftId))?.documentId;
  }
  const branch = await services.documentSync.resolveBranchHocuspocusRoom(
    room.branchId,
    room.generation,
  );
  if (!branch) throw permissionDenied("branch-generation-stale");
  return branch.documentId;
}

function syncMessage(
  input: Uint8Array,
  documentName: string,
): { syncType: number; payload: Uint8Array } | null {
  const decoder = createDecoder(input);
  const rawKey = readVarString(decoder);
  const sepIdx = rawKey.indexOf("\0");
  const addressedDocument = sepIdx === -1 ? rawKey : rawKey.substring(0, sepIdx);
  if (addressedDocument !== documentName) return null;
  const messageType = readVarUint(decoder);
  if (messageType !== MessageType.Sync && messageType !== MessageType.SyncReply) return null;
  const syncType = readVarUint(decoder);
  return { syncType, payload: readVarUint8Array(decoder) };
}

async function enforceBranchHandshake(input: {
  services: YjsRouteServices;
  documentName: string;
  update: Uint8Array;
  context?: { branchSyncPassed?: Set<string> };
}): Promise<void> {
  const room = parseRoomOrDeny(input.documentName);
  if (room.kind !== "branch") return;
  const message = syncMessage(input.update, input.documentName);
  if (!message) return;
  const key = `${room.branchId}:${room.generation}`;
  if (message.syncType === messageYjsSyncStep1) {
    const stale = await input.services.documentSync.rejectStaleBranchSyncStep1({
      branchId: room.branchId,
      generation: room.generation,
      clientStateVector: message.payload,
    });
    if (stale) throw permissionDenied("branch-stale-doc", 4205);
    input.context?.branchSyncPassed?.add(key);
    return;
  }
  if (message.syncType !== messageYjsSyncStep2 && message.syncType !== messageYjsUpdate) return;
  if (input.context?.branchSyncPassed?.has(key)) return;
  throw permissionDenied("branch-stale-doc", 4205);
}

function createHocuspocus(services: YjsRouteServices): Hocuspocus {
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
        const membership = await services.documentSync.resolveManifestMembership({ projectId });
        if (!membership.members.includes(documentId)) throw permissionDenied("permission-denied");
      }
    },
    async beforeHandleMessage({ documentName, update, context }) {
      await enforceBranchHandshake({ services, documentName, update, context });
    },
    async onLoadDocument({ documentName }) {
      const room = parseRoomOrDeny(documentName);
      if (room.kind === "live")
        return services.documentSync.loadHocuspocusDocument(room.documentId);
      if (room.kind === "draft") return services.documentSync.loadHocuspocusDraft(room.draftId);
      const loaded = await services.documentSync.loadHocuspocusBranchState(
        room.branchId,
        room.generation,
      );
      if (!loaded) throw permissionDenied("branch-generation-stale");
      return loaded.state;
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
        });
        return;
      }
      if (room.kind === "draft") {
        services.documentSync.persistDraftConnectionUpdate({
          draftId: room.draftId,
          update,
          origin: origin.origin,
          document,
        });
        return;
      }
      try {
        await services.documentSync.persistBranchConnectionUpdate({
          branchId: room.branchId,
          update,
          origin: origin.origin,
          document,
          expectedGeneration: room.generation,
        });
      } catch (cause) {
        if (cause instanceof Error && cause.name === "BranchStaleUpdateError") {
          emitEvent(services.eventSink, {
            level: "warn",
            source: "collab.hocuspocus",
            name: "branch_update.stale_generation",
            payload: { branchId: room.branchId, generation: room.generation },
          });
          connection?.close({ code: 4205, reason: "branch-generation-stale" });
          return;
        }
        throw cause;
      }
    },
    async onStoreDocument({ documentName, document }) {
      const room = parseRoomOrDeny(documentName);
      if (room.kind === "live") {
        await services.documentSync.storeHocuspocusDocument(room.documentId, document);
        return;
      }
      if (room.kind === "draft") {
        await services.documentSync.storeHocuspocusDraft(room.draftId, document);
        return;
      }
      await services.documentSync.storeHocuspocusBranch(room.branchId, document);
    },
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

export default defineWebSocketHandler(() => ({
  async upgrade(request) {
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
        branchSyncPassed: new Set<string>(),
      } satisfies YjsRouteContext,
    };
  },

  async open(peer) {
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
      branchSyncPassed: context?.kind === "authenticated" ? context.branchSyncPassed : undefined,
    });
  },

  async message(peer, message) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    const context = wsPeer.context;
    if (context?.kind !== "authenticated") return;
    wsPeer._hocuspocus?.handleMessage(message.uint8Array());
  },

  async close(peer, event) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    const context = wsPeer.context;
    if (context?.kind !== "authenticated") return;
    wsPeer._hocuspocus?.handleClose({
      code: event?.code ?? 1000,
      reason: event?.reason ?? "close",
    });
    delete wsPeer._hocuspocus;
  },

  async error(peer) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    const context = wsPeer.context;
    if (context?.kind !== "authenticated") return;
    wsPeer._hocuspocus?.handleClose({ code: 1011, reason: "error" });
    delete wsPeer._hocuspocus;
  },
}));

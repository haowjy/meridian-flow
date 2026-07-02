/** Hocuspocus-backed Yjs document collaboration socket mounted through Nitro crossws. */
import {
  Hocuspocus,
  isTransactionOrigin,
  type TransactionOrigin,
  type WebSocketLike,
} from "@hocuspocus/server";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import { defineWebSocketHandler } from "nitro";
import type { CollabTransport, UpdateOrigin } from "../../domains/collab/index.js";
import { emitEvent } from "../../domains/observability/index.js";
import type { AppServices } from "../../lib/app.js";
import { getApp } from "../../lib/app.js";
import {
  deferWsClose,
  resolveWsUpgradeAuth,
  type WsDeferredClose,
} from "../../lib/ws-upgrade-auth.js";

type YjsRouteContext =
  | { kind: "authenticated"; app: AppServices; userId: UserId }
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
  documentSync: CollabTransport;
};

let hocuspocusPromise: Promise<Hocuspocus> | null = null;
let acceptingConnections = true;

function selectYjsRouteServices(app: AppServices): YjsRouteServices {
  return {
    documentAccess: app.documentAccess,
    documentSync: app.documentSync,
  };
}

function permissionDenied(reason: string): Error & { reason: string } {
  const error = new Error(reason) as Error & { reason: string };
  error.reason = reason;
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

function createHocuspocus(services: YjsRouteServices): Hocuspocus {
  const hocuspocus = new Hocuspocus({
    name: "meridian-yjs",
    yDocOptions: { gc: false, gcFilter: () => true },
    debounce: 2000,
    maxDebounce: 10000,
    async onConnect({ documentName, context, socketId }) {
      const userId = context.userId as UserId | undefined;
      if (!userId) throw permissionDenied("permission-denied");

      const room = parseRoomOrDeny(documentName);
      const documentId =
        room.kind === "live"
          ? room.documentId
          : (await services.documentSync.resolveDraftHocuspocusRoom(room.draftId))?.documentId;
      if (!documentId || !(await services.documentAccess.canAccessDocument(userId, documentId))) {
        throw permissionDenied("permission-denied");
      }
      if (room.kind === "draft") {
        services.documentSync.enterDraftReview({ draftId: room.draftId, socketId, userId });
      }
    },
    async onDisconnect({ documentName, socketId }) {
      const room = parseRoomOrDeny(documentName);
      if (room.kind === "draft") {
        services.documentSync.leaveDraftReview({ draftId: room.draftId, socketId });
      }
    },
    async onLoadDocument({ documentName }) {
      const room = parseRoomOrDeny(documentName);
      return room.kind === "live"
        ? services.documentSync.loadHocuspocusDocument(room.documentId)
        : services.documentSync.loadHocuspocusDraft(room.draftId);
    },
    async onChange({ documentName, update, transactionOrigin, document }) {
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
      services.documentSync.persistDraftConnectionUpdate({
        draftId: room.draftId,
        update,
        origin: origin.origin,
        document,
      });
    },
    async onStoreDocument({ documentName, document }) {
      const room = parseRoomOrDeny(documentName);
      if (room.kind === "live") {
        await services.documentSync.storeHocuspocusDocument(room.documentId, document);
        return;
      }
      await services.documentSync.storeHocuspocusDraft(room.draftId, document);
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
  const documentSync: CollabTransport = app.documentSync;
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

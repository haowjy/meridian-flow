/** Hocuspocus-backed Yjs document collaboration socket mounted through Nitro crossws. */
import {
  Hocuspocus,
  isTransactionOrigin,
  type TransactionOrigin,
  type WebSocketLike,
} from "@hocuspocus/server";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import { defineWebSocketHandler } from "nitro";
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

type YjsRouteServices = Pick<AppServices, "documentAccess" | "documentSync">;

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

function createHocuspocus(services: YjsRouteServices): Hocuspocus {
  const hocuspocus = new Hocuspocus({
    name: "meridian-yjs",
    yDocOptions: { gc: false, gcFilter: () => true },
    debounce: 2000,
    maxDebounce: 10000,
    async onConnect({ documentName, context }) {
      const userId = context.userId as UserId | undefined;
      if (!userId || !(await services.documentAccess.canAccessDocument(userId, documentName))) {
        throw permissionDenied("permission-denied");
      }
    },
    async onLoadDocument({ documentName }) {
      return services.documentSync.loadHocuspocusDocument(documentName as DocumentId);
    },
    async onChange({ documentName, update, transactionOrigin, document }) {
      const origin = deriveOrigin(transactionOrigin);
      if (origin.source !== "connection") return;
      services.documentSync.persistConnectionUpdate({
        documentId: documentName as DocumentId,
        update,
        origin: origin.origin,
        document,
      });
    },
    async onStoreDocument({ documentName, document }) {
      await services.documentSync.storeHocuspocusDocument(documentName as DocumentId, document);
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
  emitEvent(app.eventSink, {
    level: "info",
    source: "collab.hocuspocus",
    name: "persistence_queue.drain",
    payload: { queues: app.documentSync.getPersistenceQueueMetrics() },
  });
  await app.documentSync.drainHocuspocusPersistence();
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

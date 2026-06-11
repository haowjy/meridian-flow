import { encodeYjsControlFrame, type YjsControlErrorCode } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database";
import { eq } from "drizzle-orm";
import { defineWebSocketHandler } from "nitro";
import type { AppServices } from "../../lib/app.js";
import { getApp } from "../../lib/app.js";
import { getDb } from "../../lib/db.js";
import { safeWsSend } from "../../lib/ws-safe-send.js";
import {
  deferWsClose,
  resolveWsUpgradeAuth,
  type WsDeferredClose,
} from "../../lib/ws-upgrade-auth.js";
import {
  createYjsWsHandler,
  type YjsWsAuthenticatedContext,
  type YjsWsPeer,
} from "../../lib/ws-yjs-handler.js";

type YjsRouteContext =
  | (YjsWsAuthenticatedContext & { kind: "authenticated" })
  | {
      kind: "deferred-close";
      close: WsDeferredClose & {
        errorCode: YjsControlErrorCode;
        reasonFrame: string;
      };
    };

type YjsRoutePeer = Omit<YjsWsPeer, "context"> & {
  request: Request;
  context?: YjsRouteContext;
};

type YjsRouteServices = Pick<AppServices, "documentSync"> & {
  db: Database;
};

let handlerPromise: Promise<ReturnType<typeof createYjsWsHandler>> | null = null;

function selectYjsRouteServices(app: AppServices): YjsRouteServices {
  return {
    db: getDb(),
    documentSync: app.documentSync,
  };
}

async function updateDocumentProjection(
  db: Database,
  documentId: string,
  markdown: string,
): Promise<void> {
  await db
    .update(documents)
    .set({ markdownProjection: markdown, updatedAt: new Date() })
    .where(eq(documents.id, documentId as DocumentId));
}

function createHandler(services: YjsRouteServices): ReturnType<typeof createYjsWsHandler> {
  return createYjsWsHandler({
    transport: services.documentSync,
    canAccessDocument: async (userId, documentId) => {
      try {
        await services.documentSync.requireOwnedDocument(documentId as DocumentId, userId);
        return true;
      } catch {
        return false;
      }
    },
    updateOrigin(peer) {
      const userId = peer.context?.userId;
      return userId ? { type: "user", userId } : { type: "system" };
    },
    async afterPersist(documentId) {
      const markdown = await services.documentSync.readAsMarkdown(documentId as DocumentId);
      if (!markdown.ok) {
        console.error("ws-yjs-route: projection markdown read failed", documentId, markdown.error);
        return;
      }
      await updateDocumentProjection(services.db, documentId, markdown.value);
    },
  });
}

function getHandler(): Promise<ReturnType<typeof createYjsWsHandler>> {
  handlerPromise ??= getApp().then((app) => createHandler(selectYjsRouteServices(app)));
  return handlerPromise;
}

export default defineWebSocketHandler(() => ({
  async upgrade(request) {
    const auth = await resolveWsUpgradeAuth(request, { logPrefix: "ws-yjs-route" });
    if (auth.kind === "deferred-close") {
      const isAuthFailure = auth.close.reason === "auth_failed";
      return {
        context: deferWsClose({
          ...auth.close,
          errorCode: isAuthFailure ? "auth_failed" : "internal",
          reasonFrame: isAuthFailure ? "Authentication failed" : "Internal server error",
        }) satisfies YjsRouteContext,
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
      safeWsSend(
        wsPeer,
        encodeYjsControlFrame({
          type: "error",
          code: context.close.errorCode,
          reason: context.close.reasonFrame,
        }),
        { logPrefix: "ws-yjs-route" },
      );
      wsPeer.close(context.close.code, context.close.reason);
      return;
    }

    const authenticatedPeer = wsPeer as unknown as YjsWsPeer;
    const handler = await getHandler();
    if (!handler.open(authenticatedPeer)) {
      handler.close(authenticatedPeer);
    }
  },

  async message(peer, message) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    const context = wsPeer.context;
    if (context?.kind !== "authenticated") return;

    const rawData = (message as { rawData?: unknown }).rawData;
    const handler = await getHandler();
    handler.message(
      wsPeer as unknown as YjsWsPeer,
      typeof rawData === "string" ? rawData : message.uint8Array(),
    );
  },

  async close(peer) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    const context = wsPeer.context;
    if (context?.kind !== "authenticated") return;
    (await getHandler()).close(wsPeer as unknown as YjsWsPeer);
  },

  async error(peer) {
    const wsPeer = peer as unknown as YjsRoutePeer;
    const context = wsPeer.context;
    if (context?.kind !== "authenticated") return;
    (await getHandler()).close(wsPeer as unknown as YjsWsPeer);
  },
}));

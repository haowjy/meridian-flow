/** Real-provider signals reject obsolete generations after whole and selective Discard. */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { afterAll, beforeEach, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { materializeDraftRead } from "../../domains/collab/domain/draft-store.js";
import { createHocuspocusPersistenceService } from "../../domains/collab/hocuspocus-persistence.js";
import { closeDraftRooms } from "../../domains/collab/hocuspocus-rooms.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  USER_ID,
} from "../../domains/collab/test-support/change-trail-postgres-harness.js";
import { reviewDriver } from "../../domains/collab/test-support/draft-review-requests.js";
import { admitWriterSync, createHocuspocus } from "../yjs-ws-handler.js";

const db = createTestDatabase();
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

it.each([
  "generation",
  "selective",
] as const)("signals a $0 Discard through the real provider", async (kind) => {
  const harness = createHarness(db);
  const providers: HocuspocusProvider[] = [];
  const sockets: HocuspocusProviderWebsocket[] = [];
  const documents: Y.Doc[] = [];
  let server: Server | undefined;
  try {
    await harness.seedWriterDocument("The sacred dawn.\n\nThe courtyard waits.", "stale-signal");
    const draftId = await harness.stageCertifiedReplace({
      responseId: "first",
      find: "sacred ",
      content: "ruined ",
    });
    if (kind === "selective")
      await harness.stageCertifiedReplace({
        responseId: "second",
        find: "courtyard",
        content: "garden",
      });
    const f = harness.crossWorkProbeFixture();
    const snapshot = await f.draftStore.getDraft(draftId);
    if (!snapshot) throw new Error("missing draft");
    const roomName = `draft:${draftId}:gen:${snapshot.generation}`;
    const old = createCollabYDoc({ gc: false });
    documents.push(old);
    await f.draftCoordinator.readDraft(draftId, async (doc) => {
      Y.applyUpdate(old, Y.encodeStateAsUpdate(doc));
    });
    const review = reviewDriver(f.collab.draftReview);
    const persistence = createHocuspocusPersistenceService({
      draftStore: f.draftStore,
      draftCoordinator: f.draftCoordinator,
      hocuspocus: () => server?.hocuspocus ?? null,
    } as never);
    const gateway = createHocuspocus(
      {
        documentSync: {
          ...persistence,
          bindHocuspocus: () => undefined,
          roomRemoval: async () => null,
        },
      } as never,
      {} as never,
    );
    const onConnect = gateway.configuration.onConnect;
    if (!onConnect) throw new Error("missing production onConnect");
    const syncState = { draftSyncState: new Map() };
    let reset = false;
    server = new Server({
      address: "127.0.0.1",
      port: 0,
      quiet: true,
      stopOnSignals: false,
      onConnect: async (data) => {
        if (reset) {
          await onConnect({
            ...data,
            context: { userId: USER_ID },
          } as never);
        }
      },
      onLoadDocument: async () => {
        const read = await f.draftStore.readDraftAt(draftId);
        return read ? Y.encodeStateAsUpdate(materializeDraftRead(read)) : undefined;
      },
      beforeSync:
        kind === "selective"
          ? async ({ documentName, document, type, payload }) => {
              await admitWriterSync({
                services: { documentSync: persistence } as never,
                documentName,
                document,
                syncType: type,
                payload,
                userId: USER_ID,
                context: syncState,
              });
            }
          : undefined,
    });
    await server.listen();
    const url = server.webSocketURL;
    const open = (doc: Y.Doc) => {
      const synced = deferred<void>();
      const closed = deferred<{ code: number; reason: string }>();
      const denied = deferred<string>();
      const socket = new HocuspocusProviderWebsocket({
        url,
        WebSocketPolyfill: WebSocket,
        autoConnect: false,
      });
      sockets.push(socket);
      const provider = new HocuspocusProvider({
        name: roomName,
        document: doc,
        awareness: null,
        websocketProvider: socket,
        onSynced: () => synced.resolve(undefined),
        onClose: ({ event }) => closed.resolve({ code: event.code, reason: event.reason }),
        onAuthenticationFailed: ({ reason }) => denied.resolve(reason),
      });
      providers.push(provider);
      provider.attach();
      void socket.connect();
      return { synced: synced.promise, closed: closed.promise, denied: denied.promise };
    };
    let connected: ReturnType<typeof open> | undefined;
    if (kind === "generation") {
      connected = open(old);
      await connected.synced;
      expect(server.hocuspocus.documents.get(roomName)?.getConnectionsCount()).toBe(1);
      await review.discardItem(ALPHA_ID);
      reset = true;
      closeDraftRooms(server.hocuspocus, draftId);
      // In-band CLOSE synthesizes 1000; clients must classify the named reason.
      expect(await connected.closed).toEqual({
        code: 1000,
        reason: WS_CLOSE.DRAFT_GENERATION_STALE.reason,
      });
      const fresh = createCollabYDoc({ gc: false });
      documents.push(fresh);
      expect(await open(fresh).denied).toBe(WS_CLOSE.DRAFT_GENERATION_STALE.reason);
    } else {
      const preview = await review.activePreview(ALPHA_ID);
      expect(preview.operations).toHaveLength(2);
      expect(
        await review.discardChanges(ALPHA_ID, preview, [
          preview.operations[1]?.operationId as string,
        ]),
      ).toMatchObject({ itemClosed: false });
      expect((await f.draftStore.getDraft(draftId))?.generation).toBe(snapshot.generation + 1);
      const reconnect = createCollabYDoc({ gc: false });
      documents.push(reconnect);
      reset = true;
      const stale = open(reconnect);
      // The old room is rejected before any obsolete update is admitted.
      expect(await stale.denied).toBe(WS_CLOSE.DRAFT_GENERATION_STALE.reason);
    }
  } finally {
    for (const provider of providers) provider.destroy();
    for (const socket of sockets) socket.destroy();
    await server?.destroy();
    for (const document of documents) document.destroy();
    harness.destroyWarmState();
  }
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

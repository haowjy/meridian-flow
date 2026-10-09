/** Real-provider signals distinguish generation reset from same-generation selective Discard. */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as decoding from "lib0/decoding";
import { afterAll, beforeEach, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { createHocuspocusPersistenceService } from "../../domains/collab/hocuspocus-persistence.js";
import { closeBranchRooms } from "../../domains/collab/hocuspocus-rooms.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  USER_ID,
  WORK_ID,
} from "../../domains/collab/test-support/change-trail-postgres-harness.js";
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
    const branchId = await harness.stageCertifiedReplace({
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
    const snapshot = await f.branchStore.getBranch(branchId);
    if (!snapshot) throw new Error("missing branch");
    const roomName = `branch:${branchId}:gen:${snapshot.generation}`;
    const old = createCollabYDoc({ gc: false });
    documents.push(old);
    await f.branchCoordinator.readBranch(branchId, async (doc) => {
      Y.applyUpdate(old, Y.encodeStateAsUpdate(doc));
    });
    const request = { workId: WORK_ID, documentId: ALPHA_ID, draftId: branchId, userId: USER_ID };
    const persistence = createHocuspocusPersistenceService({
      branchStore: f.branchStore,
      branchCoordinator: f.branchCoordinator,
      hocuspocus: () => server?.hocuspocus ?? null,
    } as never);
    const gateway = createHocuspocus(
      { documentSync: { ...persistence, bindHocuspocus: () => undefined } } as never,
      {} as never,
    );
    const onConnect = gateway.configuration.onConnect;
    if (!onConnect) throw new Error("missing production onConnect");
    const syncState = { branchSyncState: new Map() };
    let reset = false;
    server = new Server({
      address: "127.0.0.1",
      port: 0,
      quiet: true,
      stopOnSignals: false,
      onConnect: async (data) => {
        if (reset && kind === "generation") {
          await onConnect({
            ...data,
            context: { userId: USER_ID },
          } as never);
        }
      },
      onLoadDocument: async () => (await f.branchStore.getBranch(branchId))?.state,
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
      // Hold SyncStep1 so the stale offline replay arrives before a passed handshake.
      class HeldHandshakeWebSocket extends WebSocket {
        override send(data: Parameters<WebSocket["send"]>[0]) {
          if (data instanceof Uint8Array) {
            const decoder = decoding.createDecoder(data);
            decoding.readVarString(decoder);
            if (decoding.readVarUint(decoder) === 0 && decoding.readVarUint(decoder) === 0) return;
          }
          super.send(data);
        }
      }
      const socket = new HocuspocusProviderWebsocket({
        url,
        WebSocketPolyfill: kind === "selective" ? HeldHandshakeWebSocket : WebSocket,
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
      await f.collab.draftReview.discardWorkDraft(request);
      reset = true;
      closeBranchRooms(server.hocuspocus, branchId);
      // In-band CLOSE synthesizes 1000; clients must classify the named reason.
      expect(await connected.closed).toEqual({
        code: 1000,
        reason: WS_CLOSE.BRANCH_GENERATION_STALE.reason,
      });
      const fresh = createCollabYDoc({ gc: false });
      documents.push(fresh);
      expect(await open(fresh).denied).toBe(WS_CLOSE.BRANCH_GENERATION_STALE.reason);
    } else {
      const preview = await f.collab.draftReview.preview(request);
      if (preview.status !== "active") throw new Error("missing review");
      expect(preview.operations).toHaveLength(2);
      expect(
        await f.collab.draftReview.discardWorkDraft({
          ...request,
          operationIds: [preview.operations[1].operationId],
          liveRevisionToken: preview.liveRevisionToken,
          draftRevisionToken: preview.draftRevisionToken,
        }),
      ).toMatchObject({ draftClosed: false });
      expect((await f.branchStore.getBranch(branchId))?.generation).toBe(snapshot.generation);
      const reconnect = createCollabYDoc({ gc: false });
      documents.push(reconnect);
      const stale = open(reconnect);
      // An offline update queued before the handshake must rebuild this generation.
      Y.applyUpdate(reconnect, Y.encodeStateAsUpdate(old), "offline");
      expect(await stale.closed).toEqual({ code: 1000, reason: WS_CLOSE.BRANCH_STALE.reason });
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

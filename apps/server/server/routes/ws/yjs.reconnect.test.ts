/** Real-provider regression coverage for reconnect writer admission. */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import type { UpdateJournal } from "@meridian/agent-edit";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { createHocuspocusPersistenceService } from "../../domains/collab/hocuspocus-persistence.js";
import { admitWriterSync } from "./yjs.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001" as never;

describe("Yjs reconnect writer admission", () => {
  it("syncs without journaling the provider's contained replay pair", async () => {
    const liveDocument = tombstoneBearingDoc();
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const onLiveUpdatePersisted = vi.fn();
    let server: Server | undefined;
    let websocketProvider: HocuspocusProviderWebsocket | undefined;
    let provider: HocuspocusProvider | undefined;
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => server?.hocuspocus ?? null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
      onLiveUpdatePersisted,
    });
    const writerFrames: Array<{ syncType: number; update: Uint8Array; admitted: boolean }> = [];

    try {
      server = new Server({
        address: "127.0.0.1",
        port: 0,
        quiet: true,
        stopOnSignals: false,
        onLoadDocument: async () => Y.encodeStateAsUpdate(liveDocument),
        beforeSync: async ({ documentName, document, type, payload }) => {
          const result = await admitWriterSync({
            services: { documentSync: persistence } as never,
            documentName,
            document,
            syncType: type,
            payload,
            userId: "user-1" as never,
          });
          if (result) {
            writerFrames.push({
              syncType: type,
              update: payload,
              admitted: result.admitted,
            });
          }
        },
      });
      await server.listen();
      const client = new Y.Doc({ gc: false });
      websocketProvider = new HocuspocusProviderWebsocket({
        url: server.webSocketURL,
        WebSocketPolyfill: WebSocket,
        autoConnect: false,
      });
      provider = new HocuspocusProvider({
        name: DOCUMENT_ID,
        document: client,
        awareness: null,
        websocketProvider,
      });
      provider.attach();
      websocketProvider.connect();

      Y.applyUpdate(client, Y.encodeStateAsUpdate(liveDocument), "indexeddb");
      await vi.waitFor(
        () => {
          expect(provider?.isSynced).toBe(true);
          expect(provider?.hasUnsyncedChanges).toBe(false);
          expect(writerFrames).toHaveLength(2);
        },
        { timeout: 3_000 },
      );

      expect(writerFrames.map(({ syncType }) => syncType)).toEqual([
        messageYjsUpdate,
        messageYjsSyncStep2,
      ]);
      expect(writerFrames.map(({ admitted }) => admitted)).toEqual([false, false]);
      expect(
        Y.decodeUpdate(writerFrames[0]?.update ?? new Uint8Array()).structs.length,
      ).toBeGreaterThan(0);
      const handshakeDeleteSet = Y.decodeUpdate(writerFrames[1]?.update ?? new Uint8Array());
      expect(handshakeDeleteSet.structs).toHaveLength(0);
      expect(handshakeDeleteSet.ds.clients.size).toBeGreaterThan(0);
      expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
      expect(onLiveUpdatePersisted).not.toHaveBeenCalled();
    } finally {
      provider?.destroy();
      websocketProvider?.destroy();
      await server?.destroy();
    }
  });
});

function tombstoneBearingDoc(): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  const text = doc.getText("content");
  text.insert(0, "seed");
  text.delete(0, text.length);
  text.insert(0, "seed replaced");
  return doc;
}

function fakeJournal(): UpdateJournal {
  return {
    append: vi.fn(async () => 1),
    appendBatch: vi.fn(async () => []),
    read: vi.fn(async () => ({ checkpoint: null, updates: [] })),
    checkpoint: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ updatesFolded: 0, reversalsExpired: 0 })),
  };
}

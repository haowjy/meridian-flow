/** Regression coverage for live-room text convergence across durable reloads.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Production Hocuspocus rooms use gc: false.
 * - A live update is durable before writer admission resolves.
 * - A room reloads accepted updates that the warm room did not receive.
 */

import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { createYjsRoomAccessIndex } from "../../lib/yjs-room-access.js";
import { admitWriterSync, createHocuspocus } from "../../lib/yjs-ws-handler.js";
import { createAllowAllFileAccess, createLocalFileAccessChanges } from "../file-policy/index.js";
import { createInMemoryEventSink } from "../observability/index.js";
import { createInMemoryJournal } from "./adapters/in-memory/agent-edit.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001" as never;
const USER_ID = "00000000-0000-4000-8000-000000000002" as never;
const SHUFFLE_SEED = 0x5eedc0df;

type WriterUpdate = {
  marker: string;
  update: Uint8Array;
};

describe("live document text convergence", () => {
  it("keeps every accepted edit across shuffled room and storage deliveries", async () => {
    const journal = createInMemoryJournal();
    const seed = createCollabYDoc({ gc: false });
    seed.getText("content").insert(0, "seed");
    await journal.seedInitialDocument(DOCUMENT_ID, Y.encodeStateAsUpdate(seed));

    let hocuspocus: ReturnType<typeof createHocuspocus>;
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => hocuspocus,
      metaForOrigin: () => ({ origin: "human:test-user", seq: 0 }),
      emitAgentEditInvariantViolation: () => undefined,
    });
    const documentSync = {
      ...persistence,
      bindHocuspocus: () => undefined,
      currentLiveGeneration: async () => 1n,
      primeReservedNamespaceIndex: () => undefined,
      roomRemoval: async () => null,
    };
    const services = {
      liveDocuments: {
        findById: async () => ({ kind: "found" as const, document: {} as never, clashesWith: [] }),
      },
      fileAccess: createAllowAllFileAccess(),
      fileAccessChanges: createLocalFileAccessChanges(),
      documentSync,
      eventSink: createInMemoryEventSink(),
      treeLists: { onCommitted: () => () => {} },
    };
    hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());

    expect(hocuspocus.configuration.yDocOptions.gc).toBe(false);

    let releaseFirstAppend: (() => void) | undefined;
    let firstAppendStarted!: () => void;
    const firstAppend = new Promise<void>((resolve) => {
      firstAppendStarted = resolve;
    });
    const appendWriterUpdate = journal.appendWriterUpdate.bind(journal);
    let holdFirstAppend = true;
    const firstAppendRelease = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    journal.appendWriterUpdate = async (...args) => {
      if (holdFirstAppend) {
        holdFirstAppend = false;
        firstAppendStarted();
        await firstAppendRelease;
      }
      return appendWriterUpdate(...args);
    };

    const firstRoom = await hocuspocus.openDirectConnection(DOCUMENT_ID, {
      userId: USER_ID,
    } as never);
    const initialState = Y.encodeStateAsUpdate(firstRoom.document as never);
    const writerA = createWriter(initialState, ["A-one", "A-two"]);
    const writerB = createWriter(initialState, ["B-one", "B-two"]);
    const updates = seededShuffle([...writerA.updates, ...writerB.updates], SHUFFLE_SEED);
    const acceptedMarkers: string[] = [];
    let connection = firstRoom;

    try {
      for (const [index, delivery] of updates.entries()) {
        const room = connection.document;
        if (!room) throw new Error("The test room disconnected before delivery");

        const admission = admitWriterSync({
          services: services as never,
          documentName: DOCUMENT_ID,
          document: room,
          syncType: messageYjsUpdate,
          payload: delivery.update,
          userId: USER_ID,
          expectedGeneration: 1n,
        });
        if (index === 0) {
          let acknowledged = false;
          const observed = admission.then(() => {
            acknowledged = true;
          });
          await firstAppend;
          await Promise.resolve();
          expect(acknowledged).toBe(false);
          releaseFirstAppend?.();
          await observed;
        } else {
          await admission;
        }

        expect(
          journal
            .updateRecords(DOCUMENT_ID)
            .some(({ update }) => equalBytes(update, delivery.update)),
        ).toBe(true);
        acceptedMarkers.push(delivery.marker);

        if (index % 2 === 0) Y.applyUpdate(room, delivery.update);
        await connection.disconnect();
        await persistence.drainHocuspocusPersistence();
        connection = await hocuspocus.openDirectConnection(DOCUMENT_ID, {
          userId: USER_ID,
        } as never);
      }

      const finalRoom = connection.document;
      if (!finalRoom) throw new Error("The test room disconnected before final assertions");
      const finalState = Y.encodeStateAsUpdate(finalRoom);
      const stored = await loadStoredDocument(persistence);
      Y.applyUpdate(writerA.document, finalState);
      Y.applyUpdate(writerB.document, finalState);
      const texts = [
        finalRoom.getText("content").toString(),
        stored.getText("content").toString(),
        writerA.document.getText("content").toString(),
        writerB.document.getText("content").toString(),
      ];

      expect(new Set(texts).size).toBe(1);
      expect(texts[0]).toContain("seed");
      for (const marker of acceptedMarkers) expect(texts[0]).toContain(marker);
      stored.destroy();
    } finally {
      await connection.disconnect();
      await persistence.drainHocuspocusPersistence();
      writerA.document.destroy();
      writerB.document.destroy();
      seed.destroy();
    }
  });
});

function createWriter(state: Uint8Array, markers: string[]) {
  const document = createCollabYDoc({ gc: false });
  Y.applyUpdate(document, state);
  const updates: WriterUpdate[] = [];
  for (const marker of markers) {
    const before = Y.encodeStateVector(document);
    document.getText("content").insert(0, marker);
    updates.push({ marker, update: Y.encodeStateAsUpdate(document, before) });
  }
  return { document, updates };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const shuffled = [...items];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const other = state % (index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function loadStoredDocument(
  persistence: ReturnType<typeof createHocuspocusPersistenceService>,
): Promise<Y.Doc> {
  const document = createCollabYDoc({ gc: false });
  const state = await persistence.loadHocuspocusDocument(DOCUMENT_ID, document);
  if (state) Y.applyUpdate(document, state);
  return document;
}

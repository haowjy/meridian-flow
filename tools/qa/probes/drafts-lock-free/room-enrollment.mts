/**
 * A draft room as a delivery recipient (decision D26), over the real gateway hooks and the
 * real Hocuspocus room lifecycle: each room loads through `createDocument`, the call a socket
 * connection makes, and each frame goes through the gateway's `admitWriterSync`, which asks for
 * the `1008` close a refused frame gets.
 *
 * - `cold-load-commit`: a pull commits while the room's load read is paused, so the room
 *   registers holding the older snapshot; its enrollment brings the commit in.
 * - `cold-load-reset`: a reset commits while the generation-1 room loads; its enrollment closes
 *   it, and the generation-2 room loads and takes frames.
 * - `dropped-delivery`: the delivery of a pull is dropped on purpose; the next frame finds its
 *   room behind, reconciles it, and is admitted with no `1008`.
 * - `read-only-handshake`: the same dropped delivery, then a tab that may only read joins; its
 *   SyncStep1, run through Hocuspocus's own sync receiver, reconciles the room first (D27), so
 *   the tab receives the committed text with no keystroke anywhere.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHocuspocusBinding } from "../../../../apps/server/server/domains/collab/adapters/hocuspocus-binding.ts";
import { createDraftCoordinator } from "../../../../apps/server/server/domains/collab/domain/draft-coordinator.ts";
import type { DraftStore } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import type { WriterFrameDiagnostics } from "../../../../apps/server/server/domains/collab/domain/draft-writer-frames.ts";
import { createHocuspocusPersistenceService } from "../../../../apps/server/server/domains/collab/hocuspocus-persistence.ts";
import {
  admitWriterSync,
  createHocuspocus,
} from "../../../../apps/server/server/lib/yjs-ws-handler.ts";
import {
  appendToFirstParagraph,
  gate,
  type Harness,
  observe,
  type Probe,
  settled,
  Y,
} from "./harness.mts";
import { rebaseLive } from "./phase4.mts";

// Hocuspocus's sync receiver and lib0's codec, resolved as the server resolves them.
const serverRequire = createRequire(
  new URL("../../../../apps/server/package.json", import.meta.url),
);
// Its ES build, the one the gateway loads: the CommonJS build would bring a second Yjs.
const { IncomingMessage, MessageReceiver } = await import(
  serverRequire.resolve("@hocuspocus/server").replace(/\.cjs$/, ".esm.js")
);
const encoding = serverRequire("lib0/encoding");
const decoding = serverRequire("lib0/decoding");

/** A Hocuspocus room, as `createDocument` resolves it. */
type Document = Awaited<ReturnType<ReturnType<typeof createHocuspocus>["createDocument"]>>;

type Reconciled = Parameters<WriterFrameDiagnostics["roomReconciled"]>[0];

/** `store` whose first `readDraftAt` holds its result until `release`, once it has `entered`. */
function pausedRead(store: DraftStore) {
  const entered = gate();
  const release = gate();
  let held = true;
  const paused: DraftStore = {
    ...store,
    async readDraftAt(...args) {
      const result = await store.readDraftAt(...args);
      if (held) {
        held = false;
        entered.open();
        await release.wait;
      }
      return result;
    },
  };
  return { paused, entered, release };
}

/**
 * One server process: the production coordinator, binding, persistence service and gateway
 * over `store`. `dropDelivery` loses the first room update the coordinator delivers.
 */
export function openGateway(
  harness: Harness,
  store: DraftStore,
  options: { dropDelivery?: boolean } = {},
) {
  const binding = createHocuspocusBinding();
  const reconciled: Reconciled[] = [];
  let drop = options.dropDelivery ?? false;
  const coordinator = createDraftCoordinator({
    onAppendCommitted: () => {},
    store,
    attemptScope: harness.attemptScope,
    onDraftUpdate(update) {
      if (drop) {
        drop = false;
        return;
      }
      binding.deliverDraftUpdate(update);
    },
    applyToRoom: binding.applyToRoom,
    diagnostics: {
      compactionFailed() {},
      appendPrefixMissing() {},
      roomReconciled: (input) => reconciled.push(input),
    },
  });
  const persistence = createHocuspocusPersistenceService({
    draftStore: store,
    draftCoordinator: coordinator,
    journal: {} as never,
    hocuspocus: () => binding.current(),
    metaForOrigin: () => ({ origin: "system", seq: 0 }) as never,
    emitAgentEditInvariantViolation: () => {},
  });
  const services = {
    documentSync: { ...persistence, bindHocuspocus: binding.bind },
    eventSink: { emit() {} },
  } as never;
  const hocuspocus = createHocuspocus(services, {} as never);
  binding.bind(hocuspocus);

  /** The room loaded as a socket's `ClientConnection` loads it; resolves once registered. */
  function load(draftId: string, generation: number): Promise<Document> {
    return hocuspocus.createDocument(
      `draft:${draftId}:gen:${generation}`,
      { headers: {}, url: "/" } as never,
      "probe-socket",
      { readOnly: false, isAuthenticated: true } as never,
      {} as never,
    );
  }

  /** A tab's keystroke on `room`, admitted as the gateway admits a socket's frame. */
  async function type(room: Document, draftId: string, generation: number, token: string) {
    const tab = new Y.Doc({ gc: false });
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
    const update = appendToFirstParagraph(tab, token);
    tab.destroy();
    return send(room, draftId, generation, update);
  }

  /**
   * `payload` as a socket's Update (`syncType` 2) or SyncStep2 (1) on `room`, through the
   * gateway's admission: the close a refusal carries, and the room applies it when admitted.
   */
  async function send(
    room: Document,
    draftId: string,
    generation: number,
    payload: Uint8Array,
    syncType = 2,
  ) {
    const result = await settled(
      admitWriterSync({
        services,
        documentName: room.name,
        document: room,
        syncType,
        payload,
        userId: harness.ids.user as never,
        context: { draftSyncState: new Map([[`${draftId}:${generation}`, "passed"]]) },
      }),
    );
    // Hocuspocus applies an admitted frame to the room.
    if (result.ok) Y.applyUpdate(room, payload, "client");
    // A refusal carries the close the gateway's removal wrapper would send.
    return { ok: result.ok, closes: result.ok ? [] : [result.message] };
  }

  /**
   * A tab holding `tab` joins `room` on a read connection and completes the Yjs handshake
   * through Hocuspocus's sync receiver and the gateway's `beforeSync` hook: its SyncStep1, then
   * its SyncStep2 answer. Everything the server sends the tab is applied to it.
   */
  async function joinReadOnly(room: Document, draftId: string, tab: Y.Doc) {
    const context = {
      traceId: "read-only-handshake",
      userId: harness.ids.user,
      draftSyncState: new Map(),
      admissionTarget: { kind: "draft", draftId, generation: 1, documentId: room.name },
      access: { level: "read" },
    };
    let serverVector: Uint8Array | undefined;
    const connection = {
      readOnly: true,
      messageAddress: room.name,
      send(data: Uint8Array) {
        const decoder = decoding.createDecoder(data);
        decoding.readVarString(decoder);
        if (decoding.readVarUint(decoder) !== 0) return;
        const step = decoding.readVarUint(decoder);
        const payload = decoding.readVarUint8Array(decoder);
        if (step === 0) serverVector = payload;
        else Y.applyUpdate(tab, payload);
      },
      callbacks: {
        beforeSync: (_: unknown, sync: { type: number; payload: Uint8Array }) =>
          // `context` holds the fields a read connection's sync consults; the rest are the socket's.
          hocuspocus.hooks("beforeSync", {
            documentName: room.name,
            document: room,
            ...sync,
            context,
          } as never),
      },
    };
    room.addConnection(connection as never);
    const exchange = async (step: number, payload: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, step);
      encoding.writeVarUint8Array(encoder, payload);
      const message = new IncomingMessage(encoding.toUint8Array(encoder));
      await new MessageReceiver(message).readSyncMessage(message, room, connection);
      return message;
    };
    const step1 = await exchange(0, Y.encodeStateVector(tab));
    // The reply Hocuspocus writes for the tab's step 1: its SyncStep2 from the room.
    const reply = decoding.createDecoder(step1.toUint8Array());
    assert.equal(decoding.readVarUint(reply), 1);
    Y.applyUpdate(tab, decoding.readVarUint8Array(reply));
    assert(serverVector, "the room asked for the tab's state");
    await exchange(1, Y.encodeStateAsUpdate(tab, serverVector));
    room.removeConnection(connection as never);
  }

  return {
    coordinator,
    hocuspocus,
    reconciled,
    load,
    type,
    send,
    joinReadOnly,
    /** Waits out every enrollment the draft's rooms started. */
    enrolled: (draftId: string) => persistence.drainHocuspocusDraftPersistence(draftId),
    async close() {
      for (const document of [...hocuspocus.documents.values()])
        await hocuspocus.unloadDocument(document);
    },
  };
}

const text = (doc: Y.Doc) => doc.getXmlFragment("prosemirror").toString();

async function seedDraft(harness: Harness, label: string) {
  const { branchId } = await harness.seedWork(label);
  const { documentId, live } = await harness.seedDocument(label, "Base");
  const documentDraft = await harness.store.ensureDocumentDraft({
    documentId,
    branchId,
    liveDoc: live,
  });
  return { draftId: documentDraft.draftId, documentId, live };
}

export const coldLoadCommit: Probe = {
  name: "cold-load-commit",
  decision: "D26",
  expected: `room after registration holds COMMITTED; next: {"ok":true,"closes":[]}; one enrollment repair`,
  async run(harness) {
    const { draftId, documentId, live } = await seedDraft(harness, "cold-load-commit");
    const pause = pausedRead(harness.store);
    const gateway = openGateway(harness, pause.paused);
    try {
      const loading = gateway.load(draftId, 1);
      await pause.entered.wait;
      appendToFirstParagraph(live, " COMMITTED");
      await rebaseLive(harness, gateway.coordinator, documentId, live);
      pause.release.open();
      const room = await loading;
      const registered = text(room);
      await gateway.enrolled(draftId);
      const enrolled = text(room);
      const next = await gateway.type(room, draftId, 1, " NEXT");
      const durable = (await harness.readDraft(draftId)).text;
      observe("load", { registered, enrolled, durable });
      observe("next", next);
      observe(
        "reconciled",
        gateway.reconciled.map(({ trigger }) => trigger),
      );
      assert.doesNotMatch(registered, /COMMITTED/, "the load read the older snapshot");
      assert.match(enrolled, /Base COMMITTED/);
      assert.deepEqual(next, { ok: true, closes: [] });
      assert.match(durable, /COMMITTED NEXT/);
      assert.deepEqual(
        gateway.reconciled.map(({ trigger }) => trigger),
        ["enrollment"],
      );
    } finally {
      live.destroy();
      await gateway.close();
    }
  },
};

export const droppedDelivery: Probe = {
  name: "dropped-delivery",
  decision: "D26",
  expected: `room lacks LIVE after the dropped delivery; next: {"ok":true,"closes":[]}; one frame repair`,
  async run(harness) {
    const { draftId, documentId, live } = await seedDraft(harness, "dropped-delivery");
    const gateway = openGateway(harness, harness.store, { dropDelivery: true });
    try {
      const room = await gateway.load(draftId, 1);
      await gateway.enrolled(draftId);
      appendToFirstParagraph(live, " LIVE");
      await rebaseLive(harness, gateway.coordinator, documentId, live);
      const behind = text(room);
      const next = await gateway.type(room, draftId, 1, " NEXT");
      const durable = (await harness.readDraft(draftId)).text;
      observe("drop", { behind, durable });
      observe("next", { ...next, room: text(room) });
      observe("reconciled", gateway.reconciled);
      assert.doesNotMatch(behind, /LIVE/, "the pull's delivery was dropped");
      assert.deepEqual(next, { ok: true, closes: [] });
      // The tab typed NEXT without seeing LIVE: both land, in Yjs's order for concurrent inserts.
      assert.match(durable, /LIVE/);
      assert.match(durable, /NEXT/);
      assert.equal(text(room), durable);
      assert.deepEqual(
        gateway.reconciled.map(({ trigger }) => trigger),
        ["frame"],
      );
    } finally {
      live.destroy();
      await gateway.close();
    }
  },
};

export const readOnlyHandshake: Probe = {
  name: "read-only-handshake",
  decision: "D27",
  expected: `room and read-only tab lack LIVE after the dropped delivery; after the tab's handshake both hold it; one handshake repair`,
  async run(harness) {
    const { draftId, documentId, live } = await seedDraft(harness, "read-only-handshake");
    const gateway = openGateway(harness, harness.store, { dropDelivery: true });
    const tab = new Y.Doc({ gc: false });
    try {
      const room = await gateway.load(draftId, 1);
      await gateway.enrolled(draftId);
      Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
      appendToFirstParagraph(live, " LIVE");
      await rebaseLive(harness, gateway.coordinator, documentId, live);
      const behind = { room: text(room), tab: text(tab) };
      await gateway.joinReadOnly(room, draftId, tab);
      const durable = (await harness.readDraft(draftId)).text;
      const triggers = gateway.reconciled.map(({ trigger }) => trigger);
      observe("drop", { behind, durable });
      observe("joined", { room: text(room), tab: text(tab) });
      observe("reconciled", triggers);
      assert.doesNotMatch(behind.room, /LIVE/, "the pull's delivery was dropped");
      assert.doesNotMatch(behind.tab, /LIVE/);
      assert.match(durable, /Base LIVE/);
      assert.equal(text(room), durable);
      assert.equal(text(tab), durable);
      assert.deepEqual(triggers, ["handshake"]);
    } finally {
      tab.destroy();
      live.destroy();
      await gateway.close();
    }
  },
};

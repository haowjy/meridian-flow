/**
 * A branch room as a delivery recipient (decision D26), over the real gateway hooks and the
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
import { createBranchCoordinator } from "../../../../apps/server/server/domains/collab/domain/branch-coordinator.ts";
import type { BranchStore } from "../../../../apps/server/server/domains/collab/domain/branch-store.ts";
import type { WriterFrameDiagnostics } from "../../../../apps/server/server/domains/collab/domain/branch-writer-frames.ts";
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

/** `store` whose first `readBranchAt` holds its result until `release`, once it has `entered`. */
function pausedRead(store: BranchStore) {
  const entered = gate();
  const release = gate();
  let held = true;
  const paused: BranchStore = {
    ...store,
    async readBranchAt(...args) {
      const result = await store.readBranchAt(...args);
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
 * over `store`. `dropDelivery` loses the first room update the coordinator publishes.
 */
function openGateway(
  harness: Harness,
  store: BranchStore,
  options: { dropDelivery?: boolean } = {},
) {
  const binding = createHocuspocusBinding();
  const reconciled: Reconciled[] = [];
  let drop = options.dropDelivery ?? false;
  const coordinator = createBranchCoordinator({
    store,
    attemptScope: harness.attemptScope,
    onBranchUpdate(update) {
      if (drop) {
        drop = false;
        return;
      }
      binding.publishBranchUpdate(update);
    },
    onBranchReset: ({ branchId, generation }) => binding.closeBranch(branchId, generation),
    applyToRoom: binding.applyToRoom,
    diagnostics: {
      frameRetried() {},
      compactionFailed() {},
      roomReconciled: (input) => reconciled.push(input),
    },
  });
  const persistence = createHocuspocusPersistenceService({
    branchStore: store,
    branchCoordinator: coordinator,
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
  function load(branchId: string, generation: number): Promise<Document> {
    return hocuspocus.createDocument(
      `branch:${branchId}:gen:${generation}`,
      { headers: {}, url: "/" } as never,
      "probe-socket",
      { readOnly: false, isAuthenticated: true } as never,
      {} as never,
    );
  }

  /** A tab's keystroke on `room`, admitted as the gateway admits a socket's frame. */
  async function type(room: Document, branchId: string, generation: number, token: string) {
    const tab = new Y.Doc({ gc: false });
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
    const update = appendToFirstParagraph(tab, token);
    tab.destroy();
    const closes: { code: number; reason: string }[] = [];
    const result = await settled(
      admitWriterSync({
        services,
        documentName: room.name,
        document: room,
        syncType: 2,
        payload: update,
        userId: harness.ids.user as never,
        context: { branchSyncState: new Map([[`${branchId}:${generation}`, "passed"]]) },
        closeTransport: (close) => closes.push(close),
      }),
    );
    // Hocuspocus applies an admitted frame to the room.
    if (result.ok) Y.applyUpdate(room, update, "client");
    return { ok: result.ok, closes };
  }

  /**
   * A tab holding `tab` joins `room` on a read connection and completes the Yjs handshake
   * through Hocuspocus's sync receiver and the gateway's `beforeSync` hook: its SyncStep1, then
   * its SyncStep2 answer. Everything the server sends the tab is applied to it.
   */
  async function joinReadOnly(room: Document, branchId: string, tab: Y.Doc) {
    const context = {
      traceId: "read-only-handshake",
      userId: harness.ids.user,
      branchSyncState: new Map(),
      admissionTarget: { kind: "branch", branchId, generation: 1, documentId: room.name },
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
    joinReadOnly,
    /** Waits out every enrollment the branch's rooms started. */
    enrolled: (branchId: string) => persistence.drainHocuspocusBranchPersistence(branchId),
    async close() {
      for (const document of [...hocuspocus.documents.values()])
        await hocuspocus.unloadDocument(document);
    },
  };
}

const text = (doc: Y.Doc) => doc.getXmlFragment("prosemirror").toString();

async function seedDraft(harness: Harness, label: string) {
  const { draftId } = await harness.seedWork(label);
  const { documentId, live } = await harness.seedDocument(label, "Base");
  const branch = await harness.store.ensureDraftBranch({ documentId, draftId, liveDoc: live });
  return { branchId: branch.branchId, live };
}

export const coldLoadCommit: Probe = {
  name: "cold-load-commit",
  decision: "D26",
  expected: `room after registration holds COMMITTED; next: {"ok":true,"closes":[]}; one enrollment repair`,
  async run(harness) {
    const { branchId, live } = await seedDraft(harness, "cold-load-commit");
    const pause = pausedRead(harness.store);
    const gateway = openGateway(harness, pause.paused);
    try {
      const loading = gateway.load(branchId, 1);
      await pause.entered.wait;
      appendToFirstParagraph(live, " COMMITTED");
      const pulled = await gateway.coordinator.pullFromDoc({ branchId, upstream: live });
      pause.release.open();
      const room = await loading;
      const registered = text(room);
      await gateway.enrolled(branchId);
      const enrolled = text(room);
      const next = await gateway.type(room, branchId, 1, " NEXT");
      const durable = (await harness.readBranch(branchId)).text;
      observe("load", { pulled, registered, enrolled, durable });
      observe("next", next);
      observe(
        "reconciled",
        gateway.reconciled.map(({ trigger }) => trigger),
      );
      assert.equal(pulled, "pulled");
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

export const coldLoadReset: Probe = {
  name: "cold-load-reset",
  decision: "D26",
  expected: `generation-1 room closed once registered; generation-2 room takes the next frame`,
  async run(harness) {
    const { branchId, live } = await seedDraft(harness, "cold-load-reset");
    const pause = pausedRead(harness.store);
    const gateway = openGateway(harness, pause.paused);
    try {
      const loading = gateway.load(branchId, 1);
      await pause.entered.wait;
      appendToFirstParagraph(live, " RESET");
      const reset = await gateway.coordinator.resetFromDoc({
        branchId,
        upstream: live,
        expectedGeneration: 1,
        policy: "fold",
      });
      // This process learns of generation 2 before the paused generation-1 load returns.
      await gateway.coordinator.readBranch(branchId, async () => {});
      pause.release.open();
      const old = await loading;
      const registered = gateway.hocuspocus.documents.get(old.name) === old;
      await gateway.enrolled(branchId);
      const afterEnrollment = gateway.hocuspocus.documents.has(old.name);
      const current = await gateway.load(branchId, 2);
      await gateway.enrolled(branchId);
      const next = await gateway.type(current, branchId, 2, " NEXT");
      const durable = await harness.readBranch(branchId);
      observe("reset", { reset, registered, afterEnrollment, generation: durable.generation });
      observe("next", { ...next, room: text(current), durable: durable.text });
      assert.equal(reset, true);
      assert.equal(registered, true);
      assert.equal(afterEnrollment, false, "the generation-1 room is closed");
      assert.deepEqual(next, { ok: true, closes: [] });
      assert.match(durable.text, /RESET NEXT/);
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
    const { branchId, live } = await seedDraft(harness, "dropped-delivery");
    const gateway = openGateway(harness, harness.store, { dropDelivery: true });
    try {
      const room = await gateway.load(branchId, 1);
      await gateway.enrolled(branchId);
      appendToFirstParagraph(live, " LIVE");
      const pulled = await gateway.coordinator.pullFromDoc({ branchId, upstream: live });
      const behind = text(room);
      const next = await gateway.type(room, branchId, 1, " NEXT");
      const durable = (await harness.readBranch(branchId)).text;
      observe("drop", { pulled, behind, durable });
      observe("next", { ...next, room: text(room) });
      observe("reconciled", gateway.reconciled);
      assert.equal(pulled, "pulled");
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
    const { branchId, live } = await seedDraft(harness, "read-only-handshake");
    const gateway = openGateway(harness, harness.store, { dropDelivery: true });
    const tab = new Y.Doc({ gc: false });
    try {
      const room = await gateway.load(branchId, 1);
      await gateway.enrolled(branchId);
      Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
      appendToFirstParagraph(live, " LIVE");
      const pulled = await gateway.coordinator.pullFromDoc({ branchId, upstream: live });
      const behind = { room: text(room), tab: text(tab) };
      await gateway.joinReadOnly(room, branchId, tab);
      const durable = (await harness.readBranch(branchId)).text;
      const triggers = gateway.reconciled.map(({ trigger }) => trigger);
      observe("drop", { pulled, behind, durable });
      observe("joined", { room: text(room), tab: text(tab) });
      observe("reconciled", triggers);
      assert.equal(pulled, "pulled");
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

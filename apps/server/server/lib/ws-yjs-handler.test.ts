import {
  decodeYjsBinaryEnvelope,
  encodeYjsBinaryEnvelope,
  parseYjsServerControlFrame,
  type YjsClientControlFrame,
  type YjsServerControlFrame,
} from "@meridian/contracts/protocol";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it, vi } from "vitest";
import { updateYFragment } from "y-prosemirror";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { createInMemoryDocumentStore } from "../domains/collab/adapters/in-memory/index.js";
import { createDocumentSyncService } from "../domains/collab/domain/document-sync-service.js";
import { markdownToNode } from "../domains/collab/domain/schemas.js";
import type { DocumentSyncTransport, UpdateOrigin } from "../domains/collab/index.js";
import { Err, Ok, type Result } from "../shared/result.js";
import type { AppServices } from "./app.js";
import {
  createYjsWsHandler,
  MSG_SYNC,
  type YjsWsHandlerDeps,
  type YjsWsPeer,
} from "./ws-yjs-handler.js";

const DOC = "00000000-0000-0000-0000-000000000001";
const DOC_A = "00000000-0000-0000-0000-00000000000a";
const DOC_B = "00000000-0000-0000-0000-00000000000b";

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`Expected Ok result: ${JSON.stringify(result.error)}`);
  return result.value;
}

class HarnessClient {
  readonly doc = new Y.Doc();

  constructor(private readonly sendToServer: (data: Uint8Array) => void) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.sendToServer(encoding.toUint8Array(encoder));
    });
  }

  receiveFromServer(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== MSG_SYNC) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
    if (encoding.length(encoder) > 1) {
      this.sendToServer(encoding.toUint8Array(encoder));
    }
  }
}

class HarnessPeer implements YjsWsPeer {
  readonly context;
  readonly controls: YjsServerControlFrame[] = [];
  readonly binaryByChannel = new Map<number, Uint8Array[]>();
  private readonly clients = new Map<number, HarnessClient>();

  constructor(private readonly onMessage: (peer: HarnessPeer, data: string | Uint8Array) => void) {
    this.context = {
      app: {} as unknown as AppServices,
      userId: "user-1",
    };
  }

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      const frame = parseYjsServerControlFrame(data);
      if (!frame) throw new Error(`Malformed server control frame: ${data}`);
      this.controls.push(frame);
      return;
    }

    const frame = decodeYjsBinaryEnvelope(data);
    if (!frame) throw new Error("Malformed server binary frame");
    const entries = this.binaryByChannel.get(frame.channelIndex) ?? [];
    entries.push(frame.payload);
    this.binaryByChannel.set(frame.channelIndex, entries);
    this.clients.get(frame.channelIndex)?.receiveFromServer(frame.payload);
  }

  close(): void {
    // no-op for this protocol harness
  }

  attachClient(channelIndex: number, client: HarnessClient): void {
    this.clients.set(channelIndex, client);
    for (const payload of this.binaryByChannel.get(channelIndex) ?? []) {
      client.receiveFromServer(payload);
    }
  }

  receiveControl(frame: YjsClientControlFrame): void {
    this.onMessage(this, JSON.stringify(frame));
  }

  receiveBinaryFromClient(channelIndex: number, payload: Uint8Array): void {
    this.onMessage(this, encodeYjsBinaryEnvelope(channelIndex, payload));
  }
}

function createMemoryTransport(doc: Y.Doc, origins: UpdateOrigin[]): DocumentSyncTransport {
  return {
    async getDoc() {
      return Ok(doc);
    },
    async applyUpdate(_documentId, update, origin) {
      origins.push(origin);
      Y.applyUpdate(doc, update, origin);
      return Ok(undefined);
    },
    async encodeState() {
      return Ok(Y.encodeStateAsUpdate(doc));
    },
  };
}

async function flushQueues(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function replaceClientMarkdown(clientDoc: Y.Doc, markdown: string): void {
  clientDoc.transact(() => {
    updateYFragment(
      clientDoc,
      clientDoc.getXmlFragment("prosemirror"),
      markdownToNode("document", markdown),
      {
        mapping: new Map(),
        isOMark: new Map(),
      },
    );
  });
}

async function subscribe(peer: HarnessPeer, documentId: string): Promise<number> {
  const controlStart = peer.controls.length;
  peer.receiveControl({ type: "subscribe", documentId });
  await flushQueues();

  const subscribed = peer.controls
    .slice(controlStart)
    .find((frame) => frame.type === "subscribed" && frame.documentId === documentId);
  expect(subscribed).toBeDefined();
  return subscribed?.type === "subscribed" ? subscribed.channelIndex : -1;
}

function attachClient(peer: HarnessPeer, channelIndex: number): HarnessClient {
  const client = new HarnessClient((data) => peer.receiveBinaryFromClient(channelIndex, data));
  peer.attachClient(channelIndex, client);
  return client;
}

function createTestYjsWsHandler(
  deps: Omit<YjsWsHandlerDeps, "canAccessDocument"> & {
    canAccessDocument?: YjsWsHandlerDeps["canAccessDocument"];
    afterCommit?: (documentId: string) => Promise<void> | void;
  },
) {
  const { afterCommit, commitEditorUpdate, transport, ...rest } = deps;
  return createYjsWsHandler({
    transport,
    canAccessDocument: async () => true,
    commitEditorUpdate:
      commitEditorUpdate ??
      (async (documentId, update, origin) => {
        const result = await transport.applyUpdate(documentId, update, origin);
        if (!result.ok) throw new Error(`${result.error.code}: ${documentId}`);
        await afterCommit?.(documentId);
      }),
    ...rest,
  });
}

describe("createYjsWsHandler", () => {
  it("converges two clients through multiplexed channels", async () => {
    const serverDoc = new Y.Doc();
    const origins: UpdateOrigin[] = [];
    const handler = createTestYjsWsHandler({
      transport: createMemoryTransport(serverDoc, origins),
      updateOrigin: () => ({ type: "user", userId: "user-1" }),
    });

    const peerA = new HarnessPeer((peer, data) => handler.message(peer, data));
    const peerB = new HarnessPeer((peer, data) => handler.message(peer, data));
    handler.open(peerA);
    handler.open(peerB);
    const channelA = await subscribe(peerA, "doc-1");
    const channelB = await subscribe(peerB, "doc-1");
    const clientA = attachClient(peerA, channelA);
    const clientB = attachClient(peerB, channelB);
    await flushQueues();

    clientA.doc.getText("body").insert(0, "shared body");
    await flushQueues();

    expect(clientB.doc.getText("body").toString()).toBe("shared body");
    expect(serverDoc.getText("body").toString()).toBe("shared body");
    expect(origins).toContainEqual({ type: "user", userId: "user-1" });

    handler.close(peerA);
    handler.close(peerB);
  });

  it("shares one DocState for concurrent first subscribes to the same document", async () => {
    const loadDoc = deferred<Y.Doc>();
    const serverDoc = new Y.Doc();
    const origins: UpdateOrigin[] = [];
    let getDocCalls = 0;
    const transport: DocumentSyncTransport = {
      async getDoc() {
        getDocCalls += 1;
        return Ok(await loadDoc.promise);
      },
      async applyUpdate(_documentId, update, origin) {
        origins.push(origin);
        Y.applyUpdate(serverDoc, update, origin);
        return Ok(undefined);
      },
      async encodeState() {
        return Ok(Y.encodeStateAsUpdate(serverDoc));
      },
    };
    const handler = createTestYjsWsHandler({
      transport,
      updateOrigin: () => ({ type: "user", userId: "user-1" }),
    });
    const peerA = new HarnessPeer((peer, data) => handler.message(peer, data));
    const peerB = new HarnessPeer((peer, data) => handler.message(peer, data));
    handler.open(peerA);
    handler.open(peerB);

    peerA.receiveControl({ type: "subscribe", documentId: DOC });
    peerB.receiveControl({ type: "subscribe", documentId: DOC });
    await flushQueues();
    expect(getDocCalls).toBe(1);

    loadDoc.resolve(serverDoc);
    await flushQueues();

    const subscribedA = peerA.controls.find(
      (frame) => frame.type === "subscribed" && frame.documentId === DOC,
    );
    const subscribedB = peerB.controls.find(
      (frame) => frame.type === "subscribed" && frame.documentId === DOC,
    );
    expect(subscribedA).toEqual({ type: "subscribed", documentId: DOC, channelIndex: 0 });
    expect(subscribedB).toEqual({ type: "subscribed", documentId: DOC, channelIndex: 0 });

    const clientA = attachClient(peerA, 0);
    const clientB = attachClient(peerB, 0);
    await flushQueues();
    clientA.doc.getText("body").insert(0, "shared from single-flight");
    await flushQueues();

    expect(clientB.doc.getText("body").toString()).toBe("shared from single-flight");
    expect(serverDoc.getText("body").toString()).toBe("shared from single-flight");
    expect(origins).toContainEqual({ type: "user", userId: "user-1" });

    handler.close(peerA);
    handler.close(peerB);
  });

  it("does not recreate peer state when the socket closes during access check", async () => {
    const access = deferred<boolean>();
    const serverDoc = new Y.Doc();
    let getDocCalls = 0;
    const transport: DocumentSyncTransport = {
      async getDoc() {
        getDocCalls += 1;
        return Ok(serverDoc);
      },
      async applyUpdate(_documentId, update, origin) {
        Y.applyUpdate(serverDoc, update, origin);
        return Ok(undefined);
      },
      async encodeState() {
        return Ok(Y.encodeStateAsUpdate(serverDoc));
      },
    };
    const handler = createTestYjsWsHandler({
      transport,
      canAccessDocument: async () => access.promise,
    });
    const peer = new HarnessPeer((p, data) => handler.message(p, data));
    handler.open(peer);

    peer.receiveControl({ type: "subscribe", documentId: DOC });
    await flushQueues();
    handler.close(peer);
    access.resolve(true);
    await flushQueues();

    expect(getDocCalls).toBe(0);
    expect(peer.controls).toHaveLength(0);
  });

  it("removes pending first-subscriber entries after all subscribers disconnect", async () => {
    const loadDoc = deferred<Y.Doc>();
    const serverDoc = new Y.Doc();
    const onSpy = vi.spyOn(serverDoc, "on");
    const offSpy = vi.spyOn(serverDoc, "off");
    let getDocCalls = 0;
    const transport: DocumentSyncTransport = {
      async getDoc() {
        getDocCalls += 1;
        return Ok(await loadDoc.promise);
      },
      async applyUpdate(_documentId, update, origin) {
        Y.applyUpdate(serverDoc, update, origin);
        return Ok(undefined);
      },
      async encodeState() {
        return Ok(Y.encodeStateAsUpdate(serverDoc));
      },
    };
    const handler = createTestYjsWsHandler({ transport });
    const peerA = new HarnessPeer((p, data) => handler.message(p, data));
    const peerB = new HarnessPeer((p, data) => handler.message(p, data));
    const updateOnCalls = () =>
      onSpy.mock.calls.filter(([eventName]) => eventName === "update").length;
    const updateOffCalls = () =>
      offSpy.mock.calls.filter(([eventName]) => eventName === "update").length;

    try {
      handler.open(peerA);
      handler.open(peerB);

      peerA.receiveControl({ type: "subscribe", documentId: DOC });
      peerB.receiveControl({ type: "subscribe", documentId: DOC });
      await flushQueues();
      expect(getDocCalls).toBe(1);

      handler.close(peerA);
      handler.close(peerB);
      loadDoc.resolve(serverDoc);
      await flushQueues();
      expect(peerA.controls).toHaveLength(0);
      expect(peerB.controls).toHaveLength(0);
      expect(updateOnCalls()).toBe(1);
      expect(updateOffCalls()).toBe(1);

      const peerC = new HarnessPeer((p, data) => handler.message(p, data));
      handler.open(peerC);
      peerC.receiveControl({ type: "subscribe", documentId: DOC });
      await flushQueues();

      expect(getDocCalls).toBe(2);
      expect(updateOnCalls()).toBe(2);
      expect(updateOffCalls()).toBe(1);
      expect(peerC.controls).toContainEqual({
        type: "subscribed",
        documentId: DOC,
        channelIndex: 0,
      });

      handler.close(peerC);
      expect(updateOffCalls()).toBe(2);
    } finally {
      onSpy.mockRestore();
      offSpy.mockRestore();
    }
  });

  it("keeps two documents isolated on one socket", async () => {
    const store = createInMemoryDocumentStore();
    const service = createDocumentSyncService(store, { compaction: false });
    await service.getOrCreateMirror(DOC_A, "doc a", "markdown");
    await service.getOrCreateMirror(DOC_B, "doc b", "markdown");
    const handler = createTestYjsWsHandler({
      transport: service,
    });
    const peer = new HarnessPeer((p, data) => handler.message(p, data));
    handler.open(peer);

    const channelA = await subscribe(peer, DOC_A);
    const channelB = await subscribe(peer, DOC_B);
    const clientA = attachClient(peer, channelA);
    attachClient(peer, channelB);
    await flushQueues();
    const docBBinaryCount = peer.binaryByChannel.get(channelB)?.length ?? 0;

    replaceClientMarkdown(clientA.doc, "doc a edited");
    await flushQueues();

    expect(unwrap(await service.readAsMarkdown(DOC_A))).toBe("doc a edited");
    expect(unwrap(await service.readAsMarkdown(DOC_B))).toBe("doc b");
    expect(peer.binaryByChannel.get(channelB)?.length ?? 0).toBe(docBBinaryCount);

    handler.close(peer);
  });

  it("serializes subscribe followed by immediate unsubscribe on one socket", async () => {
    const access = deferred<boolean>();
    const serverDoc = new Y.Doc();
    const origins: UpdateOrigin[] = [];
    const handler = createTestYjsWsHandler({
      transport: createMemoryTransport(serverDoc, origins),
      canAccessDocument: async () => access.promise,
    });
    const peer = new HarnessPeer((p, data) => handler.message(p, data));
    handler.open(peer);

    peer.receiveControl({ type: "subscribe", documentId: DOC });
    peer.receiveControl({ type: "unsubscribe", documentId: DOC });
    await flushQueues();
    expect(peer.controls).toHaveLength(0);

    access.resolve(true);
    await flushQueues();

    expect(peer.controls).toContainEqual({ type: "subscribed", documentId: DOC, channelIndex: 0 });

    const controlStart = peer.controls.length;
    peer.receiveControl({ type: "subscribe", documentId: DOC });
    await flushQueues();

    const resubscribed = peer.controls
      .slice(controlStart)
      .find((frame) => frame.type === "subscribed" && frame.documentId === DOC);
    expect(resubscribed).toEqual({ type: "subscribed", documentId: DOC, channelIndex: 1 });

    handler.close(peer);
  });

  it("disposes a channel when initialization fails after registration", async () => {
    const serverDoc = new Y.Doc();
    const origins: UpdateOrigin[] = [];
    const handler = createTestYjsWsHandler({
      transport: createMemoryTransport(serverDoc, origins),
    });
    const peer = new HarnessPeer((p, data) => handler.message(p, data));
    const originalStore = serverDoc.store;
    let failStoreRead = true;
    Object.defineProperty(serverDoc, "store", {
      configurable: true,
      get() {
        if (failStoreRead) {
          failStoreRead = false;
          throw new Error("init failed");
        }
        return originalStore;
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    handler.open(peer);

    try {
      peer.receiveControl({ type: "subscribe", documentId: DOC });
      await flushQueues();

      expect(peer.controls).toContainEqual({
        type: "error",
        code: "internal",
        reason: "Channel initialization failed",
        documentId: DOC,
        channelIndex: 0,
      });

      const controlStart = peer.controls.length;
      peer.receiveControl({ type: "subscribe", documentId: DOC });
      await flushQueues();

      const resubscribed = peer.controls
        .slice(controlStart)
        .find((frame) => frame.type === "subscribed" && frame.documentId === DOC);
      expect(resubscribed).toEqual({ type: "subscribed", documentId: DOC, channelIndex: 1 });
    } finally {
      handler.close(peer);
      Object.defineProperty(serverDoc, "store", { configurable: true, value: originalStore });
      errorSpy.mockRestore();
    }
  });

  it("isolates subscribe errors without closing other channels", async () => {
    const store = createInMemoryDocumentStore();
    const service = createDocumentSyncService(store, { compaction: false });
    await service.getOrCreateMirror(DOC_A, "allowed", "markdown");
    const handler = createTestYjsWsHandler({
      transport: service,
      canAccessDocument: async (_userId, documentId) => documentId !== DOC_B,
    });
    const peer = new HarnessPeer((p, data) => handler.message(p, data));
    handler.open(peer);

    peer.receiveControl({ type: "subscribe", documentId: DOC_B });
    await flushQueues();
    expect(peer.controls).toContainEqual({
      type: "error",
      code: "document_not_found",
      reason: "Document not found",
      documentId: DOC_B,
    });

    const channelA = await subscribe(peer, DOC_A);
    const clientA = attachClient(peer, channelA);
    await flushQueues();
    replaceClientMarkdown(clientA.doc, "still works");
    await flushQueues();

    expect(unwrap(await service.readAsMarkdown(DOC_A))).toBe("still works");
    handler.close(peer);
  });

  it("does not persist a handshake that contributes no new state", async () => {
    const store = createInMemoryDocumentStore();
    const service = createDocumentSyncService(store, { compaction: false });
    await service.getOrCreateMirror(DOC, "server body", "markdown");

    const handler = createTestYjsWsHandler({
      transport: service,
      updateOrigin: () => ({ type: "user", userId: "user-1" }),
    });

    const peer = new HarnessPeer((p, data) => handler.message(p, data));
    handler.open(peer);
    const channel = await subscribe(peer, DOC);
    attachClient(peer, channel);
    await flushQueues();

    const updates = await store.listUpdatesAfter(DOC, 0);
    expect(updates).toHaveLength(1);
    expect(updates[0].originType).toBe("system");
    expect(unwrap(await service.readAsMarkdown(DOC))).toBe("server body");

    handler.close(peer);
  });

  it("persists a real edit as an incremental user-attributed delta", async () => {
    const store = createInMemoryDocumentStore();
    const service = createDocumentSyncService(store, { compaction: false });
    await service.getOrCreateMirror(DOC, "server body", "markdown");

    const handler = createTestYjsWsHandler({
      transport: service,
      updateOrigin: () => ({ type: "user", userId: "user-1" }),
    });

    const peer = new HarnessPeer((p, data) => handler.message(p, data));
    handler.open(peer);
    const channel = await subscribe(peer, DOC);
    const client = attachClient(peer, channel);
    await flushQueues();

    replaceClientMarkdown(client.doc, "server body edited by ws");
    await flushQueues();

    const updates = await store.listUpdatesAfter(DOC, 0);
    expect(updates).toHaveLength(2);
    const edit = updates[1];
    expect(edit.originType).toBe("user");
    expect(edit.actorUserId).toBe("user-1");
    expect(unwrap(await service.readAsMarkdown(DOC))).toBe("server body edited by ws");

    const fullState = unwrap(await service.encodeState(DOC));
    expect(Buffer.from(edit.updateData).equals(Buffer.from(fullState))).toBe(false);

    handler.close(peer);
  });

  it("does not mutate the authoritative doc when persistence fails", async () => {
    const serverDoc = new Y.Doc();
    serverDoc.getText("body").insert(0, "durable");
    const transport: DocumentSyncTransport = {
      async getDoc() {
        return Ok(serverDoc);
      },
      async encodeState() {
        return Ok(Y.encodeStateAsUpdate(serverDoc));
      },
      async applyUpdate() {
        return Err({ code: "not_found", documentId: DOC });
      },
    };
    const handler = createTestYjsWsHandler({ transport });
    const peer = new HarnessPeer((p, data) => handler.message(p, data));
    handler.open(peer);
    const channel = await subscribe(peer, DOC);
    const client = attachClient(peer, channel);
    await flushQueues();

    client.doc.getText("body").insert(client.doc.getText("body").length, " ahead");
    await flushQueues();

    expect(serverDoc.getText("body").toString()).toBe("durable");

    handler.close(peer);
  });

  it("refreshes the markdown projection after a persisted WS edit", async () => {
    const store = createInMemoryDocumentStore();
    const service = createDocumentSyncService(store, { compaction: false });
    await service.getOrCreateMirror(DOC, "before projection", "markdown");

    let projection = {
      markdown: "before projection",
      sizeBytes: Buffer.byteLength("before projection", "utf8"),
      updatedAt: 0,
    };
    const handler = createTestYjsWsHandler({
      transport: service,
      async afterCommit(documentId) {
        const markdown = unwrap(await service.readAsMarkdown(documentId));
        projection = {
          markdown,
          sizeBytes: Buffer.byteLength(markdown, "utf8"),
          updatedAt: projection.updatedAt + 1,
        };
      },
    });

    const peer = new HarnessPeer((p, data) => handler.message(p, data));
    handler.open(peer);
    const channel = await subscribe(peer, DOC);
    const client = attachClient(peer, channel);
    await flushQueues();
    replaceClientMarkdown(client.doc, "after projection");
    await flushQueues();

    expect(projection).toEqual({
      markdown: "after projection",
      sizeBytes: Buffer.byteLength("after projection", "utf8"),
      updatedAt: 1,
    });

    handler.close(peer);
  });

  it("does not let an older interleaved projection refresh overwrite the latest WS edit", async () => {
    const store = createInMemoryDocumentStore();
    const service = createDocumentSyncService(store, { compaction: false });
    await service.getOrCreateMirror(DOC, "initial projection", "markdown");

    const firstProjectionRead = deferred();
    const releaseFirstProjectionWrite = deferred();
    let afterPersistCalls = 0;
    let projection = {
      markdown: "initial projection",
      persistedSeq: 1,
    };

    const handler = createTestYjsWsHandler({
      transport: service,
      async afterCommit(documentId) {
        afterPersistCalls += 1;
        const markdown = unwrap(await service.readAsMarkdown(documentId));
        const head = await store.getHead(documentId);
        const persistedSeq = head?.latestUpdateSeq ?? 0;

        if (afterPersistCalls === 1) {
          firstProjectionRead.resolve();
          await releaseFirstProjectionWrite.promise;
        }

        if (persistedSeq >= projection.persistedSeq) {
          projection = { markdown, persistedSeq };
        }
      },
    });

    const peerA = new HarnessPeer((p, data) => handler.message(p, data));
    const peerB = new HarnessPeer((p, data) => handler.message(p, data));
    handler.open(peerA);
    handler.open(peerB);
    const channelA = await subscribe(peerA, DOC);
    const channelB = await subscribe(peerB, DOC);
    const clientA = attachClient(peerA, channelA);
    const clientB = attachClient(peerB, channelB);
    await flushQueues();

    replaceClientMarkdown(clientA.doc, "first ws edit");
    await firstProjectionRead.promise;

    replaceClientMarkdown(clientB.doc, "second ws edit");
    await flushQueues();
    releaseFirstProjectionWrite.resolve();
    await flushQueues();

    const latestSeq = (await store.getHead(DOC))?.latestUpdateSeq;
    expect(latestSeq).toBe(3);
    expect(projection).toEqual({
      markdown: "second ws edit",
      persistedSeq: 3,
    });

    handler.close(peerA);
    handler.close(peerB);
  });
});

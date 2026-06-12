import {
  decodeYjsBinaryEnvelope,
  encodeYjsBinaryEnvelope,
  encodeYjsControlFrame,
  parseYjsClientControlFrame,
  YJS_WS_MESSAGE_SYNC,
  type YjsServerControlFrame,
} from "@meridian/contracts/protocol";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  DocumentSessionTransport,
  decodeYjsWsMessage,
  encodeAwarenessMessage,
  encodeSyncStep1Message,
  encodeSyncUpdateMessage,
} from "./document-session-transport";

function readMessageType(data: Uint8Array): number {
  return decoding.readVarUint(decoding.createDecoder(data));
}

// -- Framing round-trips (wire alignment) -----------------------------------

describe("multiplexed Yjs websocket framing", () => {
  it("round-trips a sync step using the server handler frame discriminator", () => {
    const serverDoc = new Y.Doc();
    serverDoc.getText("body").insert(0, "server body");
    const clientDoc = new Y.Doc();

    const step1 = encodeSyncStep1Message(clientDoc);
    expect(readMessageType(step1)).toBe(YJS_WS_MESSAGE_SYNC);

    const serverDecoder = decodeYjsWsMessage(step1);
    if (!serverDecoder || serverDecoder.type !== "sync") throw new Error("expected sync frame");

    const responseEncoder = encoding.createEncoder();
    encoding.writeVarUint(responseEncoder, YJS_WS_MESSAGE_SYNC);
    syncProtocol.readSyncMessage(serverDecoder.decoder, responseEncoder, serverDoc, "server");

    const response = encoding.toUint8Array(responseEncoder);
    const clientDecoder = decodeYjsWsMessage(response);
    if (!clientDecoder || clientDecoder.type !== "sync") throw new Error("expected sync frame");

    const ackEncoder = encoding.createEncoder();
    encoding.writeVarUint(ackEncoder, YJS_WS_MESSAGE_SYNC);
    syncProtocol.readSyncMessage(clientDecoder.decoder, ackEncoder, clientDoc, "client");

    expect(clientDoc.getText("body").toString()).toBe("server body");
  });

  it("round-trips a Yjs update frame", () => {
    const serverDoc = new Y.Doc();
    const clientDoc = new Y.Doc();
    clientDoc.getText("body").insert(0, "client body");

    const update = Y.encodeStateAsUpdate(clientDoc);
    const frame = encodeSyncUpdateMessage(update);

    const decoded = decodeYjsWsMessage(frame);
    if (!decoded || decoded.type !== "sync") throw new Error("expected sync frame");
    const responseEncoder = encoding.createEncoder();
    encoding.writeVarUint(responseEncoder, YJS_WS_MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoded.decoder, responseEncoder, serverDoc, "server");

    expect(serverDoc.getText("body").toString()).toBe("client body");
  });

  it("round-trips an awareness update frame", () => {
    const clientDoc = new Y.Doc();
    const clientAwareness = new Awareness(clientDoc);
    clientAwareness.setLocalStateField("user", { name: "Ada" });

    const frame = encodeAwarenessMessage(clientAwareness, [clientDoc.clientID]);
    const decoded = decodeYjsWsMessage(frame);
    if (!decoded || decoded.type !== "awareness") throw new Error("expected awareness frame");

    const serverAwareness = new Awareness(new Y.Doc());
    applyAwarenessUpdate(serverAwareness, decoded.update, "server");

    expect(serverAwareness.getStates().get(clientDoc.clientID)).toEqual({
      user: { name: "Ada" },
    });
  });
});

// -- Fake multiplexed server socket -----------------------------------------

/**
 * Mirrors `apps/server/server/lib/ws-yjs-handler.ts`: control frames as JSON
 * text, varuint-channel-prefixed binary sync/awareness frames, one server-side
 * `Y.Doc` per documentId shared across sockets so two clients reconcile.
 */
type DocId = string;

const serverDocs = new Map<DocId, Y.Doc>();

function serverDocFor(documentId: DocId): Y.Doc {
  let doc = serverDocs.get(documentId);
  if (!doc) {
    doc = new Y.Doc();
    serverDocs.set(documentId, doc);
  }
  return doc;
}

class FakeServerSocket {
  static sockets: FakeServerSocket[] = [];

  readyState: number = WebSocket.CONNECTING;
  binaryType = "arraybuffer";
  url: string;

  private listeners = new Map<string, Set<(event: unknown) => void>>();
  /** documentId → assigned channel index for this socket */
  private channels = new Map<DocId, number>();
  private channelDoc = new Map<number, DocId>();
  private nextChannelIndex = 0;
  /** Y.Doc update observers so updates broadcast to this socket's channels. */
  private docObservers = new Map<DocId, (update: Uint8Array, origin: unknown) => void>();

  constructor(url: string) {
    this.url = url;
    FakeServerSocket.sockets.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  private fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Simulate the server accepting the connection. */
  flushOpen(): void {
    this.readyState = WebSocket.OPEN;
    this.fire("open", {});
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      const frame = parseYjsClientControlFrame(data);
      if (!frame) return;
      if (frame.type === "subscribe") this.handleSubscribe(frame.documentId);
      if (frame.type === "unsubscribe") this.handleUnsubscribe(frame.documentId);
      return;
    }
    const envelope = decodeYjsBinaryEnvelope(new Uint8Array(data));
    if (!envelope) return;
    const documentId = this.channelDoc.get(envelope.channelIndex);
    if (!documentId) return;
    this.handleBinary(documentId, envelope.payload);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    for (const [documentId, observer] of this.docObservers) {
      serverDocFor(documentId).off("update", observer);
    }
    this.docObservers.clear();
    this.fire("close", { code: 1000, reason: "" });
  }

  /** Force a network drop so the client reconnects. */
  drop(code = 1006): void {
    this.readyState = WebSocket.CLOSED;
    for (const [documentId, observer] of this.docObservers) {
      serverDocFor(documentId).off("update", observer);
    }
    this.docObservers.clear();
    this.fire("close", { code, reason: "dropped" });
  }

  private sendControl(message: YjsServerControlFrame): void {
    this.fire("message", { data: encodeYjsControlFrame(message) });
  }

  private sendBinary(channelIndex: number, payload: Uint8Array): void {
    const frame = encodeYjsBinaryEnvelope(channelIndex, payload);
    this.fire("message", {
      data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
    });
  }

  private handleSubscribe(documentId: DocId): void {
    const existing = this.channels.get(documentId);
    if (existing !== undefined) {
      this.sendControl({ type: "subscribed", documentId, channelIndex: existing });
      return;
    }
    const channelIndex = this.nextChannelIndex++;
    this.channels.set(documentId, channelIndex);
    this.channelDoc.set(channelIndex, documentId);

    const doc = serverDocFor(documentId);
    const observer = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // don't echo this socket's own writes
      this.sendBinary(channelIndex, encodeSyncUpdateMessage(update));
    };
    doc.on("update", observer);
    this.docObservers.set(documentId, observer);

    this.sendControl({ type: "subscribed", documentId, channelIndex });

    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, YJS_WS_MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, doc);
    this.sendBinary(channelIndex, encoding.toUint8Array(step1));

    const step2 = encoding.createEncoder();
    encoding.writeVarUint(step2, YJS_WS_MESSAGE_SYNC);
    syncProtocol.writeSyncStep2(step2, doc);
    this.sendBinary(channelIndex, encoding.toUint8Array(step2));
  }

  private handleUnsubscribe(documentId: DocId): void {
    const channelIndex = this.channels.get(documentId);
    if (channelIndex === undefined) return;
    this.channels.delete(documentId);
    this.channelDoc.delete(channelIndex);
    const observer = this.docObservers.get(documentId);
    if (observer) {
      serverDocFor(documentId).off("update", observer);
      this.docObservers.delete(documentId);
    }
  }

  /** Server-side error frame for a document. */
  sendErrorFor(documentId: DocId, code: "forbidden", reason: string): void {
    this.sendControl({ type: "error", code, reason, documentId });
  }

  private handleBinary(documentId: DocId, payload: Uint8Array): void {
    const doc = serverDocFor(documentId);
    const channelIndex = this.channels.get(documentId);
    const decoder = decoding.createDecoder(payload);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === YJS_WS_MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, YJS_WS_MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, this);
      if (encoding.length(encoder) > 1 && channelIndex !== undefined) {
        this.sendBinary(channelIndex, encoding.toUint8Array(encoder));
      }
    }
  }
}

/**
 * Deferred timer queue: callbacks are stored, never auto-fired. The ping timer
 * therefore never elapses (it would close the socket), while reconnect timers
 * can be flushed deterministically by the test.
 */
type Timer = { id: number; fn: () => void };

function makeTransport(): {
  transport: DocumentSessionTransport;
  flushOpen: () => void;
  flushTimers: () => void;
  latest: () => FakeServerSocket;
} {
  const timers: Timer[] = [];
  let nextId = 1;
  const transport = new DocumentSessionTransport({
    webSocketFactory: (url) => new FakeServerSocket(url) as unknown as WebSocket,
    setTimeoutFn: ((fn: () => void) => {
      const id = nextId++;
      timers.push({ id, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: number) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    }) as unknown as typeof clearTimeout,
  });
  return {
    transport,
    flushOpen: () => FakeServerSocket.sockets.at(-1)?.flushOpen(),
    flushTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) timer.fn();
    },
    latest: () => {
      const socket = FakeServerSocket.sockets.at(-1);
      if (!socket) throw new Error("no socket");
      return socket;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DocumentSessionTransport multiplexing", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          protocol: "https:",
          host: "app.meridian.localhost",
          hostname: "app.meridian.localhost",
          port: "",
        },
      },
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
    FakeServerSocket.sockets = [];
    serverDocs.clear();
  });

  it("syncs two documents over one socket; updating one leaves the other untouched", async () => {
    serverDocFor("doc-a").getText("body").insert(0, "alpha");
    serverDocFor("doc-b").getText("body").insert(0, "beta");

    const { transport, flushOpen } = makeTransport();

    const docA = new Y.Doc();
    const awA = new Awareness(docA);
    const channelA = transport.subscribe({ documentId: "doc-a", document: docA, awareness: awA });

    const docB = new Y.Doc();
    const awB = new Awareness(docB);
    const channelB = transport.subscribe({ documentId: "doc-b", document: docB, awareness: awB });

    expect(FakeServerSocket.sockets).toHaveLength(1);
    flushOpen();
    await tick();

    await channelA.whenSynced;
    await channelB.whenSynced;
    expect(docA.getText("body").toString()).toBe("alpha");
    expect(docB.getText("body").toString()).toBe("beta");

    // Mutate doc-a on the server; only doc-a's client should change.
    serverDocFor("doc-a").getText("body").insert(5, "!");
    await tick();
    expect(docA.getText("body").toString()).toBe("alpha!");
    expect(docB.getText("body").toString()).toBe("beta");

    // A local write to doc-b propagates to the server doc only.
    docB.getText("body").insert(4, "X");
    await tick();
    expect(serverDocFor("doc-b").getText("body").toString()).toBe("betaX");
    expect(serverDocFor("doc-a").getText("body").toString()).toBe("alpha!");

    channelA.destroy();
    channelB.destroy();
  });

  it("handles subscribe then immediate unsubscribe before the socket opens", async () => {
    serverDocFor("doc-x").getText("body").insert(0, "x");
    const { transport, latest } = makeTransport();

    const docX = new Y.Doc();
    const channel = transport.subscribe({
      documentId: "doc-x",
      document: docX,
      awareness: new Awareness(docX),
    });
    const socket = latest();
    // Tear down before the socket finishes connecting; with no live channels
    // the transport closes the (still-connecting) socket immediately.
    channel.destroy();
    await tick();

    expect(socket.readyState).toBe(WebSocket.CLOSED);
    // Even if a late open/sync arrived, the destroyed channel must not mutate.
    socket.flushOpen();
    await tick();
    expect(docX.getText("body").toString()).toBe("");
  });

  it("reconnects and re-subscribes all channels after a drop", async () => {
    serverDocFor("doc-r").getText("body").insert(0, "one");
    const { transport, flushOpen, flushTimers, latest } = makeTransport();

    const docR = new Y.Doc();
    const channel = transport.subscribe({
      documentId: "doc-r",
      document: docR,
      awareness: new Awareness(docR),
    });
    flushOpen();
    await tick();
    await channel.whenSynced;
    expect(docR.getText("body").toString()).toBe("one");
    expect(FakeServerSocket.sockets).toHaveLength(1);

    // Server-side change arrives while offline after the drop.
    latest().drop();
    serverDocFor("doc-r").getText("body").insert(3, " two");
    await tick();

    // The reconnect timer is pending; flush it to spawn a fresh socket.
    flushTimers();
    expect(FakeServerSocket.sockets).toHaveLength(2);
    flushOpen();
    await tick();

    // Yjs sync step1/2 reconciles the missed server edit on the new socket.
    expect(docR.getText("body").toString()).toBe("one two");

    channel.destroy();
  });

  it("surfaces a per-document error frame without tearing down other channels", async () => {
    serverDocFor("doc-ok").getText("body").insert(0, "ok");
    const { transport, flushOpen, latest } = makeTransport();

    const docOk = new Y.Doc();
    const channelOk = transport.subscribe({
      documentId: "doc-ok",
      document: docOk,
      awareness: new Awareness(docOk),
    });
    const docBad = new Y.Doc();
    const channelBad = transport.subscribe({
      documentId: "doc-bad",
      document: docBad,
      awareness: new Awareness(docBad),
    });

    const errors: string[] = [];
    channelBad.onError((error) => errors.push(error.code));
    const okErrors: string[] = [];
    channelOk.onError((error) => okErrors.push(error.code));

    flushOpen();
    await tick();

    latest().sendErrorFor("doc-bad", "forbidden", "no access");
    await tick();

    expect(errors).toEqual(["forbidden"]);
    expect(okErrors).toEqual([]);
    await channelOk.whenSynced;
    expect(docOk.getText("body").toString()).toBe("ok");

    channelOk.destroy();
    channelBad.destroy();
  });

  it("treats a 4401 auth close as terminal and stops reconnecting", async () => {
    serverDocFor("doc-auth").getText("body").insert(0, "secret");
    const { transport, flushOpen, flushTimers, latest } = makeTransport();

    const docAuth = new Y.Doc();
    const channel = transport.subscribe({
      documentId: "doc-auth",
      document: docAuth,
      awareness: new Awareness(docAuth),
    });

    const states: string[] = [];
    channel.subscribeStatus((state) => states.push(state.kind));

    flushOpen();
    await tick();
    expect(FakeServerSocket.sockets).toHaveLength(1);

    // Server rejects auth on the upgraded socket (code 4401).
    latest().drop(4401);
    await tick();

    // Channel sees a terminal state, not a reconnecting/degraded churn.
    expect(states).toContain("terminal");

    // No reconnect is scheduled: flushing timers spawns no new socket.
    flushTimers();
    expect(FakeServerSocket.sockets).toHaveLength(1);

    channel.destroy();
  });
});

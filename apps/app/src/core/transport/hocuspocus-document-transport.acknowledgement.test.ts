/**
 * Server-acknowledgement contract of the document transport, run against the
 * real Hocuspocus provider and socket classes with a scripted fake WebSocket
 * playing the server. The provider's own `unsyncedChanges` counter is exactly
 * what these tests refuse to trust: after a reconnect it can reach zero while
 * messages are still unacknowledged.
 */
import * as encoding from "lib0/encoding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import { writeSyncStep1, writeSyncStep2 } from "y-protocols/sync";
import * as Y from "yjs";

const ROOM = "document-1";

const sockets = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("./dev-transport", () => ({
  buildSameOriginWsUrl: (path: string) => `ws://test${path}`,
}));

vi.mock("./tapped-websocket", () => {
  type Handler = (event: unknown) => void;
  class FakeSocket {
    readyState = 0;
    binaryType = "blob";
    readonly sent: Uint8Array[] = [];
    private readonly handlers = new Map<string, Set<Handler>>();

    constructor(_url: string | URL, _protocols?: string | string[]) {
      sockets.instances.push(this);
    }

    addEventListener(name: string, handler: Handler) {
      const set = this.handlers.get(name) ?? new Set();
      set.add(handler);
      this.handlers.set(name, set);
    }
    removeEventListener(name: string, handler: Handler) {
      this.handlers.get(name)?.delete(handler);
    }
    send(data: Uint8Array) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    dispatch(name: string, event: unknown) {
      for (const handler of this.handlers.get(name) ?? []) handler(event);
    }
  }
  return { notifyYjsRoomAttached: () => {}, TappedWebSocket: FakeSocket };
});

const { createHocuspocusDocumentTransport } = await import("./hocuspocus-document-transport");

type FakeServerSocket = {
  readyState: number;
  sent: Uint8Array[];
  dispatch(name: string, event: unknown): void;
};

const MESSAGE_SYNC = 0;
const MESSAGE_SYNC_STATUS = 8;

function frame(type: number, write: (encoder: encoding.Encoder) => void): ArrayBuffer {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, ROOM);
  encoding.writeVarUint(encoder, type);
  write(encoder);
  const bytes = encoding.toUint8Array(encoder);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Client sync frames on the wire, by kind (awareness, auth, and step 1 are not counted). */
function sentSyncKinds(socket: FakeServerSocket): Array<"step2" | "update"> {
  const kinds: Array<"step2" | "update"> = [];
  for (const bytes of socket.sent) {
    const decoder = decodeFrame(bytes);
    if (decoder?.type !== MESSAGE_SYNC) continue;
    if (decoder.syncType === 1) kinds.push("step2");
    if (decoder.syncType === 2) kinds.push("update");
  }
  return kinds;
}

function decodeFrame(bytes: Uint8Array): { type: number; syncType: number } | null {
  let position = 0;
  const readVarUint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[position++];
      if (byte === undefined) throw new Error("short frame");
      value |= (byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  try {
    const nameLength = readVarUint();
    position += nameLength;
    const type = readVarUint();
    return { type, syncType: type === MESSAGE_SYNC ? readVarUint() : -1 };
  } catch {
    return null;
  }
}

function latestSocket(): FakeServerSocket {
  const socket = sockets.instances.at(-1);
  if (!socket) throw new Error("no socket created");
  return socket as FakeServerSocket;
}

function receive(socket: FakeServerSocket, data: ArrayBuffer) {
  socket.dispatch("message", { data });
}

const acknowledge = (socket: FakeServerSocket, applied = true) =>
  receive(
    socket,
    frame(MESSAGE_SYNC_STATUS, (encoder) => encoding.writeVarUint(encoder, applied ? 1 : 0)),
  );

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

type Harness = ReturnType<typeof createHarness>;

function createHarness() {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  const serverDocument = new Y.Doc();
  const transport = createHocuspocusDocumentTransport({ roomName: ROOM, document, awareness });
  const values: boolean[] = [];
  transport.subscribeServerAcknowledgement?.((acknowledged) => values.push(acknowledged));

  /** Open the newest socket and play the server's half of the handshake. */
  async function connect(): Promise<FakeServerSocket> {
    await settle();
    const socket = latestSocket();
    socket.readyState = 1;
    socket.dispatch("open", {});
    await settle();
    receive(
      socket,
      frame(MESSAGE_SYNC, (encoder) => writeSyncStep1(encoder, serverDocument)),
    );
    receive(
      socket,
      frame(MESSAGE_SYNC, (encoder) =>
        writeSyncStep2(encoder, serverDocument, Y.encodeStateVector(document)),
      ),
    );
    await settle();
    return socket;
  }

  function drop(socket: FakeServerSocket) {
    socket.readyState = 3;
    socket.dispatch("close", { code: 1006, reason: "" });
  }

  const edit = (text: string, origin?: unknown) =>
    document.transact(() => document.getText("body").insert(0, text), origin);

  return {
    document,
    transport,
    values,
    connect,
    drop,
    edit,
    get acknowledged() {
      return values.at(-1) ?? false;
    },
    destroy() {
      transport.destroy();
      document.destroy();
      serverDocument.destroy();
    },
  };
}

describe("document transport server acknowledgement", () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.instances.length = 0;
    harness = createHarness();
  });

  afterEach(() => {
    harness.destroy();
    vi.useRealTimers();
  });

  it("is not saved merely because a socket opened with nothing pending", async () => {
    await settle();
    const socket = latestSocket();
    socket.readyState = 1;
    socket.dispatch("open", {});
    await settle();

    expect(sentSyncKinds(socket)).toEqual([]);
    expect(harness.values).not.toContain(true);
  });

  it("is false until the server acknowledges the handshake SyncStep2", async () => {
    const socket = await harness.connect();

    expect(sentSyncKinds(socket)).toEqual(["step2"]);
    expect(harness.acknowledged).toBe(false);

    acknowledge(socket);
    expect(harness.acknowledged).toBe(true);
  });

  it("goes false at once on a local edit and true again on its acknowledgement", async () => {
    const socket = await harness.connect();
    acknowledge(socket);

    harness.edit("typed");
    expect(harness.acknowledged).toBe(false);

    acknowledge(socket);
    expect(harness.acknowledged).toBe(true);
  });

  it("counts updates replayed by a peer or IndexedDB (remote-origin transactions)", async () => {
    const socket = await harness.connect();
    acknowledge(socket);

    harness.edit("from another tab", { source: "peer-replay" });

    expect(sentSyncKinds(socket)).toEqual(["step2", "update"]);
    expect(harness.acknowledged).toBe(false);
    acknowledge(socket);
    expect(harness.acknowledged).toBe(true);
  });

  it("is not saved until every offline-queued update is acknowledged, not just the first", async () => {
    const first = await harness.connect();
    acknowledge(first);
    harness.drop(first);
    expect(harness.acknowledged).toBe(false);

    harness.edit("one");
    harness.edit("two");
    harness.edit("three");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await harness.connect();

    expect(sentSyncKinds(second)).toEqual(["update", "update", "update", "step2"]);
    acknowledge(second);
    expect(harness.acknowledged).toBe(false);
    acknowledge(second);
    acknowledge(second);
    expect(harness.acknowledged).toBe(false);
    acknowledge(second);
    expect(harness.acknowledged).toBe(true);
  });

  it("never becomes saved from an acknowledgement that was not applied", async () => {
    const socket = await harness.connect();

    acknowledge(socket, false);
    expect(harness.acknowledged).toBe(false);
    harness.edit("rejected");
    acknowledge(socket);
    acknowledge(socket);
    expect(harness.acknowledged).toBe(false);
  });

  it("starts over on reconnect when acknowledgements were still pending at disconnect", async () => {
    const first = await harness.connect();
    acknowledge(first);
    harness.edit("in flight");
    harness.drop(first);
    expect(harness.acknowledged).toBe(false);

    // A late acknowledgement for the dead connection cannot count.
    acknowledge(first);
    expect(harness.acknowledged).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    const second = await harness.connect();
    expect(harness.acknowledged).toBe(false);
    acknowledge(second);
    expect(harness.acknowledged).toBe(true);
  });
});

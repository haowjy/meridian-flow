/**
 * Server-acknowledgement contract of the document transport, run against the
 * real Hocuspocus provider and socket classes with a scripted fake WebSocket
 * playing the server. The provider's own `unsyncedChanges` counter is exactly
 * what these tests refuse to trust: after a reconnect it can reach zero while
 * messages are still unacknowledged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

const ROOM = "document-1";

import { DocumentSocketHarness, sentSyncKinds } from "./test-support/DocumentSocketHarness";

vi.mock("./dev-transport", () => ({
  buildSameOriginWsUrl: (path: string) => `ws://test${path}`,
}));

vi.mock("./tapped-websocket", async () => {
  const { DocumentSocketHarness } = await import("./test-support/DocumentSocketHarness");
  return { notifyYjsRoomAttached: () => {}, TappedWebSocket: DocumentSocketHarness };
});

const { createHocuspocusDocumentTransport } = await import("./hocuspocus-document-transport");

function latestSocket(): DocumentSocketHarness {
  const socket = DocumentSocketHarness.instances.at(-1);
  if (!socket) throw new Error("no socket created");
  return socket;
}

const acknowledge = (socket: DocumentSocketHarness, applied = true) =>
  socket.acknowledge(ROOM, applied);

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
  async function connect(): Promise<DocumentSocketHarness> {
    await settle();
    const socket = latestSocket();
    socket.open();
    await settle();
    socket.syncStep1(ROOM, serverDocument);
    socket.syncStep2(ROOM, serverDocument, Y.encodeStateVector(document));
    await settle();
    return socket;
  }

  function drop(socket: DocumentSocketHarness) {
    socket.deliverClose();
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
    DocumentSocketHarness.instances.length = 0;
    harness = createHarness();
  });

  afterEach(() => {
    harness.destroy();
    vi.useRealTimers();
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

  it("is not saved after an edit queued while the socket is closing, before the close event", async () => {
    const first = await harness.connect();
    acknowledge(first);
    expect(harness.acknowledged).toBe(true);

    // CLOSING (e.g. the connection checker called close()); Hocuspocus has not yet seen "close".
    first.stallClose();
    harness.edit("typed while closing");
    expect(sentSyncKinds(first)).toEqual(["step2"]);
    expect(harness.acknowledged).toBe(false);

    harness.drop(first);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await harness.connect();
    // The queued update flushed on the new socket and needs its own acknowledgement.
    expect(sentSyncKinds(second)).toEqual(["update", "step2"]);
    acknowledge(second);
    expect(harness.acknowledged).toBe(false);
    acknowledge(second);
    expect(harness.acknowledged).toBe(true);
  });

  it("keeps first-frame connection, document sync and acknowledgement as separate evidence", async () => {
    await settle();
    const socket = latestSocket();
    const states: string[] = [];
    const unsubscribe = harness.transport.subscribeStatus?.((state) => states.push(state.kind));
    const serverDocument = new Y.Doc();

    try {
      socket.open();
      await settle();
      expect(states.at(-1)).toBe("connected");
      expect(harness.transport.synced).toBe(false);
      expect(harness.acknowledged).toBe(false);

      socket.syncStep1(ROOM, serverDocument);
      expect(states.at(-1)).toBe("connected");
      expect(sentSyncKinds(socket)).toEqual(["step2"]);
      expect(harness.transport.synced).toBe(false);
      expect(harness.acknowledged).toBe(false);

      socket.syncStep2(ROOM, serverDocument, Y.encodeStateVector(harness.document));
      await harness.transport.whenSynced;
      expect(harness.transport.synced).toBe(true);
      expect(harness.acknowledged).toBe(false);
      acknowledge(socket);
      expect(harness.acknowledged).toBe(true);
    } finally {
      unsubscribe?.();
      serverDocument.destroy();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { DocumentSessionManager } from "@/core/cm6-collab/sync/DocumentSessionManager";

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const AUTH_TOKEN = "document-auth-token";
const DOC_WS_PREFIX_SYNC = 0x00;

const refreshSessionMock = vi.fn(async () => ({ data: { session: null } }));

vi.mock("@/core/supabase/client", () => ({
  createClient: () => ({
    auth: {
      refreshSession: refreshSessionMock,
    },
  }),
}));

class MockWebSocket {
  public static readonly instances: MockWebSocket[] = [];

  public readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  public readonly url: string;
  public readyState = 0;
  public binaryType = "blob";
  public onopen: (() => void | Promise<void>) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    void this.onopen?.();
  }

  emitTextMessage(data: string): void {
    this.onmessage?.({ data });
  }

  emitBinaryMessage(data: ArrayBuffer | ArrayBufferView): void {
    this.onmessage?.({ data });
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  refreshSessionMock.mockClear();
  MockWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalWebSocket) {
    vi.stubGlobal("WebSocket", originalWebSocket);
  }
  vi.useRealTimers();
});

describe("DocumentSessionManager", () => {
  // [unit-tester:dispose] verification -- safe to delete after passing
  it("reuses one session per document until final release", () => {
    const manager = new DocumentSessionManager(async () => AUTH_TOKEN);

    const first = manager.acquire(DOC_ID.toUpperCase());
    const second = manager.acquire(DOC_ID);

    expect(second).toBe(first);
    expect(MockWebSocket.instances).toHaveLength(1);

    const socket = MockWebSocket.instances[0]!;
    manager.release(DOC_ID);
    expect(socket.closeCalls).toBe(0);

    manager.release(DOC_ID);
    expect(socket.closeCalls).toBe(1);

    const third = manager.acquire(DOC_ID);
    expect(third).not.toBe(first);
    expect(MockWebSocket.instances).toHaveLength(2);

    manager.release(DOC_ID);
    manager.destroy();
  });

  // [unit-tester:dispose] verification -- safe to delete after passing
  it("authenticates and transitions status through connected sync", async () => {
    const manager = new DocumentSessionManager(async () => AUTH_TOKEN);
    const session = manager.acquire(DOC_ID);
    const startSyncSpy = vi.spyOn(session.runtime, "startSync");
    const statuses: string[] = [];
    const unsubscribe = manager.onStatusChange(DOC_ID, (status) =>
      statuses.push(status),
    );

    expect(statuses).toEqual(["connecting"]);

    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await flushMicrotasks();

    expect(socket.sent[0]).toBe(AUTH_TOKEN);
    expect(statuses).toEqual(["connecting", "authenticating"]);

    socket.emitTextMessage(JSON.stringify({ type: "connected" }));
    expect(startSyncSpy).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["connecting", "authenticating", "syncing"]);

    const serverDoc = new Y.Doc();
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, serverDoc);
    socket.emitBinaryMessage(
      withPrefix(DOC_WS_PREFIX_SYNC, encoding.toUint8Array(encoder)),
    );

    expect(statuses).toEqual([
      "connecting",
      "authenticating",
      "syncing",
      "connected",
    ]);

    unsubscribe();
    manager.release(DOC_ID);
    manager.destroy();
    serverDoc.destroy();
  });

  // [unit-tester:dispose] verification -- safe to delete after passing
  it("closes the socket and retries when auth token resolution fails", async () => {
    const getAuthToken = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(AUTH_TOKEN);
    const manager = new DocumentSessionManager(getAuthToken);
    const session = manager.acquire(DOC_ID);
    const resetSpy = vi.spyOn(session.runtime, "reset");
    const statuses: string[] = [];
    const unsubscribe = manager.onStatusChange(DOC_ID, (status) =>
      statuses.push(status),
    );

    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await flushMicrotasks();

    expect(socket.closeCalls).toBe(1);
    expect(statuses).toEqual(["connecting", "authenticating", "disconnected"]);

    await vi.runOnlyPendingTimersAsync();

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(statuses).toEqual([
      "connecting",
      "authenticating",
      "disconnected",
      "connecting",
    ]);

    const reconnectSocket = MockWebSocket.instances[1]!;
    reconnectSocket.open();
    await flushMicrotasks();

    expect(getAuthToken).toHaveBeenCalledTimes(2);
    expect(reconnectSocket.sent[0]).toBe(AUTH_TOKEN);
    expect(statuses).toEqual([
      "connecting",
      "authenticating",
      "disconnected",
      "connecting",
      "authenticating",
    ]);

    unsubscribe();
    manager.release(DOC_ID);
    manager.destroy();
  });

  // [unit-tester:dispose] verification -- safe to delete after passing
  it("resets runtime and reconnects with a fresh socket after close", async () => {
    const manager = new DocumentSessionManager(async () => AUTH_TOKEN);
    const session = manager.acquire(DOC_ID);
    const resetSpy = vi.spyOn(session.runtime, "reset");
    const startSyncSpy = vi.spyOn(session.runtime, "startSync");
    const statuses: string[] = [];
    const unsubscribe = manager.onStatusChange(DOC_ID, (status) =>
      statuses.push(status),
    );

    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await flushMicrotasks();
    socket.emitTextMessage(JSON.stringify({ type: "connected" }));
    expect(startSyncSpy).toHaveBeenCalledTimes(1);

    socket.close();
    await vi.runOnlyPendingTimersAsync();

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(statuses).toContain("disconnected");
    expect(statuses).toContain("connecting");

    const reconnectSocket = MockWebSocket.instances[1]!;
    reconnectSocket.open();
    await flushMicrotasks();
    expect(reconnectSocket.sent[0]).toBe(AUTH_TOKEN);
    reconnectSocket.emitTextMessage(JSON.stringify({ type: "connected" }));
    expect(startSyncSpy).toHaveBeenCalledTimes(2);

    unsubscribe();
    manager.release(DOC_ID);
    manager.destroy();
  });

  // [unit-tester:dispose] verification -- safe to delete after passing
  it("refreshes auth and closes socket on AUTH_EXPIRED errors", async () => {
    const manager = new DocumentSessionManager(async () => AUTH_TOKEN);
    manager.acquire(DOC_ID);
    const socket = MockWebSocket.instances[0]!;

    socket.open();
    await flushMicrotasks();
    socket.emitTextMessage(
      JSON.stringify({
        type: "error",
        code: "AUTH_EXPIRED",
        message: "token expired",
      }),
    );

    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
    expect(socket.closeCalls).toBe(1);

    await vi.runOnlyPendingTimersAsync();
    expect(MockWebSocket.instances).toHaveLength(2);

    manager.release(DOC_ID);
    manager.destroy();
  });

  // [unit-tester:dispose] verification -- safe to delete after passing
  it("allows acquiring sessions again after destroy + revive", () => {
    const manager = new DocumentSessionManager(async () => AUTH_TOKEN);

    const firstSession = manager.acquire(DOC_ID);
    manager.release(DOC_ID);
    manager.destroy();

    expect(() => manager.acquire(DOC_ID)).toThrowError(
      "DocumentSessionManager is destroyed",
    );

    manager.revive();
    const revivedSession = manager.acquire(DOC_ID);

    expect(revivedSession).not.toBe(firstSession);
    expect(MockWebSocket.instances).toHaveLength(2);

    manager.release(DOC_ID);
    manager.destroy();
  });
});

function withPrefix(prefix: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(1 + payload.length);
  framed[0] = prefix;
  framed.set(payload, 1);
  return framed;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { MeridianEnvelopeType, frameEnvelope } from "@meridian/cm6-collab";

import {
  createProjectCollabTransport,
  type ProjectCollabWebSocket,
} from "@/features/documents/hooks/useProjectCollab";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const AUTH_TOKEN = "test-auth-token";

class MockWebSocket implements ProjectCollabWebSocket {
  public readyState = 0;
  public binaryType = "blob";
  public onopen: ((event?: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event?: unknown) => void) | null = null;
  public onclose: ((event?: unknown) => void) | null = null;

  public readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  public closeCalls = 0;

  constructor(public readonly url: string) {}

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
    this.onopen?.();
  }

  emitTextMessage(data: string): void {
    this.onmessage?.({ data });
  }

  emitBinaryMessage(data: Uint8Array): void {
    this.onmessage?.({ data });
  }
}

class MockWebSocketFactory {
  public readonly sockets: MockWebSocket[] = [];

  create = (url: string): ProjectCollabWebSocket => {
    const socket = new MockWebSocket(url);
    this.sockets.push(socket);
    return socket;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("project collab transport", () => {
  it("replays active document subscriptions after reconnect", async () => {
    const factory = new MockWebSocketFactory();
    const transport = createProjectCollabTransport({
      projectId: PROJECT_ID,
      createWebSocket: factory.create,
      resolveAccessToken: async () => AUTH_TOKEN,
      random: () => 0.5,
    });

    transport.start();
    await flushMicrotasks();

    expect(factory.sockets).toHaveLength(1);
    const initialSocket = factory.sockets[0]!;
    initialSocket.open();

    transport.subscribeDocument(DOC_A);
    transport.subscribeDocument(DOC_B);

    expect(extractDocSubscribeIds(initialSocket.sent)).toEqual([DOC_A, DOC_B]);

    initialSocket.close();
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    expect(factory.sockets).toHaveLength(2);
    const reconnectedSocket = factory.sockets[1]!;
    reconnectedSocket.open();

    expect(reconnectedSocket.sent[0]).toBe(AUTH_TOKEN);
    // Subscriptions replay only after server confirms auth with project:connected.
    expect(extractDocSubscribeIds(reconnectedSocket.sent)).toEqual([]);
    reconnectedSocket.emitTextMessage(
      JSON.stringify({ type: "project:connected" }),
    );
    expect(extractDocSubscribeIds(reconnectedSocket.sent)).toEqual([
      DOC_A,
      DOC_B,
    ]);

    transport.stop();
  });

  it("buffers binary frames until doc:subscribed and flushes in order", async () => {
    const factory = new MockWebSocketFactory();
    const transport = createProjectCollabTransport({
      projectId: PROJECT_ID,
      createWebSocket: factory.create,
      resolveAccessToken: async () => AUTH_TOKEN,
    });

    transport.start();
    await flushMicrotasks();

    const socket = factory.sockets[0]!;
    socket.open();

    const deliveredFrames: Uint8Array[] = [];
    transport.registerDocumentListener(DOC_A, {
      onBinaryFrame: (frame) => {
        deliveredFrames.push(frame);
      },
    });

    transport.subscribeDocument(DOC_A);

    const beforeSubscribed = frameEnvelope(
      MeridianEnvelopeType.Update,
      DOC_A,
      new Uint8Array([1, 2, 3]),
    );
    socket.emitBinaryMessage(beforeSubscribed);

    expect(deliveredFrames).toHaveLength(0);

    socket.emitTextMessage(
      JSON.stringify({
        type: "doc:subscribed",
        documentId: DOC_A,
      }),
    );

    expect(deliveredFrames).toHaveLength(1);
    expect(Array.from(deliveredFrames[0] ?? [])).toEqual(
      Array.from(beforeSubscribed),
    );

    const afterSubscribed = frameEnvelope(
      MeridianEnvelopeType.Update,
      DOC_A,
      new Uint8Array([9, 8, 7]),
    );
    socket.emitBinaryMessage(afterSubscribed);

    expect(deliveredFrames).toHaveLength(2);
    expect(Array.from(deliveredFrames[1] ?? [])).toEqual(
      Array.from(afterSubscribed),
    );

    transport.stop();
  });

  it("routes doc:error as document-scoped event without disconnecting", async () => {
    const factory = new MockWebSocketFactory();
    const transport = createProjectCollabTransport({
      projectId: PROJECT_ID,
      createWebSocket: factory.create,
      resolveAccessToken: async () => AUTH_TOKEN,
    });

    transport.start();
    await flushMicrotasks();

    const socket = factory.sockets[0]!;
    socket.open();

    transport.subscribeDocument(DOC_A);

    const textEvents: unknown[] = [];
    transport.registerDocumentListener(DOC_A, {
      onTextEvent: (event) => {
        textEvents.push(event);
      },
    });

    socket.emitTextMessage(
      JSON.stringify({
        type: "doc:error",
        documentId: DOC_A,
        code: "FORBIDDEN",
        message: "access denied",
      }),
    );

    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toMatchObject({
      type: "doc:error",
      documentId: DOC_A,
      code: "FORBIDDEN",
      message: "access denied",
    });
    expect(socket.closeCalls).toBe(0);

    transport.stop();
  });

  it("keeps websocket open for non-auth project-level error events", async () => {
    const factory = new MockWebSocketFactory();
    const refreshSession = vi.fn(async () => ({}));
    const transport = createProjectCollabTransport({
      projectId: PROJECT_ID,
      createWebSocket: factory.create,
      resolveAccessToken: async () => AUTH_TOKEN,
      refreshSession,
    });

    transport.start();
    await flushMicrotasks();

    const socket = factory.sockets[0]!;
    socket.open();

    socket.emitTextMessage(
      JSON.stringify({
        type: "error",
        code: "RATE_LIMITED",
        message: "retry later",
      }),
    );

    expect(socket.closeCalls).toBe(0);
    expect(refreshSession).not.toHaveBeenCalled();

    transport.stop();
  });

  it("does not duplicate outbound doc:subscribe on idempotent local subscribe", async () => {
    const factory = new MockWebSocketFactory();
    const transport = createProjectCollabTransport({
      projectId: PROJECT_ID,
      createWebSocket: factory.create,
      resolveAccessToken: async () => AUTH_TOKEN,
    });

    transport.start();
    await flushMicrotasks();

    const socket = factory.sockets[0]!;
    socket.open();

    transport.subscribeDocument(DOC_A);
    transport.subscribeDocument(DOC_A.toUpperCase());

    expect(extractDocSubscribeIds(socket.sent)).toEqual([DOC_A]);

    transport.stop();
  });
});

function extractDocSubscribeIds(
  sent: Array<string | ArrayBufferLike | ArrayBufferView>,
): string[] {
  const ids: string[] = [];

  for (const message of sent) {
    if (typeof message !== "string") {
      continue;
    }

    const trimmedMessage = message.trim();
    if (!(trimmedMessage.startsWith("{") && trimmedMessage.endsWith("}"))) {
      continue;
    }

    const parsed = JSON.parse(trimmedMessage) as Record<string, unknown>;
    if (
      parsed.type === "doc:subscribe" &&
      typeof parsed.documentId === "string"
    ) {
      ids.push(parsed.documentId);
    }
  }

  return ids;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/core/stores/useTreeStore";
import {
  createProjectCollabTransport,
  type ProjectCollabWebSocket,
} from "@/features/documents/hooks/useProjectCollab";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC_A = "11111111-1111-4111-8111-111111111111";
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
  it("marks transport connected only after project:connected ack", async () => {
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

    expect(socket.sent[0]).toBe(AUTH_TOKEN);
    expect(transport.isConnected()).toBe(false);

    socket.emitTextMessage(JSON.stringify({ type: "project:connected" }));
    expect(transport.isConnected()).toBe(true);

    transport.stop();
  });

  it("reconnects after socket closes", async () => {
    const factory = new MockWebSocketFactory();
    const transport = createProjectCollabTransport({
      projectId: PROJECT_ID,
      createWebSocket: factory.create,
      resolveAccessToken: async () => AUTH_TOKEN,
      random: () => 0.5,
    });

    transport.start();
    await flushMicrotasks();

    const initialSocket = factory.sockets[0]!;
    initialSocket.open();
    initialSocket.emitTextMessage(JSON.stringify({ type: "project:connected" }));
    expect(transport.isConnected()).toBe(true);

    initialSocket.close();
    expect(transport.isConnected()).toBe(false);

    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    expect(factory.sockets).toHaveLength(2);
    const reconnectedSocket = factory.sockets[1]!;
    reconnectedSocket.open();
    expect(reconnectedSocket.sent[0]).toBe(AUTH_TOKEN);

    transport.stop();
  });

  it("routes proposal events by document id", async () => {
    const factory = new MockWebSocketFactory();
    const transport = createProjectCollabTransport({
      projectId: PROJECT_ID,
      createWebSocket: factory.create,
      resolveAccessToken: async () => AUTH_TOKEN,
    });

    const events: unknown[] = [];
    transport.registerDocumentListener(DOC_A, {
      onTextEvent: (event) => events.push(event),
    });

    transport.start();
    await flushMicrotasks();

    const socket = factory.sockets[0]!;
    socket.open();
    socket.emitTextMessage(JSON.stringify({ type: "project:connected" }));

    socket.emitTextMessage(
      JSON.stringify({
        type: "proposal:statusChanged",
        documentId: DOC_A,
        proposalId: "33333333-3333-4333-8333-333333333333",
        status: "accepted",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "proposal:statusChanged",
      documentId: DOC_A,
      status: "accepted",
    });

    transport.stop();
  });

  it("adjusts pendingProposalCount on proposal new/status events", async () => {
    useTreeStore.setState((state) => ({
      ...state,
      documents: [
        {
          id: DOC_A,
          projectId: PROJECT_ID,
          folderId: null,
          name: "Doc A",
          path: "Doc A.md",
          extension: ".md",
          filename: "Doc A.md",
          updatedAt: new Date("2026-02-23T00:00:00Z"),
          fileType: "markdown",
          pendingProposalCount: 1,
        },
      ],
    }));

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

    socket.emitTextMessage(
      JSON.stringify({
        type: "proposal:new",
        proposal: {
          id: "44444444-4444-4444-8444-444444444444",
          documentId: DOC_A,
          source: "ai",
          producerAgentType: "assistant",
          threadId: "55555555-5555-4555-8555-555555555555",
          turnId: null,
          agentRunId: "66666666-6666-4666-8666-666666666666",
          proposalGroupId: null,
          status: "proposed",
          description: null,
          createdByUserId: "77777777-7777-4777-8777-777777777777",
          createdAt: "2026-02-23T00:00:00Z",
        },
      }),
    );

    socket.emitTextMessage(
      JSON.stringify({
        type: "proposal:statusChanged",
        documentId: DOC_A,
        proposalId: "44444444-4444-4444-8444-444444444444",
        status: "accepted",
      }),
    );

    const doc = useTreeStore.getState().documents.find((d) => d.id === DOC_A);
    expect(doc?.pendingProposalCount).toBe(1);

    transport.stop();
  });

  it("sends proposal command only when connected", async () => {
    const factory = new MockWebSocketFactory();
    const transport = createProjectCollabTransport({
      projectId: PROJECT_ID,
      createWebSocket: factory.create,
      resolveAccessToken: async () => AUTH_TOKEN,
    });

    transport.start();
    await flushMicrotasks();

    const socket = factory.sockets[0]!;

    transport.sendDocumentCommand(DOC_A, {
      type: "proposal:reject",
      proposalId: "33333333-3333-4333-8333-333333333333",
    });
    expect(socket.sent).toHaveLength(0);

    socket.open();
    socket.emitTextMessage(JSON.stringify({ type: "project:connected" }));

    transport.sendDocumentCommand(DOC_A, {
      type: "proposal:reject",
      proposalId: "33333333-3333-4333-8333-333333333333",
    });

    const sentCommands = socket.sent.filter(
      (entry): entry is string => typeof entry === "string" && entry.startsWith("{"),
    );
    expect(sentCommands).toHaveLength(1);
    expect(JSON.parse(sentCommands[0]!)).toMatchObject({
      type: "proposal:reject",
      documentId: DOC_A,
      proposalId: "33333333-3333-4333-8333-333333333333",
    });

    transport.stop();
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

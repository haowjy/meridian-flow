/** Route-level coverage for accepting degraded writer messages without losing prose. */

import type { SendMessageResponse } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../domains/observability/index.js";
import type {
  Gateway,
  GenerateRequest,
  GenerateResult,
  StreamEvent,
} from "../../domains/runtime/gateway/index.js";
import { RuntimeTestRig } from "../../domains/runtime/loop/__tests__/runtime-test-rig.js";

vi.mock("nitro/h3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nitro/h3")>();
  return {
    ...actual,
    defineEventHandler: (handler: unknown) => handler,
    getRouterParam: (event: TestEvent, name: string) => event.params[name],
    readBody: async (event: TestEvent) => event.body,
    setResponseStatus: (event: TestEvent, status: number) => {
      event.res.status = status;
    },
  };
});

vi.mock("../auth-gate.js", () => ({
  requireAppUser: async (event: TestEvent) => event.auth,
}));

type TestEvent = {
  params: Record<string, string>;
  body?: unknown;
  res: { status: number };
  auth: { app: Record<string, unknown>; user: { userId: string } };
};

type TestHandler = (event: TestEvent) => Promise<SendMessageResponse>;

const sendMessage = await import("../../routes/api/threads/[threadId]/messages.post.js").then(
  (module) => module.default as unknown as TestHandler,
);

function textGateway(): Gateway {
  return {
    async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
      const result: GenerateResult = {
        content: [{ type: "text", text: "done" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      };
      yield { type: "end", result };
    },
    async generate() {
      throw new Error("not used in this test");
    },
    getDefaultModel() {
      return undefined;
    },
  };
}

describe("thread messages route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts unavailable image references while persisting the surrounding prose", async () => {
    const rig = await RuntimeTestRig.create({ gateway: textGateway() });
    const app = rig.createAppServices();
    const eventSink = createInMemoryEventSink();
    const uri = "manuscript://assets/missing.png";
    app.imageAssets = {
      isValidReference: vi.fn().mockResolvedValue(false),
      resolve: vi.fn().mockResolvedValue(null),
    };
    app.eventSink = eventSink;
    const event: TestEvent = {
      params: { threadId: rig.thread.id },
      body: {
        text: `Keep this prose and ignore ${uri}`,
        blocks: [
          { type: "text", text: `Keep this prose and ignore ${uri}` },
          {
            type: "image",
            documentId: "11111111-1111-4111-8111-111111111111",
            uri,
          },
        ],
      },
      res: { status: 200 },
      auth: { app, user: { userId: rig.userId } },
    };

    const response = await sendMessage(event);
    const blocks = await rig.repos.blocks.listByTurn(response.userTurnId);

    expect(event.res.status).toBe(202);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      blockType: "text",
      content: `Keep this prose and ignore ${uri}`,
    });
    expect(eventSink.events).toContainEqual(
      expect.objectContaining({
        source: "runtime.user-message",
        name: "image_reference.dropped",
        correlation: expect.objectContaining({
          threadId: rig.thread.id,
          documentId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("still returns 400 for a malformed block shape", async () => {
    const startTurn = vi.fn();
    const event: TestEvent = {
      params: { threadId: "11111111-1111-4111-8111-111111111111" },
      body: {
        text: "Keep this prose",
        blocks: [{ type: "text", text: "Keep this prose", unexpected: true }],
      },
      res: { status: 200 },
      auth: {
        app: {
          threadRuntime: {
            requireOwnedThread: vi.fn().mockResolvedValue({ projectId: "project-1" }),
          },
          imageAssets: {
            isValidReference: vi.fn(),
            resolve: vi.fn(),
          },
          runner: { startTurn },
          eventSink: createInMemoryEventSink(),
        },
        user: { userId: "user-1" },
      },
    };

    await expect(sendMessage(event)).rejects.toMatchObject({ statusCode: 400 });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("accepts degraded prose even when the diagnostic sink fails", async () => {
    const startTurn = vi.fn().mockResolvedValue({
      userTurnId: "user-turn-1",
      assistantTurnId: "assistant-turn-1",
      resumeAfterSeq: "0",
      snapshotFloorNextSeq: "1",
    });
    const uri = "manuscript://pictures/missing.png";
    const event: TestEvent = {
      params: { threadId: "11111111-1111-4111-8111-111111111111" },
      body: {
        text: `Keep this prose and ignore ${uri}`,
        blocks: [
          { type: "text", text: `Keep this prose and ignore ${uri}` },
          {
            type: "image",
            documentId: "22222222-2222-4222-8222-222222222222",
            uri,
          },
        ],
      },
      res: { status: 200 },
      auth: {
        app: {
          threadRuntime: {
            requireOwnedThread: vi.fn().mockResolvedValue({ projectId: "project-1" }),
          },
          imageAssets: {
            isValidReference: vi.fn().mockResolvedValue(false),
            resolve: vi.fn(),
          },
          runner: { startTurn },
          eventSink: {
            emit() {
              throw new Error("sink failed");
            },
            emitBatch() {},
            async flush() {},
          },
        },
        user: { userId: "user-1" },
      },
    };

    await expect(sendMessage(event)).resolves.toMatchObject({ status: "accepted" });
    expect(event.res.status).toBe(202);
    expect(startTurn).toHaveBeenCalledWith({
      threadId: "11111111-1111-4111-8111-111111111111",
      userText: `Keep this prose and ignore ${uri}`,
      userBlocks: [{ type: "text", text: `Keep this prose and ignore ${uri}` }],
      connectionToken: undefined,
    });
  });
});

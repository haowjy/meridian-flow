import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMockOpenAICompatibleServer, type MockOpenAIServer } from "./adapters/mock/server.js";
import { mockProviderConfig } from "./config/providers.js";
import { createGateway } from "./create-gateway.js";
import type { StreamEvent } from "./domain/index.js";
import { assistant, toolResult, user } from "./helpers/messages.js";

const CANCEL_DRAIN_TIMEOUT_MS = 5_000;

describe("model-gateway openai-compatible pipeline", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  function gateway() {
    return createGateway({
      providers: [mockProviderConfig(mock.baseUrl)],
      defaultModel: "mock-llm-v1",
    });
  }

  it("streams text deltas and ends with a result", async () => {
    const userMessage = "hello world";
    const expectedText = `Acknowledged: ${userMessage}`;
    const gw = gateway();
    const events = [];
    for await (const event of gw.stream({
      messages: [user(userMessage)],
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "start",
      model: "mock-llm-v1",
      provider: "mock",
    });

    const textDeltas = events.filter((e) => e.type === "text.delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.map((e) => (e.type === "text.delta" ? e.text : "")).join("")).toBe(
      expectedText,
    );

    const end = events.find((e) => e.type === "end");
    expect(end?.type).toBe("end");
    if (end?.type === "end") {
      expect(end.result.finishReason).toBe("end_turn");
      expect(end.result.model).toBe("mock-llm-v1");
      expect(end.result.provider).toBe("mock");
      expect(end.result.usage.outputTokens).toBeGreaterThan(0);
      const textParts = end.result.content.filter(
        (part): part is Extract<(typeof end.result.content)[number], { type: "text" }> =>
          part.type === "text",
      );
      expect(textParts.map((part) => part.text).join("")).toBe(expectedText);
    }
  });

  it("streams tool_call deltas for tool-triggering prompts", async () => {
    const gw = gateway();
    const events = [];
    for await (const event of gw.stream({
      messages: [user("What's the weather in SF?")],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather",
          inputSchema: {
            type: "object",
            properties: { location: { type: "string" } },
          },
        },
      ],
    })) {
      events.push(event);
    }

    const toolDeltas = events.filter((e) => e.type === "tool_call.delta");
    expect(toolDeltas.length).toBeGreaterThan(0);

    const end = events.find((e) => e.type === "end");
    expect(end?.type).toBe("end");
    if (end?.type === "end") {
      expect(end.result.finishReason).toBe("tool_use");
      expect(end.result.toolCalls).toHaveLength(1);
      expect(end.result.toolCalls[0]?.name).toBe("get_weather");
    }
  });

  const writeTool = {
    type: "function" as const,
    name: "write",
    description: "Write a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  };

  it("streams a write tool call for the vertical-slice trigger", async () => {
    const triggerMessage = `Phase 7 final gate ${Date.now()}`;
    const gw = gateway();
    const events = [];
    for await (const event of gw.stream({
      messages: [user(triggerMessage)],
      tools: [writeTool],
    })) {
      events.push(event);
    }

    const end = events.find((e) => e.type === "end");
    expect(end?.type).toBe("end");
    if (end?.type === "end") {
      expect(end.result.finishReason).toBe("tool_use");
      expect(end.result.toolCalls).toHaveLength(1);
      expect(end.result.toolCalls[0]?.name).toBe("write");
      expect(end.result.toolCalls[0]?.arguments).toEqual({
        path: "manuscript://chapter-1.md",
        content: `# Chapter 1\n\nAcknowledged: ${triggerMessage}`,
      });
    }
  });

  it("streams a background writer-helper spawn call for Muse helper prompts", async () => {
    const gw = gateway();
    const events = [];
    for await (const event of gw.stream({
      messages: [user("Use the background writer-helper in background mode.")],
      tools: [
        {
          type: "function",
          name: "spawn",
          description: "Spawn a helper",
          inputSchema: {
            type: "object",
            properties: {
              agent: { type: "string" },
              prompt: { type: "string" },
              mode: { type: "string" },
            },
            required: ["agent", "prompt"],
          },
        },
      ],
    })) {
      events.push(event);
    }

    const end = events.find((e) => e.type === "end");
    expect(end?.type).toBe("end");
    if (end?.type === "end") {
      expect(end.result.finishReason).toBe("tool_use");
      expect(end.result.toolCalls[0]).toMatchObject({
        name: "spawn",
        arguments: { agent: "writer-helper", mode: "background" },
      });
    }
  });

  it("streams return_result for subagent prompts", async () => {
    const gw = gateway();
    const events = [];
    for await (const event of gw.stream({
      messages: [user("Check this request independently.")],
      tools: [
        {
          type: "function",
          name: "return_result",
          description: "Return helper result",
          inputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
        },
      ],
    })) {
      events.push(event);
    }

    const end = events.find((e) => e.type === "end");
    expect(end?.type).toBe("end");
    if (end?.type === "end") {
      expect(end.result.finishReason).toBe("tool_use");
      expect(end.result.toolCalls[0]).toMatchObject({
        name: "return_result",
        arguments: {
          summary:
            "Writer-helper checked the request and recommends keeping the next beat concrete.",
        },
      });
    }
  });

  it("acknowledges the original user message after a write tool result", async () => {
    const triggerMessage = `Phase 7 final gate ${Date.now()}`;
    const gw = gateway();
    const result = await gw.generate({
      messages: [
        user(triggerMessage),
        assistant([
          {
            type: "tool_use",
            toolCallId: "call_mock_write_1",
            toolName: "write",
            input: {
              path: "manuscript://chapter-1.md",
              content: `# Chapter 1\n\nAcknowledged: ${triggerMessage}`,
            },
          },
        ]),
        toolResult("call_mock_write_1", { ok: true }),
      ],
      tools: [writeTool],
    });

    const textParts = result.content.filter(
      (part): part is Extract<(typeof result.content)[number], { type: "text" }> =>
        part.type === "text",
    );
    expect(textParts.map((part) => part.text).join("")).toBe(`Acknowledged: ${triggerMessage}`);
    expect(result.finishReason).toBe("end_turn");
  });

  it("derive generate() from the stream", async () => {
    const gw = gateway();
    const result = await gw.generate({
      messages: [user("ping")],
    });

    const textParts = result.content.filter(
      (part): part is Extract<(typeof result.content)[number], { type: "text" }> =>
        part.type === "text",
    );
    expect(textParts.map((part) => part.text).join("")).toBe("Acknowledged: ping");
    expect(result.finishReason).toBe("end_turn");
    expect(result.model).toBe("mock-llm-v1");
  });

  it("maps provider errors to canonical error events", async () => {
    const gw = createGateway({
      providers: [
        {
          id: "bad",
          adapter: "openai-compatible",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [
            {
              id: "missing",
              provider: "bad",
              displayName: "Bad",
              contextWindow: 1000,
              maxOutputTokens: 100,
              capabilities: new Set(["streaming"]),
            },
          ],
        },
      ],
      defaultModel: "missing",
      retry: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 20 },
    });

    const events = [];
    for await (const event of gw.stream({ messages: [user("x")] })) {
      events.push(event);
    }

    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(["network_error", "provider_error"]).toContain(err.code);
    }
  });

  it("does not retry after partial stream output", async () => {
    const before = mock.requestCount();
    const gw = createGateway({
      providers: [mockProviderConfig(mock.baseUrl)],
      defaultModel: "mock-llm-v1",
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
    });

    const events = [];
    for await (const event of gw.stream({ messages: [user("midstream disconnect")] })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
    expect(mock.requestCount() - before).toBe(1);
  });

  it("retries attempt timeouts before output starts", async () => {
    const before = mock.requestCount();
    const gw = createGateway({
      providers: [mockProviderConfig(mock.baseUrl)],
      defaultModel: "mock-llm-v1",
      attemptTimeoutMs: 20,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
    });

    const events = [];
    for await (const event of gw.stream({ messages: [user("slow before output")] })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text.delta")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "provider_error",
      retryable: true,
    });
    expect(mock.requestCount() - before).toBe(2);
  });

  it("does not retry attempt timeouts after partial output starts", async () => {
    const before = mock.requestCount();
    const gw = createGateway({
      providers: [mockProviderConfig(mock.baseUrl)],
      defaultModel: "mock-llm-v1",
      attemptTimeoutMs: 20,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
    });

    const events = [];
    for await (const event of gw.stream({ messages: [user("slow after output")] })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "provider_error",
      retryable: true,
    });
    expect(mock.requestCount() - before).toBe(1);
  });

  it("drains user cancel to a partial end with usage through createGateway", async () => {
    const gw = gateway();
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    const consume = (async () => {
      for await (const event of gw.stream({
        messages: [user("cancel billing")],
        signal: controller.signal,
      })) {
        events.push(event);
      }
    })();

    const deadline = Date.now() + 2_000;
    while (!events.some((event) => event.type === "text.delta") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events.some((event) => event.type === "text.delta")).toBe(true);

    controller.abort();
    await consume;

    const end = events.at(-1);
    expect(end?.type).toBe("end");
    if (end?.type === "end") {
      expect(end.result.usage.inputTokens).toBeGreaterThan(0);
      expect(end.result.usage.outputTokens).toBeGreaterThan(0);
    }
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("completes post-output parent cancel when the provider ignores abort during drain", async () => {
    const gw = gateway();
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    const consume = (async () => {
      for await (const event of gw.stream({
        messages: [user("hang cancel drain")],
        signal: controller.signal,
      })) {
        events.push(event);
      }
    })();

    const deadline = Date.now() + 2_000;
    while (!events.some((event) => event.type === "text.delta") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events.some((event) => event.type === "text.delta")).toBe(true);

    const cancelStartedAt = Date.now();
    controller.abort();

    const hangGuard = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("cancel drain hung past bound")),
        CANCEL_DRAIN_TIMEOUT_MS + 1_500,
      );
    });
    await Promise.race([consume, hangGuard]);

    expect(Date.now() - cancelStartedAt).toBeLessThan(CANCEL_DRAIN_TIMEOUT_MS + 1_500);
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
  });
});

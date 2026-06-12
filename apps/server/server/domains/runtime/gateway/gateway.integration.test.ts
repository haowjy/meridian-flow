import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMockOpenAICompatibleServer, type MockOpenAIServer } from "./adapters/mock/server.js";
import { mockProviderConfig } from "./config/providers.js";
import { createGateway } from "./create-gateway.js";
import { user } from "./helpers/messages.js";

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
    const gw = gateway();
    const events = [];
    for await (const event of gw.stream({
      messages: [user("hello world")],
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
    expect(textDeltas.map((e) => (e.type === "text.delta" ? e.text : "")).join("")).toContain(
      "Mock response",
    );

    const end = events.find((e) => e.type === "end");
    expect(end?.type).toBe("end");
    if (end?.type === "end") {
      expect(end.result.finishReason).toBe("end_turn");
      expect(end.result.model).toBe("mock-llm-v1");
      expect(end.result.provider).toBe("mock");
      expect(end.result.usage.outputTokens).toBeGreaterThan(0);
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

  it("derive generate() from the stream", async () => {
    const gw = gateway();
    const result = await gw.generate({
      messages: [user("ping")],
    });

    expect(result.content.some((p) => p.type === "text")).toBe(true);
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
});

/**
 * Integration tests for createGateway routing: duplicate model IDs, provider
 * overrides on the real stream/generate path, and collision warnings.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockOpenAICompatibleServer, type MockOpenAIServer } from "./adapters/mock/server.js";
import { createGatewayFromEnv } from "./config/create-from-env.js";
import { createGateway } from "./create-gateway.js";
import type { ModelInfo, TraceSpan } from "./domain/index.js";

function model(id: string, provider: string): ModelInfo {
  return {
    id,
    provider,
    displayName: id,
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    capabilities: new Set(["streaming"]),
  };
}

describe("createGateway duplicate-model routing", () => {
  let primaryMock: MockOpenAIServer;
  let overrideMock: MockOpenAIServer;

  beforeAll(async () => {
    primaryMock = await createMockOpenAICompatibleServer();
    overrideMock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await primaryMock.close();
    await overrideMock.close();
  });

  function duplicateModelGateway() {
    return createGateway({
      providers: [
        {
          id: "deepseek",
          adapter: "openai-compatible",
          baseUrl: primaryMock.baseUrl,
          models: [model("deepseek-v4-flash", "deepseek")],
        },
        {
          id: "deepseek-openai",
          adapter: "openai-compatible",
          baseUrl: overrideMock.baseUrl,
          models: [model("deepseek-v4-flash", "deepseek-openai")],
        },
      ],
      defaultModel: "deepseek-v4-flash",
      fallback: { enabled: true },
    });
  }

  it("routes stream() to an explicitly requested provider when model IDs collide", async () => {
    const beforePrimary = primaryMock.requestCount();
    const beforeOverride = overrideMock.requestCount();
    const gateway = duplicateModelGateway();

    const events = [];
    for await (const event of gateway.stream({
      provider: "deepseek-openai",
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: "start",
      model: "deepseek-v4-flash",
      provider: "deepseek-openai",
    });
    expect(overrideMock.requestCount() - beforeOverride).toBe(1);
    expect(primaryMock.requestCount() - beforePrimary).toBe(0);
  });

  it("routes generate() to an explicitly requested provider when model IDs collide", async () => {
    const beforePrimary = primaryMock.requestCount();
    const beforeOverride = overrideMock.requestCount();
    const gateway = duplicateModelGateway();

    const result = await gateway.generate({
      provider: "deepseek-openai",
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });

    expect(result.provider).toBe("deepseek-openai");
    expect(result.model).toBe("deepseek-v4-flash");
    expect(overrideMock.requestCount() - beforeOverride).toBe(1);
    expect(primaryMock.requestCount() - beforePrimary).toBe(0);
  });
});

describe("createGateway collision warnings", () => {
  it("emits gateway.model_collision_skipped through onWarning at construction", () => {
    const warnings: TraceSpan[] = [];
    createGateway({
      providers: [
        {
          id: "first",
          adapter: "openai-compatible",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [model("shared-model", "first")],
        },
        {
          id: "second",
          adapter: "openai-compatible",
          baseUrl: "http://127.0.0.1:2/v1",
          models: [model("shared-model", "second")],
        },
      ],
      onWarning: (span) => warnings.push(span),
    });

    expect(warnings).toEqual([
      {
        name: "gateway.model_collision_skipped",
        attributes: {
          modelId: "shared-model",
          keptProviderId: "first",
          skippedProviderId: "second",
        },
      },
    ]);
  });

  it("forwards onWarning through createGatewayFromEnv options", async () => {
    const warnings: TraceSpan[] = [];
    const mock = await createMockOpenAICompatibleServer();
    try {
      const { gateway } = await createGatewayFromEnv(
        { MODEL_PROVIDER: "mock" },
        { onWarning: (span) => warnings.push(span), mockBaseUrl: mock.baseUrl },
      );

      const result = await gateway.generate({
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      });
      expect(result.provider).toBe("mock");
      // Single mock provider — no collision, but the seam accepts callbacks.
      expect(warnings).toEqual([]);
    } finally {
      await mock.close();
    }
  });
});

/**
 * OpenRouter adapter tests: routes through the openai-compatible wire path and
 * enriches results with provider-reported cost from stream usage or /generation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway } from "../../../create-gateway.js";
import type { ModelInfo } from "../../../domain/index.js";
import { createMockOpenAICompatibleServer, type MockOpenAIServer } from "../../mock/server.js";
import { createOpenRouterAdapter } from "../adapter.js";

function model(id: string): ModelInfo {
  return {
    id,
    provider: "openrouter",
    displayName: id,
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    capabilities: new Set(["streaming"]),
  };
}

describe("createOpenRouterAdapter", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("routes through the openai-compatible chat-completions path", async () => {
    const before = mock.requestCount();
    const adapter = createOpenRouterAdapter({
      id: "openrouter",
      adapter: "openrouter",
      baseUrl: mock.baseUrl,
      auth: { apiKey: "test-openrouter-key" },
      models: [model("anthropic/claude-sonnet-4")],
    });

    const events = [];
    for await (const event of adapter.stream(
      {
        model: "anthropic/claude-sonnet-4",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      model("anthropic/claude-sonnet-4"),
    )) {
      events.push(event);
    }

    expect(mock.requestCount() - before).toBe(1);
    expect(events[0]).toMatchObject({
      type: "start",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
    expect(events.at(-1)?.type).toBe("end");
  });
});

describe("createGateway openrouter adapter", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("constructs without throwing for the openrouter adapter branch", async () => {
    const gateway = createGateway({
      providers: [
        {
          id: "openrouter",
          adapter: "openrouter",
          baseUrl: mock.baseUrl,
          auth: { apiKey: "test-openrouter-key" },
          models: [model("google/gemini-2.5-flash")],
        },
      ],
      defaultModel: "google/gemini-2.5-flash",
    });

    const result = await gateway.generate({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });

    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("google/gemini-2.5-flash");
  });
});

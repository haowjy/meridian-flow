/** Non-retryable errors must reach the caller even with cross-provider fallback enabled. */
import { expect, it } from "vitest";
import { createMockScriptQueue } from "./adapters/mock/script-queue.js";
import { createMockOpenAICompatibleServer } from "./adapters/mock/server.js";
import { mockProviderConfig } from "./config/providers.js";
import { createGateway } from "./create-gateway.js";

it("propagates context overflow through the provider fallback router", async () => {
  const script = createMockScriptQueue();
  script.enqueue({
    steps: [{ error: { status: 400, message: "maximum context length exceeded" }, times: 1 }],
  });
  const server = await createMockOpenAICompatibleServer({ script });
  try {
    const gateway = createGateway({
      providers: [mockProviderConfig(server.baseUrl)],
      defaultModel: "mock-llm-v1",
      fallback: { enabled: true },
    });
    const events = [];
    for await (const event of gateway.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }))
      events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", code: "context_overflow", retryable: false }),
    );
  } finally {
    await server.close();
  }
});

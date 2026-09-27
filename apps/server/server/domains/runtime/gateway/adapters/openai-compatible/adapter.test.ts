/** The gateway owns retries: the SDK client must not re-send a failed request on its own. */
import { afterEach, describe, expect, it } from "vitest";
import { mockProviderConfig } from "../../config/providers.js";
import { user } from "../../helpers/messages.js";
import { createMockScriptQueue } from "../mock/script-queue.js";
import { createMockOpenAICompatibleServer, type MockOpenAIServer } from "../mock/server.js";
import { createOpenAICompatibleAdapter } from "./adapter.js";

describe("openai-compatible adapter retries", () => {
  let server: MockOpenAIServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("surfaces a 5xx as one retryable error after a single HTTP request", async () => {
    const queue = createMockScriptQueue();
    server = await createMockOpenAICompatibleServer({ script: queue });
    queue.enqueue({ steps: [{ error: { status: 500, message: "down" } }] });
    const config = mockProviderConfig(server.baseUrl);
    const adapter = createOpenAICompatibleAdapter(config);
    const model = config.models[0];
    if (!model) throw new Error("mock config has no model");

    const events = [];
    for await (const event of adapter.stream({ messages: [user("go")] }, model)) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
    expect(server.requestCount()).toBe(1);
  });
});

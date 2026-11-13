/** The gateway owns retries: the SDK client must not re-send a failed request on its own.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Gateway-owned provider retry policy (kb/wiki/architecture/model-gateway.md#calls-time-out-on-stalls-not-on-a-deadline)
 */
import { afterEach, describe, expect, it } from "vitest";
import { user } from "../../helpers/messages.js";
import {
  createMockOpenAICompatibleServer,
  createMockScriptQueue,
  type MockOpenAIServer,
  mockProviderConfig,
} from "../../mock.js";
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
    const providerModel = config.models[0];
    if (!providerModel) throw new Error("mock config has no model");
    const model = { ...providerModel, wire: config.adapter };

    const events = [];
    for await (const event of adapter.stream(
      {
        promptCacheRetention: "short",
        messages: [user("go")],
      },
      model,
      { cacheTtlSeconds: null, longCacheWrites: false, reasoning: "default" },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
    expect(server.requestCount()).toBe(1);
  });
});

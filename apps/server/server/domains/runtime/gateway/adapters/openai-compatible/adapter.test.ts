/** SDK lifecycle boundaries: one request per retry and no repaired partial calls on abort. */
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { mockProviderConfig } from "../../config/providers.js";
import type { StreamEvent } from "../../domain/index.js";
import { user } from "../../helpers/messages.js";
import { createMockScriptQueue } from "../mock/script-queue.js";
import { createMockOpenAICompatibleServer, type MockOpenAIServer } from "../mock/server.js";
import { createOpenRouterAdapter } from "../openrouter/adapter.js";
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

it.each([
  { name: "compatible", create: createOpenAICompatibleAdapter },
  { name: "OpenRouter", create: createOpenRouterAdapter },
])("$name discards incomplete arguments when the SDK swallows stream abort", async ({ create }) => {
  const http = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        id: "generation",
        usage: { prompt_tokens: 2, completion_tokens: 1 },
        choices: [
          {
            delta: {
              content: "Kept text.",
              tool_calls: [
                { index: 0, id: "complete", function: { name: "read", arguments: "{}" } },
                { index: 1, id: "partial", function: { name: "read", arguments: "{" } },
              ],
            },
          },
        ],
      })}\n\n`,
    );
    // Leave the SSE response open: the client must end it by cancelling.
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const config = mockProviderConfig(`http://127.0.0.1:${address.port}/v1`);
    const adapter = create(config);
    const model = config.models[0];
    if (!model) throw new Error("mock config has no model");
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    for await (const event of adapter.stream(
      { messages: [user("go")], signal: controller.signal },
      model,
    )) {
      events.push(event);
      if (event.type === "tool_call.delta" && event.id === "partial") controller.abort();
    }
    const end = events.at(-1);
    expect(end?.type).toBe("end");
    if (end?.type !== "end") throw new Error("missing partial result");
    expect(end.result.content).toEqual([
      { type: "text", text: "Kept text." },
      { type: "tool_use", toolCallId: "complete", toolName: "read", input: {} },
    ]);
    expect(end.result.toolCalls).toEqual([{ id: "complete", name: "read", arguments: {} }]);
    expect(end.result.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

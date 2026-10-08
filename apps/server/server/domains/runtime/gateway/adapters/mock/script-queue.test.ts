/** Scripted mock-model replies: queue scoping and the wire responses the gateway adapter consumes. */
import { afterEach, describe, expect, it } from "vitest";
import { createMockScriptQueue } from "./script-queue.js";
import { createMockOpenAICompatibleServer, type MockOpenAIServer } from "./server.js";

describe("mock server scripted replies", () => {
  let server: MockOpenAIServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function post(body: unknown) {
    if (!server) throw new Error("server not started");
    return fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("streams scripted text and tool calls, then falls back to canned behavior", async () => {
    const queue = createMockScriptQueue();
    server = await createMockOpenAICompatibleServer({ script: queue });
    queue.enqueue({
      match: "draft",
      steps: [
        { text: "On it.", toolCalls: [{ name: "write", args: { path: "manuscript://x.md" } }] },
      ],
    });

    const scripted = await (
      await post({ stream: true, messages: [{ role: "user", content: "draft the scene" }] })
    ).text();
    expect(scripted).toContain('"content":"On"');
    expect(scripted).toContain('"content":" it."');
    expect(scripted).toContain('"name":"write"');
    expect(scripted).toContain('"finish_reason":"tool_calls"');

    const canned = await (
      await post({ stream: true, messages: [{ role: "user", content: "draft the scene" }] })
    ).text();
    expect(canned).toContain("Acknowledged");
  });
});

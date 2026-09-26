/** Scripted mock-model replies: queue scoping and the wire responses the gateway adapter consumes. */
import { afterEach, describe, expect, it } from "vitest";
import { createMockScriptQueue } from "./script-queue.js";
import { createMockOpenAICompatibleServer, type MockOpenAIServer } from "./server.js";

describe("createMockScriptQueue", () => {
  it("prefers a matching scoped script, falls back to unscoped, and drains in order", () => {
    const queue = createMockScriptQueue();
    queue.enqueue({ steps: [{ text: "any-1" }] });
    queue.enqueue({ match: "chapter 2", steps: [{ text: "scoped-1" }, { text: "scoped-2" }] });

    expect(queue.take("rewrite chapter 2")?.text).toBe("scoped-1");
    expect(queue.take("something else")?.text).toBe("any-1");
    expect(queue.take("something else")).toBeNull();
    expect(queue.state().scripts).toEqual([
      expect.objectContaining({ match: "chapter 2", remaining: 1 }),
    ]);
    expect(queue.take("chapter 2 again")?.text).toBe("scoped-2");
    expect(queue.state().scripts).toEqual([]);
  });

  it("clears everything", () => {
    const queue = createMockScriptQueue();
    queue.enqueue({ steps: [{ text: "x" }] });
    expect(queue.clear().scripts).toEqual([]);
  });
});

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

  it("returns scripted provider errors with their status", async () => {
    const queue = createMockScriptQueue();
    server = await createMockOpenAICompatibleServer({ script: queue });
    queue.enqueue({ steps: [{ error: { status: 503, message: "overloaded" } }] });
    const response = await post({ stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { message: "overloaded" } });
  });

  it("answers non-streaming calls with scripted tool calls", async () => {
    const queue = createMockScriptQueue();
    server = await createMockOpenAICompatibleServer({ script: queue });
    queue.enqueue({ steps: [{ toolCalls: [{ name: "read", args: { uri: "kb://a.md" } }] }] });
    const body = (await (await post({ messages: [{ role: "user", content: "hi" }] })).json()) as {
      choices: { message: { tool_calls: { function: { name: string } }[] } }[];
    };
    expect(body.choices[0]?.message.tool_calls[0]?.function.name).toBe("read");
  });
});

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

  it("clears everything, or one script by id", () => {
    const queue = createMockScriptQueue();
    const first = queue.enqueue({ steps: [{ text: "x" }] });
    queue.enqueue({ steps: [{ text: "y" }] });
    expect(queue.clear(first.id).scripts).toEqual([
      expect.objectContaining({ remaining: 1, sticky: false }),
    ]);
    expect(queue.clear().scripts).toEqual([]);
  });

  it("keeps a timeless error step for every matching call so retries cannot slip past it", () => {
    const queue = createMockScriptQueue();
    queue.enqueue({ match: "go", steps: [{ error: { status: 500, message: "boom" } }] });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(queue.take("go")?.error?.message).toBe("boom");
    }
    expect(queue.state().scripts).toEqual([expect.objectContaining({ sticky: true })]);
    expect(queue.take("other")).toBeNull();
  });

  it("answers `times` calls per step before moving on", () => {
    const queue = createMockScriptQueue();
    queue.enqueue({
      steps: [
        { error: { status: 503, message: "blip" }, times: 1 },
        { text: "ok", times: 2 },
      ],
    });
    expect(queue.take("x")?.error?.status).toBe(503);
    expect(queue.take("x")?.text).toBe("ok");
    expect(queue.take("x")?.text).toBe("ok");
    expect(queue.take("x")).toBeNull();
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

  it("keeps failing repeated calls with a sticky scripted error", async () => {
    const queue = createMockScriptQueue();
    server = await createMockOpenAICompatibleServer({ script: queue });
    queue.enqueue({ match: "go", steps: [{ error: { status: 500, message: "down" } }] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post({ stream: true, messages: [{ role: "user", content: "go" }] });
      expect(response.status).toBe(500);
      await response.text();
    }
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

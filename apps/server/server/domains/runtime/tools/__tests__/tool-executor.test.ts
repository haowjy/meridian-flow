import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { describe, expect, it } from "vitest";

import { createCoreToolRegistrations } from "../core-tools.js";
import { createToolExecutor } from "../tool-executor.js";
import { createToolRegistry } from "../tool-registry.js";
import type {
  InterruptToolHandlerContext,
  ToolHandler,
  ToolHandlerContext,
  ToolRegistration,
  ToolRegistry,
} from "../types.js";

function toolErrorOutput(message: string) {
  return {
    code: "tool_error",
    message,
    retryable: false,
    source: "tool",
  };
}

function serverTool<TContext extends ToolHandlerContext = ToolHandlerContext>(
  name: string,
  handler: ToolHandler<TContext>,
  opts?: Pick<ToolRegistration, "timeoutMs" | "sequential" | "capability">,
): ToolRegistration {
  return {
    source: "core",
    definition: {
      type: "function",
      name,
      description: `${name} tool`,
      inputSchema: { type: "object" },
    },
    execution: {
      type: "server",
      handler: handler as Extract<ToolRegistration["execution"], { type: "server" }>["handler"],
    },
    ...opts,
  };
}

const ctx = {
  threadId: "thread-1",
  turnId: "turn-1",
  agentSlug: null,
};

function throwingRegistry(message = "registry lookup failed"): ToolRegistry {
  return {
    register: () => {},
    getDefinitions: () => [],
    getRegistration: () => {
      throw new Error(message);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createToolExecutor", () => {
  it("executes the real write diff command with turn-scoped context", async () => {
    const received: Array<{
      threadId: string;
      turnId: string;
      documentId?: string;
    }> = [];
    const harness = createWriteToolHarness(
      {},
      {
        turnDiffQuery: {
          async query(threadId, turnId, documentId) {
            received.push({ threadId, turnId, documentId });
            return {
              trailState: "building",
              sharedEffects: true,
              changes: [
                {
                  kind: "modify",
                  documentId: "doc-1",
                  before: "Writer's opening.",
                  after: "Agent's revised opening.",
                  mergedOver: [{ body: "A concurrent sentence.", writerAuthored: true }],
                },
              ],
            };
          },
        },
      },
    );
    const registrations = createCoreToolRegistrations({
      write: async (input: unknown, context: ToolHandlerContext) => {
        const outcome = await harness.core.write(input as never, {
          threadId: context.threadId,
          turnId: context.turnId,
          sessionId: context.threadId,
        });
        return { output: outcome.text };
      },
      ls: async () => ({}),
      grep: async () => ({}),
      ask_user: async () => ({}),
    });
    const registry = createToolRegistry();
    const writeRegistration = registrations.find(
      (registration) => registration.definition.name === "write",
    );
    if (!writeRegistration) throw new Error("write registration missing");
    registry.register(writeRegistration);

    const result = await createToolExecutor(registry).executeTool(
      { id: "call-diff", name: "write", arguments: { command: "diff" } },
      ctx,
    );

    expect(received).toEqual([{ threadId: "thread-1", turnId: "turn-1", documentId: undefined }]);
    expect(result.output).toEqual(expect.stringContaining("Results are provisional"));
    expect(result.output).toEqual(expect.stringContaining("Before:\nWriter's opening."));
    expect(result.output).toEqual(
      expect.stringContaining("Merged over writer-authored content:\nA concurrent sentence."),
    );
  });

  it("returns handler output on success", async () => {
    const registry = createToolRegistry();
    registry.register(serverTool("echo", async (input) => ({ echoed: input })));
    const executor = createToolExecutor(registry);

    const result = await executor.executeTool(
      { id: "call-1", name: "echo", arguments: { msg: "hi" } },
      ctx,
    );

    expect(result).toEqual({
      toolCallId: "call-1",
      output: { echoed: { msg: "hi" } },
    });
  });

  it("returns a clear parse error for malformed tool arguments", async () => {
    const registry = createToolRegistry();
    let handlerCalled = false;
    registry.register(
      serverTool("read_file", async () => {
        handlerCalled = true;
        return "handler result";
      }),
    );
    const executor = createToolExecutor(registry);

    const result = await executor.executeTool(
      {
        id: "call-parse-error",
        name: "read_file",
        arguments: {},
        argumentsParseError: {
          raw: '{"path":"manuscript://chapter-1.md","in": 6c4a,"command":"read"}',
          message: "Unexpected character",
        },
      },
      ctx,
    );

    expect(result).toEqual({
      toolCallId: "call-parse-error",
      output: toolErrorOutput(
        'Tool arguments for "read_file" were not valid JSON and could not be parsed or repaired (Unexpected character). Received: {"path":"manuscript://chapter-1.md","in": 6c4a,"command":"read"} — re-send this tool call with only a valid JSON object (every string value, including hashes, must be quoted).',
      ),
      isError: true,
    });
    expect(handlerCalled).toBe(false);
  });

  it("binds handler output deltas to the current tool call id", async () => {
    const registry = createToolRegistry();
    registry.register(
      serverTool("streaming", async (_input, context) => {
        context.emitOutputDelta?.({ stream: "stdout", text: "hi" });
        return "done";
      }),
    );
    const emitted: unknown[] = [];
    const executor = createToolExecutor(registry);

    const result = await executor.executeTool(
      { id: "call-stream", name: "streaming", arguments: {} },
      {
        ...ctx,
        emitOutputDelta: (toolCallId, chunk) => emitted.push({ toolCallId, ...chunk }),
      },
    );

    expect(result).toEqual({ toolCallId: "call-stream", output: "done" });
    expect(emitted).toEqual([{ toolCallId: "call-stream", stream: "stdout", text: "hi" }]);
  });

  it("injects interrupt context only for interrupt registrations", async () => {
    const registry = createToolRegistry();
    const seenContexts: unknown[] = [];
    registry.register(
      serverTool("base", async (_input, context) => {
        seenContexts.push(context);
        return { hasInterrupt: "interrupt" in context };
      }),
    );
    registry.register(
      serverTool<InterruptToolHandlerContext>(
        "interrupt_tool",
        async (_input, context) => {
          seenContexts.push(context);
          const response = await context.interrupt(
            {
              interruptId: "interrupt-1",
              prompt: "Confirm?",
              artifacts: [],
              answerSchema: { type: "object", properties: { value: { type: "string" } } },
            },
            100,
          );
          await context.updateComponentBlock("interrupt-1", { resolvedValue: response.value });
          return { response, timeoutMs: context.interruptTimeoutMs };
        },
        { capability: "interrupt" },
      ),
    );
    const executor = createToolExecutor(registry);

    await expect(
      executor.executeTool({ id: "call-1", name: "base", arguments: {} }, ctx),
    ).resolves.toEqual({
      toolCallId: "call-1",
      output: { hasInterrupt: false },
    });

    await expect(
      executor.executeTool(
        { id: "call-2", name: "interrupt_tool", arguments: {} },
        {
          ...ctx,
          interruptTimeoutMs: 1234,
          interrupt: async () => ({ value: "ok", provenance: "user" }),
          updateComponentBlock: async () => {},
        },
      ),
    ).resolves.toEqual({
      toolCallId: "call-2",
      output: { response: { value: "ok", provenance: "user" }, timeoutMs: 1234 },
    });

    expect(
      seenContexts.map((context) => "interrupt" in (context as Record<string, unknown>)),
    ).toEqual([false, true]);
  });

  it.each([
    {
      name: "tool is not found",
      makeExecutor: () => createToolExecutor(createToolRegistry()),
      callName: "missing",
      expectedOutput: "Tool not found: missing",
    },
    {
      name: "tool is registered as a client tool",
      makeExecutor: () => {
        const registry = createToolRegistry();
        registry.register({
          source: "core",
          definition: {
            type: "function",
            name: "confirm",
            description: "confirm tool",
            inputSchema: { type: "object" },
          },
          execution: { type: "client" },
        });
        return createToolExecutor(registry);
      },
      callName: "confirm",
      expectedOutput: "Client tool dispatch not implemented",
    },
    {
      name: "server handler throws",
      makeExecutor: () => {
        const registry = createToolRegistry();
        registry.register(
          serverTool("boom", async () => {
            throw new Error("handler failed");
          }),
        );
        return createToolExecutor(registry);
      },
      callName: "boom",
      expectedOutput: "handler failed",
    },
    {
      name: "registry lookup throws",
      makeExecutor: () => createToolExecutor(throwingRegistry()),
      callName: "any",
      expectedOutput: "registry lookup failed",
    },
  ])("resolves to isError when $name", async ({ makeExecutor, callName, expectedOutput }) => {
    const result = await makeExecutor().executeTool(
      { id: "call-1", name: callName, arguments: {} },
      ctx,
    );

    expect(result).toEqual({
      toolCallId: "call-1",
      output: toolErrorOutput(expectedOutput),
      isError: true,
    });
  });

  it("returns timeout error, aborts the handler signal, and swallows late rejection", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      let handlerSawAbort = false;
      const registry = createToolRegistry();
      registry.register(
        serverTool(
          "slow",
          async (_input, { signal }) => {
            await new Promise<void>((resolve) => {
              const fallback = setTimeout(resolve, 200);
              signal.addEventListener("abort", () => {
                handlerSawAbort = true;
                clearTimeout(fallback);
                setTimeout(resolve, 10);
              });
            });
            throw new Error("late failure");
          },
          { timeoutMs: 20 },
        ),
      );
      const executor = createToolExecutor(registry);

      const result = await executor.executeTool({ id: "call-1", name: "slow", arguments: {} }, ctx);

      expect(result).toEqual({
        toolCallId: "call-1",
        output: toolErrorOutput("Tool timed out after 20ms"),
        isError: true,
      });
      expect(handlerSawAbort).toBe(true);

      await delay(50);
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("executeTools does not reject when registry lookup throws", async () => {
    const executor = createToolExecutor(throwingRegistry("batch lookup failed"));

    const results = await executor.executeTools(
      [
        { id: "c1", name: "a", arguments: {} },
        { id: "c2", name: "b", arguments: {} },
      ],
      ctx,
    );

    expect(results).toEqual([
      { toolCallId: "c1", output: toolErrorOutput("batch lookup failed"), isError: true },
      { toolCallId: "c2", output: toolErrorOutput("batch lookup failed"), isError: true },
    ]);
  });

  it("executeTools preserves original result order and runs sequential tools one-at-a-time after the parallel group", async () => {
    const registry = createToolRegistry();
    const events: string[] = [];
    let parallelActive = 0;
    let maxParallelActive = 0;
    let parallelStarted = 0;
    let releaseParallel!: () => void;
    const parallelGate = new Promise<void>((resolve) => {
      releaseParallel = resolve;
    });
    const fallbackRelease = setTimeout(releaseParallel, 50);

    function registerParallel(name: string, output: string) {
      registry.register(
        serverTool(name, async () => {
          events.push(`${name}:start`);
          parallelActive += 1;
          maxParallelActive = Math.max(maxParallelActive, parallelActive);
          parallelStarted += 1;
          if (parallelStarted === 2) {
            clearTimeout(fallbackRelease);
            releaseParallel();
          }
          await parallelGate;
          parallelActive -= 1;
          events.push(`${name}:end`);
          return output;
        }),
      );
    }

    let sequentialActive = 0;
    let maxSequentialActive = 0;
    function registerSequential(name: string, output: string) {
      registry.register(
        serverTool(
          name,
          async () => {
            events.push(`${name}:start`);
            expect(parallelActive).toBe(0);
            sequentialActive += 1;
            maxSequentialActive = Math.max(maxSequentialActive, sequentialActive);
            await delay(10);
            sequentialActive -= 1;
            events.push(`${name}:end`);
            return output;
          },
          { sequential: true },
        ),
      );
    }

    registerSequential("seq-a", "seq-a-result");
    registerParallel("parallel-a", "parallel-a-result");
    registerSequential("seq-b", "seq-b-result");
    registerParallel("parallel-b", "parallel-b-result");
    const executor = createToolExecutor(registry);

    const results = await executor.executeTools(
      [
        { id: "c1", name: "seq-a", arguments: {} },
        { id: "c2", name: "parallel-a", arguments: {} },
        { id: "c3", name: "seq-b", arguments: {} },
        { id: "c4", name: "parallel-b", arguments: {} },
      ],
      ctx,
    );

    expect(results.map((r) => r.output)).toEqual([
      "seq-a-result",
      "parallel-a-result",
      "seq-b-result",
      "parallel-b-result",
    ]);
    expect(maxParallelActive).toBe(2);
    expect(maxSequentialActive).toBe(1);
    expect(events.indexOf("seq-a:start")).toBeGreaterThan(events.indexOf("parallel-a:end"));
    expect(events.indexOf("seq-a:start")).toBeGreaterThan(events.indexOf("parallel-b:end"));
    expect(events.indexOf("seq-b:start")).toBeGreaterThan(events.indexOf("seq-a:end"));
  });

  it("does not invoke a handler when execution context is already aborted", async () => {
    const registry = createToolRegistry();
    let handlerCalled = false;
    registry.register(
      serverTool("slow", async () => {
        handlerCalled = true;
        return "should not run";
      }),
    );
    const controller = new AbortController();
    controller.abort();
    const executor = createToolExecutor(registry);

    const result = await executor.executeTool(
      { id: "call-1", name: "slow", arguments: {} },
      { ...ctx, signal: controller.signal },
    );

    expect(result).toEqual({
      toolCallId: "call-1",
      output: toolErrorOutput("Tool aborted"),
      isError: true,
    });
    expect(handlerCalled).toBe(false);
  });

  it("aborts an in-flight handler when the execution context signal is cancelled", async () => {
    const registry = createToolRegistry();
    const controller = new AbortController();
    let handlerSawAbort = false;
    registry.register(
      serverTool("slow", async (_input, { signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              handlerSawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return "late result";
      }),
    );
    const executor = createToolExecutor(registry);

    const resultPromise = executor.executeTool(
      { id: "call-1", name: "slow", arguments: {} },
      { ...ctx, signal: controller.signal },
    );
    controller.abort();

    await expect(resultPromise).resolves.toEqual({
      toolCallId: "call-1",
      output: toolErrorOutput("Tool aborted"),
      isError: true,
    });
    expect(handlerSawAbort).toBe(true);
  });

  it("returns isError for a tool that was not registered", async () => {
    const executor = createToolExecutor(createToolRegistry());

    const result = await executor.executeTool(
      { id: "call-1", name: "missing_tool", arguments: {} },
      ctx,
    );

    expect(result).toEqual({
      toolCallId: "call-1",
      output: toolErrorOutput("Tool not found: missing_tool"),
      isError: true,
    });
  });
});

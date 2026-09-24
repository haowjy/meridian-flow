/** Malformed read calls receive repair guidance, then valid read calls dispatch in the same turn. */
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../../threads/index.js";
import type { Gateway, GenerateResult, StreamEvent } from "../../gateway/index.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import type { ToolHandlerContext, ToolRegistration } from "../../tools/types.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

const usage = { inputTokens: 1, outputTokens: 1 };

function toolCall(name: string, id: string, input: Record<string, unknown>): GenerateResult {
  return {
    content: [{ type: "tool_use", toolCallId: id, toolName: name, input }],
    toolCalls: [],
    finishReason: "tool_use",
    usage,
    model: "gpt-4.1-mini",
    provider: "openai",
  };
}

function textResult(): GenerateResult {
  return {
    content: [{ type: "text", text: "Read complete." }],
    toolCalls: [],
    finishReason: "end_turn",
    usage,
    model: "gpt-4.1-mini",
    provider: "openai",
  };
}

describe("read command recovery through the runtime loop", () => {
  it("reports malformed args and dispatches the corrected read without ending the turn", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Read recovery" });
    const repos = createInMemoryRepositories({ projects });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000",
      reason: "read recovery test",
    });

    const dispatched: unknown[] = [];
    const registration: ToolRegistration = {
      source: "core",
      definition: {
        type: "function",
        name: "read",
        description: 'Use `{ "command": "read", "path": "..." }`.',
        inputSchema: {
          type: "object",
          oneOf: [
            {
              type: "object",
              properties: { command: { type: "string", const: "read" }, path: { type: "string" } },
              required: ["command", "path"],
            },
            {
              type: "object",
              properties: { command: { type: "string", const: "diff" } },
              required: ["command"],
            },
          ],
        },
      },
      execution: {
        type: "server",
        async handler(input: unknown, _context: ToolHandlerContext) {
          dispatched.push(input);
          return { content: "chapter text" };
        },
      },
    };
    const toolRegistry = createToolRegistry({ registrations: [registration] });
    const results = [
      toolCall("read", "read-missing-command", { path: "manuscript://chapter.md" }),
      toolCall("read", "read-corrected", {
        command: "read",
        path: "manuscript://chapter.md",
      }),
      textResult(),
    ];
    let requestIndex = 0;
    const gateway: Gateway = {
      getDefaultModel: () => "fixture-model",
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "end", result: results[requestIndex++] };
      },
      async generate() {
        throw new Error("Not used");
      },
    };
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        boundThreads: () => [thread.id],
        gateway,
        repos,
        creditLedger,
        eventWriter: createInMemoryEventJournalWriter(),
        toolRegistry,
        toolExecutor: createToolExecutor(toolRegistry),
      }),
    );

    const handle = await orchestrator.runTurn({ threadId: thread.id, userText: "Read chapter." });
    const events = [];
    for await (const event of handle.events) events.push(event);

    const toolResults = events.filter((event) => event.type === "tool.result");
    expect(toolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "read-missing-command",
          output: expect.objectContaining({
            error: "invalid_arguments",
            reason: expect.stringContaining('command: "read"'),
          }),
          isError: true,
        }),
        expect.objectContaining({
          toolCallId: "read-corrected",
          output: { content: "chapter text" },
          isError: undefined,
        }),
      ]),
    );
    expect(events.some((event) => event.type === "permission.denied")).toBe(false);
    expect(dispatched).toEqual([{ command: "read", path: "manuscript://chapter.md" }]);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });
});

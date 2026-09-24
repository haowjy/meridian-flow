/** Malformed read calls receive repair guidance, then valid read calls dispatch in the same turn. */
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../../threads/index.js";
import type { Gateway, GenerateRequest, GenerateResult, StreamEvent } from "../../gateway/index.js";
import {
  type CoreToolHandlers,
  createCoreToolRegistrations,
  createToolExecutor,
  createToolRegistry,
} from "../../tools/index.js";
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
    const handlers: CoreToolHandlers = {
      read: async (input: Parameters<CoreToolHandlers["read"]>[0]) => {
        dispatched.push(input);
        return { content: "chapter text" };
      },
      write: async () => ({ ok: true }),
      work: async () => ({ ok: true }),
      ls: async () => ({ ok: true }),
      search: async () => ({ ok: true }),
      ask_user: async () => ({ ok: true }),
    };
    const readRegistration = createCoreToolRegistrations(handlers).find(
      (registration) =>
        registration.definition.type === "function" && registration.definition.name === "read",
    );
    if (!readRegistration) throw new Error("Core read registration was not created");
    const toolRegistry = createToolRegistry({ registrations: [readRegistration] });
    const results = [
      toolCall("read", "read-missing-command", { path: "manuscript://chapter.md" }),
      toolCall("read", "read-corrected", {
        command: "read",
        path: "manuscript://chapter.md",
      }),
      textResult(),
    ];
    let requestIndex = 0;
    const requests: GenerateRequest[] = [];
    const gateway: Gateway = {
      getDefaultModel: () => "fixture-model",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push(request);
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
    const assistantTurn = (await repos.turns.listByThread(thread.id)).find(
      (turn) => turn.role === "assistant",
    );
    expect(assistantTurn).toBeDefined();
    const savedRejection = (await repos.blocks.listByTurn(assistantTurn?.id ?? "")).find(
      (block) =>
        block.blockType === "tool_result" &&
        (block.content as { toolCallId?: string } | null)?.toolCallId === "read-missing-command",
    );
    const persistedOutput = (savedRejection?.content as { output?: unknown } | null)?.output;
    expect(persistedOutput).toMatchObject({ error: "invalid_arguments" });
    const repairReason = (persistedOutput as { reason: string }).reason;
    expect(repairReason).toContain("command");
    expect(repairReason).toContain("read");
    const retryMessage = requests[1]?.messages
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool_result" && part.toolCallId === "read-missing-command");
    expect(retryMessage).toMatchObject({
      type: "tool_result",
      toolCallId: "read-missing-command",
      output: persistedOutput,
      isError: true,
    });
    expect(JSON.stringify(retryMessage)).toContain("invalid_arguments");
    expect((retryMessage as { output: { reason: string } }).output.reason).toBe(repairReason);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });
});

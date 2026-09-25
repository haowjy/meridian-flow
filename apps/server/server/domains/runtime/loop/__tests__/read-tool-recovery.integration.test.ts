/** Malformed write calls receive repair guidance, then write(read) dispatches in the same turn. */
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
import { createTestAgentBinding, createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

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

describe("document command recovery through the runtime loop", () => {
  it("reports malformed args and dispatches corrected write(read) without ending the turn", async () => {
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
      write: async (input: Parameters<CoreToolHandlers["write"]>[0]) => {
        dispatched.push(input);
        return { content: "chapter text" };
      },
      work: async () => ({ ok: true }),
      ls: async () => ({ ok: true }),
      search: async () => ({ ok: true }),
      ask_user: async () => ({ ok: true }),
    };
    const writeRegistration = createCoreToolRegistrations(handlers).find(
      (registration) =>
        registration.definition.type === "function" && registration.definition.name === "write",
    );
    if (!writeRegistration) throw new Error("Core write registration was not created");
    const toolRegistry = createToolRegistry({ registrations: [writeRegistration] });
    const results = [
      toolCall("write", "read-missing-command", { path: "manuscript://chapter.md" }),
      toolCall("write", "read-corrected", {
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
    const eventWriter = createInMemoryEventJournalWriter();
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        boundThreads: () => [thread.id],
        gateway,
        repos,
        creditLedger,
        eventWriter,
        toolRegistry,
        toolExecutor: createToolExecutor(toolRegistry),
      }),
    );

    const handle = await orchestrator.prepare({ threadId: thread.id, userText: "Read chapter." });
    expect((await handle.execute()).status).toBe("complete");
    const events = eventWriter.getEvents(thread.id).map((entry) => entry.event);

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
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
  });

  it("persists policy denials for edits and retired read calls while allowing baseline write.read", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Read-only policy" });
    const repos = createInMemoryRepositories({ projects });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000",
      reason: "read-only policy test",
    });

    const dispatched: unknown[] = [];
    const handlers: CoreToolHandlers = {
      write: async (input: Parameters<CoreToolHandlers["write"]>[0]) => {
        dispatched.push(input);
        return { content: "chapter text" };
      },
      work: async () => ({ ok: true }),
      ls: async () => ({ ok: true }),
      search: async () => ({ ok: true }),
      ask_user: async () => ({ ok: true }),
    };
    const writeRegistration = createCoreToolRegistrations(handlers).find(
      (registration) =>
        registration.definition.type === "function" && registration.definition.name === "write",
    );
    if (!writeRegistration) throw new Error("Core write registration was not created");
    const toolRegistry = createToolRegistry({ registrations: [writeRegistration] });
    const results = [
      {
        content: [
          {
            type: "tool_use" as const,
            toolCallId: "edit-denied",
            toolName: "write",
            input: {
              command: "replace",
              path: "manuscript://chapter.md",
              text: "Changed text",
            },
          },
          {
            type: "tool_use" as const,
            toolCallId: "old-read-denied",
            toolName: "read",
            input: {
              command: "read",
              path: "manuscript://chapter.md",
            },
          },
          {
            type: "tool_use" as const,
            toolCallId: "baseline-read",
            toolName: "write",
            input: {
              command: "read",
              path: "manuscript://chapter.md",
            },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use" as const,
        usage,
        model: "gpt-4.1-mini",
        provider: "openai",
      },
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
    const baseBinding = createTestAgentBinding("fixture-model", "", () => [thread.id]);
    const agentRevisions = {
      ...baseBinding,
      async readThreadBinding(threadId: string) {
        const binding = await baseBinding.readThreadBinding(threadId);
        return binding
          ? {
              ...binding,
              configuration: { ...binding.configuration, tools: { edit: "deny" as const } },
            }
          : undefined;
      },
    };
    const eventWriter = createInMemoryEventJournalWriter();
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        boundThreads: () => [thread.id],
        gateway,
        repos,
        creditLedger,
        eventWriter,
        toolRegistry,
        toolExecutor: createToolExecutor(toolRegistry),
        agentRevisions,
      }),
    );

    const handle = await orchestrator.prepare({ threadId: thread.id, userText: "Read chapter." });
    expect((await handle.execute()).status).toBe("complete");
    const events = eventWriter.getEvents(thread.id).map((entry) => entry.event);

    const denied = events.filter((event) => event.type === "tool.result" && event.isError === true);
    expect(denied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "edit-denied",
          output: expect.objectContaining({
            error: "permission_denied",
          }),
        }),
        expect.objectContaining({
          toolCallId: "old-read-denied",
          output: expect.objectContaining({
            error: "permission_denied",
          }),
        }),
      ]),
    );
    expect(dispatched).toEqual([{ command: "read", path: "manuscript://chapter.md" }]);

    const assistantTurn = (await repos.turns.listByThread(thread.id)).find(
      (turn) => turn.role === "assistant",
    );
    const persisted = await repos.blocks.listByTurn(assistantTurn?.id ?? "");
    for (const toolCallId of ["edit-denied", "old-read-denied"]) {
      const block = persisted.find(
        (candidate) =>
          candidate.blockType === "tool_result" &&
          (candidate.content as { toolCallId?: string } | null)?.toolCallId === toolCallId,
      );
      expect((block?.content as { output?: unknown } | null)?.output).toMatchObject({
        error: "permission_denied",
      });
    }
    const retryResults = requests[1]?.messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === "tool_result");
    expect(retryResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "edit-denied", isError: true }),
        expect.objectContaining({ toolCallId: "old-read-denied", isError: true }),
      ]),
    );
  });
});

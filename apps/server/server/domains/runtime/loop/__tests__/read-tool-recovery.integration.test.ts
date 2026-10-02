/** The retired write(command="read") gets repair guidance, then `read` dispatches in the same turn. */
import { modelResult } from "@meridian/agent-edit/integration";
import { describe, expect, it } from "vitest";
import type { GenerateResult } from "../../gateway/index.js";
import {
  type CoreToolHandlers,
  createCoreToolRegistrations,
  createToolExecutor,
  createToolRegistry,
} from "../../tools/index.js";
import { createTestAgentBinding } from "./runtime-fixtures.js";
import { runtimeScenario } from "./runtime-harness.js";
import { scriptedGateway } from "./test-gateway.js";

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

const CHAPTER_READ = modelResult({
  command: "read",
  status: "success",
  phase: "committed",
  payload: {
    path: "manuscript://chapter.md",
    read: { format: "full" },
    blocks: [
      { extent: "full", relation: "document", items: [{ hash: "a1b2", body: "Chapter text." }] },
    ],
  },
});

function documentToolRegistry(dispatched: Array<{ tool: string; input: unknown }>) {
  const handler =
    (tool: string): CoreToolHandlers["read"] =>
    async (input: unknown) => {
      dispatched.push({ tool, input });
      return { output: CHAPTER_READ };
    };
  const handlers: CoreToolHandlers = {
    read: handler("read"),
    write: handler("write"),
    work: async () => ({ ok: true }),
    ls: async () => ({ ok: true }),
    search: async () => ({ ok: true }),
    ask_user: async () => ({ ok: true }),
  };
  return createToolRegistry({
    registrations: createCoreToolRegistrations(handlers).filter(
      (registration) =>
        registration.definition.type === "function" &&
        (registration.definition.name === "read" || registration.definition.name === "write"),
    ),
  });
}

describe("document command recovery through the runtime loop", () => {
  it("refuses the retired write read with repair guidance, then dispatches read", async () => {
    const dispatched: Array<{ tool: string; input: unknown }> = [];
    const toolRegistry = documentToolRegistry(dispatched);
    const results = [
      toolCall("write", "retired-read", { command: "read", path: "manuscript://chapter.md" }),
      toolCall("read", "read-corrected", { path: "manuscript://chapter.md" }),
      textResult(),
    ];
    const gateway = scriptedGateway({ results });
    const { requests } = gateway;
    const rig = await runtimeScenario({
      gateway,
      toolRegistry,
      toolExecutor: createToolExecutor(toolRegistry),
    });
    const { orchestrator, repos, thread, journal: eventWriter } = rig;

    const handle = await orchestrator.prepare({ threadId: thread.id, userText: "Read chapter." });
    expect((await handle.execute()).status).toBe("complete");
    const events = eventWriter.getEvents(thread.id).map((entry) => entry.event);

    const toolResults = events.filter((event) => event.type === "tool.result");
    expect(toolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "retired-read",
          output: expect.objectContaining({
            error: "invalid_arguments",
            issues: [expect.objectContaining({ path: "command" })],
          }),
          isError: true,
        }),
        expect.objectContaining({
          toolCallId: "read-corrected",
          output: "status: success; path: manuscript://chapter.md; blocks: 1\n\na1b2|Chapter text.",
          result: CHAPTER_READ,
          isError: undefined,
        }),
      ]),
    );
    expect(dispatched).toEqual([{ tool: "read", input: { path: "manuscript://chapter.md" } }]);
    const assistantTurn = (await repos.turns.listByThread(thread.id)).find(
      (turn) => turn.role === "assistant",
    );
    const savedRejection = (await repos.blocks.listByTurn(assistantTurn?.id ?? "")).find(
      (block) =>
        block.blockType === "tool_result" &&
        (block.content as { toolCallId?: string } | null)?.toolCallId === "retired-read",
    );
    const persistedOutput = (savedRejection?.content as { output?: unknown } | null)?.output;
    expect(persistedOutput).toMatchObject({ error: "invalid_arguments" });
    const retryMessage = requests[1]?.messages
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool_result" && part.toolCallId === "retired-read");
    expect(retryMessage).toMatchObject({ output: persistedOutput, isError: true });
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
  });

  it("refuses write for an agent without edit and still dispatches read", async () => {
    const dispatched: Array<{ tool: string; input: unknown }> = [];
    const toolRegistry = documentToolRegistry(dispatched);
    const results = [
      {
        content: [
          {
            type: "tool_use" as const,
            toolCallId: "edit-denied",
            toolName: "write",
            input: { command: "replace", path: "manuscript://chapter.md", in: 1, content: "x" },
          },
          {
            type: "tool_use" as const,
            toolCallId: "baseline-read",
            toolName: "read",
            input: { path: "manuscript://chapter.md" },
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
    const gateway = scriptedGateway({ results });
    const { requests } = gateway;
    const baseBinding = createTestAgentBinding("fixture-model", "", () => [rig.thread.id]);
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
    const rig = await runtimeScenario({
      gateway,
      toolRegistry,
      toolExecutor: createToolExecutor(toolRegistry),
      agentRevisions,
    });
    const { orchestrator, repos, thread, journal: eventWriter } = rig;

    const handle = await orchestrator.prepare({ threadId: thread.id, userText: "Read chapter." });
    expect((await handle.execute()).status).toBe("complete");
    const events = eventWriter.getEvents(thread.id).map((entry) => entry.event);

    expect(requests[0]?.tools?.map((tool) => (tool.type === "function" ? tool.name : ""))).toEqual([
      "read",
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.result",
          toolCallId: "edit-denied",
          isError: true,
          output: expect.objectContaining({ error: "permission_denied" }),
        }),
      ]),
    );
    expect(dispatched).toEqual([{ tool: "read", input: { path: "manuscript://chapter.md" } }]);

    const assistantTurn = (await repos.turns.listByThread(thread.id)).find(
      (turn) => turn.role === "assistant",
    );
    const persisted = await repos.blocks.listByTurn(assistantTurn?.id ?? "");
    const denial = persisted.find(
      (candidate) =>
        candidate.blockType === "tool_result" &&
        (candidate.content as { toolCallId?: string } | null)?.toolCallId === "edit-denied",
    );
    expect((denial?.content as { output?: unknown } | null)?.output).toMatchObject({
      error: "permission_denied",
    });
  });
});

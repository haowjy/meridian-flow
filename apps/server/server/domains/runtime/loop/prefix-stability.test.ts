/**
 * A thread's cached request prefix (tools, frozen system prompt, history) is
 * fixed for the life of the thread. This drives `assembleNextTurnContext` —
 * the public seam the orchestrator and preview route both call before
 * `gateway.stream()` — through a growing conversation and asserts every new
 * request is a byte-identical extension of the previous one.
 *
 * Exception (documented, not asserted away): `mergeAdjacentUserMessages` in
 * context-builder.ts folds a newly-arrived notice/steer message into the
 * still-pending trailing user message instead of appending a new message, so
 * only the *previous request's final message* may differ in the next
 * request — everything before it, including the frozen system message and
 * every earlier history message, must stay byte-identical. Once a
 * non-foldable message (assistant/tool) is appended, the earlier message
 * that used to be final is frozen for good.
 */
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryAgentRevisionStore } from "../../packages/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import type { Gateway, GenerateRequest, ModelInfo } from "../gateway/index.js";
import { createToolRegistry } from "../tools/index.js";
import { assembleNextTurnContext } from "./turn-context-assembly.js";
import type { WorkContextReader } from "./work-context.js";

const MODEL_ID = "fixture-model";

/** Declares "caching" so `assembleNextTurnContext` applies Anthropic cache marks. */
function cachingGateway(): Pick<Gateway, "getDefaultModel" | "listModels"> {
  const model: ModelInfo = {
    id: MODEL_ID,
    provider: "test",
    displayName: "Fixture",
    contextWindow: 100_000,
    maxOutputTokens: 4_096,
    capabilities: new Set(["caching"]),
  };
  return {
    getDefaultModel: () => MODEL_ID,
    listModels: () => [model],
  };
}

function noWorkContext(projectId: string): WorkContextReader {
  return {
    async renderForThread() {
      return {
        text: "",
        current: {
          projectId,
          execution: {
            scope: { workId: "00000000-0000-0000-0000-000000000002", workSlug: null },
            aiWriteMode: "direct",
            draftOwner: null,
          },
        },
      };
    },
  };
}

function userTurn(id: string, text: string): { turn: Turn; block: Block } {
  return {
    turn: {
      id,
      threadId: "",
      prevTurnId: null,
      parentTurnId: null,
      role: "user",
      origin: "writer",
      writeMode: null,
      status: "complete",
      finishReason: null,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: "0",
      responseCount: 0,
      usage: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
      blocks: [],
      siblingIds: [],
      responses: [],
    },
    block: {
      id: `${id}-b1`,
      turnId: id,
      responseId: null,
      blockType: "text",
      sequence: 0,
      textContent: text,
      content: { text },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function systemNoticeTurn(id: string, text: string): { turn: Turn; block: Block } {
  const built = userTurn(id, text);
  return { turn: { ...built.turn, role: "system", origin: "system" }, block: built.block };
}

function assistantToolExchangeTurn(
  id: string,
  toolCallId: string,
): { turn: Turn; blocks: Block[] } {
  const turn: Turn = {
    id,
    threadId: "",
    prevTurnId: null,
    parentTurnId: null,
    role: "assistant",
    origin: "assistant",
    writeMode: null,
    status: "complete",
    finishReason: "tool_use",
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 1,
    usage: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    blocks: [],
    siblingIds: [],
    responses: [],
  };
  const toolUse: Block = {
    id: `${id}-use`,
    turnId: id,
    responseId: "response-1",
    blockType: "tool_use",
    sequence: 0,
    content: { toolCallId, toolName: "search", input: { query: "prior chapters" } },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const toolResult: Block = {
    id: `${id}-result`,
    turnId: id,
    responseId: "response-1",
    blockType: "tool_result",
    sequence: 1,
    content: { toolCallId, output: "3 matches found.", isError: false },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return { turn, blocks: [toolUse, toolResult] };
}

/** Every message before the previous request's final one must stay byte-identical. */
function assertIsStableExtension(previous: GenerateRequest, next: GenerateRequest) {
  expect(next.tools).toEqual(previous.tools);
  expect(next.messages.length).toBeGreaterThanOrEqual(previous.messages.length);
  const stableCount = previous.messages.length - 1;
  for (let index = 0; index < stableCount; index++) {
    expect(next.messages[index]).toEqual(previous.messages[index]);
  }
}

describe("prefix stability across a growing thread", () => {
  it("keeps tools, system, and settled history byte-identical as steer, notices, a skill, and a tool round-trip land", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const agentRevisions = createInMemoryAgentRevisionStore({
      threadExists: async (id) => Boolean(await repos.threads.findById(id)),
    });
    const thread0 = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "Prefix stability",
    });
    await agentRevisions.bindThread(
      thread0.id,
      null,
      { model: MODEL_ID, skills: { load: [], available: [] }, namedTargets: [] },
      null,
    );

    const gateway = cachingGateway();
    const toolRegistry = createToolRegistry();
    const baseTools = [
      { type: "function" as const, name: "write", description: "Edit prose.", inputSchema: {} },
      {
        type: "function" as const,
        name: "thread_message",
        description: "v1 tool description.",
        inputSchema: {},
      },
    ];
    const workContext = noWorkContext(project.id);

    async function assemble(
      turns: Turn[],
      blocks: Block[],
      skillBodiesByTurn?: Map<
        string,
        readonly { slug: string; description: string; body: string }[]
      >,
      liveBaseTools = baseTools,
    ) {
      const thread = (await repos.threads.findById(thread0.id)) as Thread;
      const withThreadId = turns.map((turn) => ({ ...turn, threadId: thread.id }));
      const withThreadIdBlocks = blocks;
      return assembleNextTurnContext({
        thread,
        turns: withThreadId,
        blocks: withThreadIdBlocks,
        skillBodiesByTurn,
        agentRevisions,
        toolRegistry,
        gateway,
        baseTools: liveBaseTools,
        persistBake: true,
        bakeComposedSystemPrompt: repos.threads.bakeComposedSystemPrompt.bind(repos.threads),
        workContext,
      });
    }

    // 0. Base request: one writer turn.
    const t1 = userTurn("turn-1", "Hello, let's begin chapter 4.");
    const r0 = await assemble([t1.turn], [t1.block]);

    // 1. Steer: an adopted message folds into the same pending trailing message.
    const steer = userTurn("turn-2", "Also keep the pacing tight.");
    const r1 = await assemble([t1.turn, steer.turn], [t1.block, steer.block]);
    assertIsStableExtension(r0.generateRequest, r1.generateRequest);
    expect(r1.generateRequest.messages.length).toBe(r0.generateRequest.messages.length);

    // 2. Work-switch notice: also folds in, still no new message.
    const workSwitch = systemNoticeTurn("turn-3", "Work switched to Drafting.");
    const r2 = await assemble(
      [t1.turn, steer.turn, workSwitch.turn],
      [t1.block, steer.block, workSwitch.block],
    );
    assertIsStableExtension(r1.generateRequest, r2.generateRequest);
    expect(r2.generateRequest.messages.length).toBe(r0.generateRequest.messages.length);

    // 3. Background subagent completion notice: folds in the same way.
    const subagentDone = systemNoticeTurn(
      "turn-4",
      'Subagent p1 finished (success). Read its report with thread_report({"ref":"p1"}).',
    );
    const r3 = await assemble(
      [t1.turn, steer.turn, workSwitch.turn, subagentDone.turn],
      [t1.block, steer.block, workSwitch.block, subagentDone.block],
    );
    assertIsStableExtension(r2.generateRequest, r3.generateRequest);
    expect(r3.generateRequest.messages.length).toBe(r0.generateRequest.messages.length);

    // 4. Skill invocation: request-only body inlined onto the activating turn.
    const skillBodies = new Map([
      [
        "turn-1",
        [{ slug: "story-review", description: "Review drafts.", body: "story-review body." }],
      ],
    ]);
    const r4 = await assemble(
      [t1.turn, steer.turn, workSwitch.turn, subagentDone.turn],
      [t1.block, steer.block, workSwitch.block, subagentDone.block],
      skillBodies,
    );
    assertIsStableExtension(r3.generateRequest, r4.generateRequest);
    expect(r4.generateRequest.messages.length).toBe(r0.generateRequest.messages.length);

    // 5. Tool call/result: a genuine append. The merged user message freezes.
    const toolExchange = assistantToolExchangeTurn("turn-5", "call_1");
    const r5 = await assemble(
      [t1.turn, steer.turn, workSwitch.turn, subagentDone.turn, toolExchange.turn],
      [t1.block, steer.block, workSwitch.block, subagentDone.block, ...toolExchange.blocks],
      skillBodies,
    );
    assertIsStableExtension(r4.generateRequest, r5.generateRequest);
    expect(r5.generateRequest.messages.length).toBe(r0.generateRequest.messages.length + 2);

    // 6. A fresh writer turn appends again. Everything up through the tool_use
    // message is untouched — proving the step-5 freeze holds for history, not
    // just the immediately-prior request — and only the tool_result message
    // (final at step 5) may lose its cache mark now that it is no longer final.
    const nextTurn = userTurn("turn-6", "Continue into the next scene.");
    const r6 = await assemble(
      [t1.turn, steer.turn, workSwitch.turn, subagentDone.turn, toolExchange.turn, nextTurn.turn],
      [
        t1.block,
        steer.block,
        workSwitch.block,
        subagentDone.block,
        ...toolExchange.blocks,
        nextTurn.block,
      ],
      skillBodies,
    );
    assertIsStableExtension(r5.generateRequest, r6.generateRequest);
    expect(r6.generateRequest.messages.length).toBe(r5.generateRequest.messages.length + 1);

    // A code-side tool definition change (deploy editing an existing tool's
    // description/schema) must never reach an already-baked thread.
    const changedBaseTools = baseTools.map((tool) =>
      tool.name === "thread_message" ? { ...tool, description: "v2 tool description." } : tool,
    );
    const r7 = await assemble(
      [t1.turn, steer.turn, workSwitch.turn, subagentDone.turn, toolExchange.turn, nextTurn.turn],
      [
        t1.block,
        steer.block,
        workSwitch.block,
        subagentDone.block,
        ...toolExchange.blocks,
        nextTurn.block,
      ],
      skillBodies,
      changedBaseTools,
    );
    expect(r7.generateRequest.tools).toEqual(r0.generateRequest.tools);

    // The frozen system message carries the same cache mark on every request.
    for (const request of [r0, r1, r2, r3, r4, r5, r6].map((r) => r.generateRequest)) {
      const system = request.messages[0];
      expect(system.role).toBe("system");
      const lastPart = system.content.at(-1);
      expect(
        lastPart && "providerOptions" in lastPart ? lastPart.providerOptions : undefined,
      ).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    }
  });

  it("never marks tools or messages when the model lacks the caching capability", async () => {
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "user-1", title: "Serial" });
    const repos = createInMemoryRepositories({ projects });
    const agentRevisions = createInMemoryAgentRevisionStore({
      threadExists: async (id) => Boolean(await repos.threads.findById(id)),
    });
    const thread0 = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      title: "No caching",
    });
    await agentRevisions.bindThread(
      thread0.id,
      null,
      { model: "no-caching-model", skills: { load: [], available: [] }, namedTargets: [] },
      null,
    );
    const thread = (await repos.threads.findById(thread0.id)) as Thread;
    const t1 = userTurn("turn-1", "Hello.");
    const assembled = await assembleNextTurnContext({
      thread,
      turns: [{ ...t1.turn, threadId: thread.id }],
      blocks: [t1.block],
      agentRevisions,
      toolRegistry: createToolRegistry(),
      gateway: {
        getDefaultModel: () => "no-caching-model",
        listModels: () => [
          {
            id: "no-caching-model",
            provider: "test",
            displayName: "No caching",
            contextWindow: 1000,
            maxOutputTokens: 100,
            capabilities: new Set(),
          },
        ],
      },
      persistBake: true,
      bakeComposedSystemPrompt: repos.threads.bakeComposedSystemPrompt.bind(repos.threads),
      workContext: noWorkContext(project.id),
    });
    for (const message of assembled.generateRequest.messages) {
      for (const part of message.content) {
        expect(
          "providerOptions" in part ? part.providerOptions?.anthropic : undefined,
        ).toBeUndefined();
      }
    }
  });
});

/** The summarizer's provider-neutral request and paid-attempt contracts. */
import type { Block, Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import type {
  Gateway,
  GenerateRequest,
  GenerateResult,
  ModelInfo,
  StreamEvent,
} from "../gateway/index.js";
import { createTestAgentBinding } from "../loop/__tests__/runtime-fixtures.js";
import { estimateRequestTokens } from "../loop/compaction/index.js";
import { createInMemoryModelRequestDebugStore } from "../model-request-debug/index.js";
import { createToolRegistry } from "../tools/index.js";
import { createConversationSummarizer } from "./conversation-summarizer.js";

const threadModel: ModelInfo = {
  id: "writer-model",
  provider: "writer-provider",
  tokenizer: "anthropic",
  displayName: "Writer",
  contextWindow: 10000,
  maxOutputTokens: 1000,
  promptCache: { kind: "explicit", ttlMs: 3600000 },
  capabilities: new Set(),
};
const cheapModel = {
  ...threadModel,
  id: "cheap-model",
  provider: "cheap-provider",
  tokenizer: "deepseek" as const,
  contextWindow: 3400,
  maxOutputTokens: 300,
};
function reply(text = "Kept facts", changes: Partial<GenerateResult> = {}): GenerateResult {
  return {
    content: [{ type: "text", text }],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 },
    model: cheapModel.id,
    provider: cheapModel.provider,
    ...changes,
  };
}
function projection(texts: string[]) {
  return {
    turns: texts.map(
      (_, i) => ({ id: `t${i}`, role: "user", origin: "writer", position: i }) as Turn,
    ),
    blocks: texts.map(
      (text, i) =>
        ({ turnId: `t${i}`, blockType: "text", sequence: 0, textContent: text }) as Block,
    ),
  };
}

function onlyText(request: GenerateRequest, messageIndex: number, partIndex = 0): string {
  const part = request.messages[messageIndex]?.content[partIndex];
  if (part?.type !== "text") throw new Error("Expected prompt text");
  return part.text;
}
function setup(
  options: {
    warm?: boolean;
    models?: ModelInfo[];
    events?: (request: GenerateRequest, call: number) => AsyncIterable<StreamEvent>;
  } = {},
) {
  const requests: GenerateRequest[] = [];
  const gateway: Gateway = {
    getDefaultModel: () => threadModel.id,
    listModels: () => options.models ?? [threadModel, cheapModel],
    async *stream(request) {
      requests.push(request);
      if (options.events) yield* options.events(request, requests.length);
      else yield { type: "end", result: reply() };
    },
    async generate() {
      throw new Error("Use stream");
    },
  };
  const prefixCacheStateFor = vi.fn(async () =>
    options.warm
      ? { state: "warm" as const, reason: "reusable_prefix" as const }
      : { state: "cold" as const, reason: "ttl_expired" as const },
  );
  const modelRequestDebug = createInMemoryModelRequestDebugStore();
  const eventSink = createInMemoryEventSink();
  const service = createConversationSummarizer({
    gateway,
    eventSink,
    prefixCacheStateFor,
    agentRevisions: createTestAgentBinding(threadModel.id, "", () => ["thread"]),
    modelRequestDebug,
    toolRegistry: createToolRegistry(),
    config: { model: cheapModel.id },
  });
  const input: Parameters<typeof service.summarize>[0] = {
    owner: { threadId: "thread", turnId: "summary" },
    source: { threadId: "thread" },
    instruction: "compaction",
    requestInHand: {
      model: threadModel.id,
      messages: [{ role: "user", content: [{ type: "text", text: "Task" }] }],
    },
    projection: projection(["Facts"]),
    signal: new AbortController().signal,
  };
  return { service, input, requests, prefixCacheStateFor, modelRequestDebug, eventSink };
}

describe("conversation summarizer", () => {
  it.each([
    ["max_tokens", reply("partial", { finishReason: "max_tokens" })],
    ["provider_error", reply("", { finishReason: "error" })],
    ["tool_use", reply("", { toolCalls: [{ id: "call", name: "read", arguments: {} }] })],
    ["empty_text", reply("   ")],
  ] as const)("labels rejected summary output as %s", async (reason, result) => {
    const rig = setup({
      async *events() {
        yield { type: "end", result };
      },
    });
    expect(await rig.service.summarize(rig.input)).toMatchObject({
      kind: "failed",
      rejectionReason: reason,
    });
  });

  it("sends the serialized request in hand unchanged plus one instruction", async () => {
    const rig = setup({ warm: true });
    rig.input.requestInHand = {
      model: threadModel.id,
      messages: [
        { role: "system", content: [{ type: "text", text: "Frozen", cacheBreakpoint: true }] },
        { role: "user", content: [{ type: "text", text: "Task", cacheBreakpoint: true }] },
      ],
      tools: [{ type: "function", name: "read", description: "Read", inputSchema: {} }],
      toolChoice: "required",
      reasoning: "disabled",
      promptCacheKey: "owner",
      maxTokens: 500,
      providerOptions: { anthropic: { thinking: { type: "disabled" } } },
    };
    rig.input.retainedMessages = [
      { role: "user", content: [{ type: "text", text: "Task", cacheBreakpoint: true }] },
    ];
    const before = JSON.stringify(rig.input.requestInHand);
    const result = await rig.service.summarize(rig.input);
    const { signal: _signal, correlation: _correlation, ...sent } = rig.requests[0];
    expect(sent.maxTokens).toBe(500);
    expect(sent.messages.at(-1)?.content).toMatchObject([
      { type: "text", text: expect.stringContaining('user: "Task"') },
    ]);
    expect(JSON.stringify(sent.messages.at(-1))).toContain("Do not restate");
    expect(sent.messages.at(-1)?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^<system_update>\n[\s\S]*\n<\/system_update>$/),
    });
    expect(JSON.stringify(sent.messages.at(-1))).not.toContain(
      "immediately before this system update",
    );

    expect(sent).toMatchSnapshot("warm compaction request bytes");
    expect(onlyText(sent, sent.messages.length - 1)).toMatchSnapshot("compaction branch prompt");
    expect(JSON.stringify({ ...sent, maxTokens: 500, messages: sent.messages.slice(0, -1) })).toBe(
      before,
    );
    expect(JSON.stringify(rig.input.requestInHand)).toBe(before);
    expect(sent.messages.at(-1)?.content).toMatchObject([
      { type: "text", text: expect.stringContaining("Style directions") },
    ]);
    expect(result).toMatchObject({
      kind: "complete",
      summarizer: { path: "branch", segments: 1 },
      modelResponses: [
        {
          predictedCacheState: "warm",
          predictedCacheReason: "reusable_prefix",
          requestMessageCount: 3,
          cacheReadTokens: 80,
        },
      ],
    });
  });

  it("compacts a Sonnet 4.6 assistant turn with four 100 KB document results on a 128k summarizer", async () => {
    const sonnet = { ...threadModel, id: "claude-sonnet-4-6", contextWindow: 1_000_000 };
    const rig = setup({ models: [sonnet, { ...cheapModel, contextWindow: 128_000 }] });
    rig.input.requestInHand = { model: sonnet.id, messages: [] };
    rig.input.projection = projection(["Check continuity", ""]);
    rig.input.projection.turns[1].role = "assistant";
    rig.input.projection.blocks = [
      rig.input.projection.blocks[0],
      ...Array.from({ length: 4 }, (_, i): Block[] => [
        {
          id: `call-${i}`,
          responseId: null,
          createdAt: new Date(0).toISOString(),
          turnId: "t1",
          blockType: "tool_use",
          sequence: i * 2,
          content: {
            toolCallId: `read${i}`,
            toolName: "read",
            input: { path: `manuscript://chapter-${i}.md` },
          },
        },
        {
          id: `result-${i}`,
          responseId: null,
          createdAt: new Date(0).toISOString(),
          turnId: "t1",
          blockType: "tool_result",
          sequence: i * 2 + 1,
          content: {
            toolCallId: `read${i}`,
            output: {
              schema: "meridian.agent-edit.v1",
              command: "read",
              status: "success",
              phase: "committed",
              read: { format: "full" },
              blocks: [
                {
                  extent: "full",
                  relation: "document",
                  items: [{ hash: "abc", body: "jade ".repeat(20_000) }],
                },
              ],
            },
          },
        },
      ]).flat(),
    ];
    expect(await rig.service.summarize(rig.input)).toMatchObject({ kind: "complete" });
    for (let i = 0; i < 4; i++)
      expect(JSON.stringify(rig.requests)).toContain(`manuscript://chapter-${i}.md`);
    expect(JSON.stringify(rig.requests).length).toBeLessThan(20_000);
  });

  it("preflights block splits with room for a CJK running summary", async () => {
    const rig = setup({
      models: [threadModel, { ...cheapModel, contextWindow: 2400 }],
      async *events() {
        yield { type: "end", result: reply("漢".repeat(100)) };
      },
    });
    rig.input.projection = projection(["start ".repeat(225), "facts ".repeat(250)]);
    rig.input.projection.blocks.push(
      ...rig.input.projection.blocks.map((block) => ({ ...block, sequence: 1 })),
    );
    expect(await rig.service.summarize(rig.input)).toMatchObject({ kind: "complete" });
    expect(rig.requests.length).toBeGreaterThan(1);
  });

  it("does not take the cold fallback after Stop during the warm call", async () => {
    const controller = new AbortController();
    const rig = setup({
      warm: true,
      async *events() {
        yield { type: "usage", usage: { inputTokens: 42, outputTokens: 3 } };
        controller.abort();
      },
    });
    rig.input.signal = controller.signal;
    const outcome = await rig.service.summarize(rig.input);
    expect(outcome.kind).toBe("cancelled");
    expect(outcome.modelResponses).toHaveLength(1);
    expect(rig.requests).toHaveLength(1);
  });

  it("segments only at turns and carries the running summary into each bounded request", async () => {
    const rig = setup({
      models: [threadModel, { ...cheapModel, contextWindow: 2_400 }],
      async *events(_request, call) {
        yield { type: "end", result: reply(`Summary ${call}`) };
      },
    });
    rig.input.projection = projection([
      "FIRST ".repeat(450),
      "SECOND ".repeat(400),
      "THIRD ".repeat(450),
    ]);
    const outcome = await rig.service.summarize(rig.input);
    expect(outcome).toMatchObject({
      kind: "complete",
      text: "Summary 3",
      summarizer: { path: "rolling", segments: 3 },
    });
    expect(outcome.modelResponses).toHaveLength(3);
    rig.requests.forEach((request, index) => {
      expect(
        estimateRequestTokens({ request, baseline: null, tokenizer: cheapModel.tokenizer }),
      ).toBeLessThan(cheapModel.contextWindow - cheapModel.maxOutputTokens);
      if (index)
        expect(JSON.stringify(request)).toContain(
          `Prior context (running summary):\\nSummary ${index}`,
        );
    });
  });

  it("preflights every turn before any paid segment", async () => {
    const rig = setup();
    rig.input.projection = projection(["Small turn", "huge ".repeat(5000)]);
    const outcome = await rig.service.summarize(rig.input);
    expect(outcome.kind).toBe("failed");
    expect(outcome.modelResponses).toHaveLength(0);
  });

  it("a provider timeout is failed, not cancelled, and usage survives", async () => {
    const rig = setup({
      async *events() {
        yield { type: "usage", usage: { inputTokens: 42, outputTokens: 3 } };
        throw new DOMException("Timed out", "TimeoutError");
      },
    });
    expect(await rig.service.summarize(rig.input)).toMatchObject({
      kind: "failed",
      modelResponses: [{ inputTokens: 42, outputTokens: 3 }],
    });
  });
});

it("C7b warm brief preserves the source request and tools, correlating rows to the owner", async () => {
  const rig = setup({ warm: true });
  const requestInHand = rig.input.requestInHand;
  if (!requestInHand) throw new Error("Expected a source request");
  const sourceRequest = {
    ...requestInHand,
    tools: [
      {
        type: "function" as const,
        name: "read",
        description: "Read",
        inputSchema: { type: "object" },
      },
    ],
  };
  const outcome = await rig.service.summarize({
    ...rig.input,
    owner: { threadId: "destination", turnId: "seed" },
    source: { threadId: "thread", throughTurnId: "cutoff" },
    instruction: "handoff",
    incomingAgentName: "Editor",
    changedDocuments: ["manuscript://chapter-12.md"],
    requestInHand: sourceRequest,
  });
  const request = rig.requests[0];
  expect(request.messages.slice(0, -1)).toEqual(sourceRequest.messages);
  expect(request.tools).toEqual(sourceRequest.tools);
  expect(request.messages).toHaveLength(sourceRequest.messages.length + 1);
  expect(JSON.stringify(request.messages.at(-1))).toContain("Editor");
  expect(JSON.stringify(request.messages.at(-1))).toContain(
    "The user message immediately before this system update is unanswered and is the open request to report; do not answer it.",
  );
  expect(JSON.stringify(request.messages.at(-1))).toContain("<system_update>\\n");
  expect(JSON.stringify(request.messages.at(-1))).toContain("\\n</system_update>");
  expect(request.messages.slice(0, -1)).toEqual(sourceRequest.messages);
  expect(JSON.stringify(request.messages.slice(0, -1))).toBe(
    JSON.stringify(sourceRequest.messages),
  );
  expect(JSON.stringify(request.messages.at(-1))).not.toContain("thread_history");
  expect(onlyText(request, request.messages.length - 1)).toMatchSnapshot(
    "handoff writer-row cutoff prompt with changed documents",
  );
  expect(request.correlation).toMatchObject({
    threadId: "destination",
    turnId: "seed",
    gatewayCallId: expect.any(String),
    iteration: 0,
  });
  expect(outcome.modelResponses[0].turnId).toBe("seed");
  expect(rig.prefixCacheStateFor).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: "thread", throughTurnId: "cutoff" }),
  );
});

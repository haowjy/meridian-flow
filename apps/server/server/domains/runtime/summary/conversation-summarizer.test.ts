/** The summarizer's provider-neutral request and paid-attempt contracts. */
import type { Block, Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
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
import { describeTurn } from "../spawn/history-item.js";
import { renderHistoryResult } from "../spawn/history-result.js";
import { listReadableThreads } from "../spawn/thread-ls.js";
import { createToolRegistry } from "../tools/index.js";
import { createInspectionToolRegistrations } from "../tools/inspection-tools.js";
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
  it("calls the human user in compaction, handoff, history, and listing model text", async () => {
    const compaction = setup();
    await compaction.service.summarize(compaction.input);

    const handoff = setup();
    handoff.input.instruction = "handoff";
    handoff.input.incomingAgentName = "Editor";
    await handoff.service.summarize(handoff.input);

    const turn = {
      id: "turn",
      role: "user",
      origin: "writer",
      status: "complete",
      position: 18,
      createdAt: "2026-01-02T03:04:05.000Z",
    } as Turn;
    const history = renderHistoryResult({
      ref: "c1",
      view: "page",
      turns: [
        {
          number: 18,
          ...describeTurn(turn),
          items: [{ kind: "message", text: "Continue the chapter.", tokens: 5 }],
          hiddenCount: 0,
        },
      ],
      inProgress: [],
    });

    const repos = createInMemoryRepositories();
    const listed = await repos.threads.create({ userId: "user", projectId: "project" });
    const listedTurn = await repos.turns.create({
      threadId: listed.id,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    await repos.blocks.create({
      turnId: listedTurn.id,
      blockType: "text",
      sequence: 0,
      textContent: "Continue the chapter.",
    });
    const listing = await listReadableThreads({
      repos,
      statusReader: { readMany: async () => new Map() },
      caller: listed,
      input: {},
    });
    const listingDescription = createInspectionToolRegistrations({
      repos,
      statusReader: {} as never,
      registry: createToolRegistry(),
      tokenizer: async () => "anthropic",
    }).find(({ definition }) => definition.name === "thread_ls")?.definition.description;

    const modelText = [
      onlyText(compaction.requests[0], compaction.requests[0].messages.length - 1),
      onlyText(handoff.requests[0], handoff.requests[0].messages.length - 1),
      history,
      "listing" in listing ? listing.listing : "",
      listingDescription ?? "",
    ].join("\n");
    expect(modelText).not.toMatch(/writer/i);
    expect(history).toContain("[18] user");
  });

  it.each([
    false,
    true,
  ])("includes writer summary instructions on the %s cache path", async (warm) => {
    const rig = setup({ warm });
    rig.input.writerInstructions = "Prioritize unresolved cultivation debts.";

    expect(await rig.service.summarize(rig.input)).toMatchObject({ kind: "complete" });
    expect(JSON.stringify(rig.requests)).toContain("Prioritize unresolved cultivation debts.");
    const [capture] = rig.modelRequestDebug.listByThread("thread");
    expect(JSON.stringify(capture?.request)).toContain("Prioritize unresolved cultivation debts.");
    expect(rig.requests[0].correlation?.gatewayCallId).toBe(capture?.gatewayCallId);
  });

  it("reports debug capture failures without failing the summary", async () => {
    const rig = setup();
    rig.modelRequestDebug.capture = () => {
      throw new Error("debug store unavailable");
    };

    await expect(rig.service.summarize(rig.input)).resolves.toMatchObject({ kind: "complete" });
    expect(rig.eventSink.events).toContainEqual(
      expect.objectContaining({ name: "model_request_debug.capture_failed" }),
    );
  });

  it("leaves the rolling request output limit to the adapter", async () => {
    const rig = setup();

    await expect(rig.service.summarize(rig.input)).resolves.toMatchObject({
      kind: "complete",
      summarizer: { path: "rolling" },
    });
    expect(rig.requests[0]).not.toHaveProperty("maxTokens");
  });

  it.each([
    "established facts ".repeat(65),
    "故事".repeat(60),
  ])("accepts complete output without treating conservative input estimates as provider tokens", async (text) => {
    const rig = setup({
      async *events() {
        yield {
          type: "end",
          result: reply(text, { usage: { inputTokens: 100, outputTokens: 280 } }),
        };
      },
    });
    expect(await rig.service.summarize(rig.input)).toMatchObject({
      kind: "complete",
      text: text.trim(),
    });
  });

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

  it("labels prior context and omits opaque reasoning from the cold transcript", async () => {
    const rig = setup();
    rig.input.projection.turns[0].metadata = {
      kind: "system_update",
      section: "compaction_summary",
    };
    rig.input.projection.blocks.push({
      id: "reasoning",
      responseId: null,
      createdAt: new Date(0).toISOString(),
      turnId: "t0",
      blockType: "reasoning",
      sequence: 1,
      content: { signature: "opaque".repeat(10000) },
    });
    expect(await rig.service.summarize(rig.input)).toMatchObject({ kind: "complete" });
    expect(JSON.stringify(rig.requests)).not.toContain("opaque");
    expect(JSON.stringify(rig.requests)).toContain("Prior context (previous conversation summary)");
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

  it("pins the rolling compaction prompt", async () => {
    const rig = setup();

    await rig.service.summarize(rig.input);

    expect(onlyText(rig.requests[0], 0)).toMatchSnapshot("compaction rolling prompt");
  });

  it.each([
    ["overflow", "request_too_large"],
    ["timeout", "provider_error"],
    ["empty", "empty_text"],
  ] as const)("fails a warm %s branch once and keeps its paid row", async (failure, reason) => {
    const rig = setup({
      warm: true,
      async *events(_request, call) {
        if (call === 1) {
          yield { type: "usage", usage: { inputTokens: 42, outputTokens: 0 } };
          if (failure === "overflow") {
            yield {
              type: "error",
              code: "context_overflow",
              message: "input length and max_tokens exceed context limit",
              retryable: false,
            };
            return;
          }
          if (failure === "timeout") throw new Error("Timeout");
          yield { type: "end", result: reply("") };
        } else yield { type: "end", result: reply() };
      },
    });
    const outcome = await rig.service.summarize(rig.input);
    expect(outcome).toMatchObject({
      kind: "failed",
      rejectionReason: reason,
      summarizer: { path: "branch", segments: 1 },
    });
    expect(outcome.modelResponses).toHaveLength(1);
    expect(rig.requests).toHaveLength(1);
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

  it("splits oversized turns at block boundaries when they have no reducible results", async () => {
    const rig = setup();
    rig.input.projection = projection([""]);
    rig.input.projection.blocks = Array.from(
      { length: 4 },
      (_, i) =>
        ({
          turnId: "t0",
          blockType: "text",
          sequence: i,
          textContent: `block${i} `.repeat(300),
        }) as Block,
    );
    expect(await rig.service.summarize(rig.input)).toMatchObject({ kind: "complete" });
    expect(rig.requests.length).toBeGreaterThan(1);
    for (let i = 0; i < 4; i++) expect(JSON.stringify(rig.requests)).toContain(`block${i}`);
  });

  it("splits a large system update at its source block boundaries", async () => {
    const rig = setup({ models: [threadModel, { ...cheapModel, contextWindow: 2_800 }] });
    rig.input.projection = projection(["system ".repeat(400)]);
    rig.input.projection.turns[0].role = "system";
    rig.input.projection.blocks.push({ ...rig.input.projection.blocks[0], sequence: 1 });
    expect(await rig.service.summarize(rig.input)).toMatchObject({ kind: "complete" });
    expect(rig.requests).toHaveLength(2);
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

  it("does not expose custom card internals or thinking blocks", async () => {
    const rig = setup();
    rig.input.projection.blocks.push(
      ...["custom", "thinking"].map(
        (blockType, sequence) =>
          ({
            id: blockType,
            responseId: null,
            createdAt: new Date(0).toISOString(),
            turnId: "t0",
            blockType,
            sequence: sequence + 1,
            content: { kind: "helper-result", props: { threadId: "secret-internal-id" } },
            textContent: "private-thinking",
          }) as Block,
      ),
    );
    expect(await rig.service.summarize(rig.input)).toMatchObject({ kind: "complete" });
    expect(JSON.stringify(rig.requests)).not.toContain("secret-internal-id");
    expect(JSON.stringify(rig.requests)).not.toContain("private-thinking");
  });

  it.each([
    [undefined, undefined],
    [200, undefined],
    [5000, { type: "enabled", budget_tokens: 1024 }],
    [1000, { type: "enabled", budget_tokens: 900 }],
  ] as const)("keeps the branch request output limit (%s, %s)", async (maxTokens, thinking) => {
    const rig = setup({ warm: true });
    const request: GenerateRequest = {
      model: threadModel.id,
      messages: [],
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(thinking ? { providerOptions: { anthropic: { thinking } } } : {}),
    };
    rig.input.requestInHand = request;
    await rig.service.summarize(rig.input);
    const { signal: _signal, correlation: _correlation, ...sent } = rig.requests[0];
    expect(sent).toEqual({ ...request, messages: sent.messages });
    expect(sent.messages).toHaveLength(1);
    const prompt = JSON.stringify(sent.messages);
    for (const phrase of [
      "<system_update>",
      "</system_update>",
      "edits already made",
      "edits still pending",
      "cultivation realms",
      "quoted wording exactly",
      "Add no fact",
    ])
      expect(prompt).toContain(phrase);
  });

  it("fails once when a warm branch throws", async () => {
    const rig = setup({
      warm: true,
      async *events() {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
        throw new Error("Unavailable");
      },
    });
    const outcome = await rig.service.summarize(rig.input);
    expect(outcome.kind).toBe("failed");
    expect(outcome.modelResponses).toHaveLength(1);
    expect(rig.requests).toHaveLength(1);
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

  it("fails on warm tool use without making a rolling call", async () => {
    const rig = setup({
      warm: true,
      async *events(_request, call) {
        yield {
          type: "end",
          result:
            call === 1
              ? reply("", {
                  content: [{ type: "tool_use", toolCallId: "x", toolName: "read", input: {} }],
                })
              : reply(),
        };
      },
    });
    const outcome = await rig.service.summarize(rig.input);
    expect(outcome).toMatchObject({
      kind: "failed",
      rejectionReason: "tool_use",
      summarizer: { path: "branch", segments: 1 },
    });
    expect(outcome.modelResponses).toHaveLength(1);
    expect(rig.requests.map((r) => r.model)).toEqual([threadModel.id]);
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

  it("fails rather than truncating one oversized turn", async () => {
    const rig = setup();
    rig.input.projection = projection(["huge ".repeat(5000)]);
    const outcome = await rig.service.summarize(rig.input);
    expect(outcome).toMatchObject({ kind: "failed", modelResponses: [] });
    expect(rig.requests).toHaveLength(0);
  });

  it("preflights every turn before any paid segment", async () => {
    const rig = setup();
    rig.input.projection = projection(["Small turn", "huge ".repeat(5000)]);
    const outcome = await rig.service.summarize(rig.input);
    expect(outcome.kind).toBe("failed");
    expect(outcome.modelResponses).toHaveLength(0);
  });

  it("falls back to the thread model when the configured provider is disabled, including idle callers", async () => {
    const rig = setup({ models: [threadModel] });
    rig.input.requestInHand = null;
    rig.input.instruction = "handoff";
    expect((await rig.service.summarize(rig.input)).kind).toBe("complete");
    expect(rig.requests[0].model).toBe(threadModel.id);
    expect(JSON.stringify(rig.requests[0])).toContain("handoff brief");
  });

  it("uses rolling when the request is known too large and renders images as URI", async () => {
    const rig = setup({ warm: true });
    rig.input.knownTooLarge = true;
    rig.input.projection = projection([
      "Conversation summary. Earlier turns were compacted. Established story facts.",
    ]);
    rig.input.projection.blocks.push({
      id: "image",
      responseId: null,
      createdAt: new Date().toISOString(),
      turnId: "t0",
      blockType: "image",
      sequence: 1,
      content: { type: "image", uri: "upload://map.png", data: "BASE64" },
    } as Block);
    await rig.service.summarize(rig.input);
    expect(rig.requests[0].model).toBe(cheapModel.id);
    expect(JSON.stringify(rig.requests[0])).toContain("upload://map.png");
    expect(JSON.stringify(rig.requests[0])).not.toContain("BASE64");
    expect(JSON.stringify(rig.requests[0])).toContain("Earlier turns were compacted");
  });

  it.each([
    "max_tokens",
    "error",
  ] as const)("fails a %s summary and returns the paid row", async (finishReason) => {
    const rig = setup({
      async *events() {
        yield { type: "end", result: reply("partial", { finishReason }) };
      },
    });
    expect(await rig.service.summarize(rig.input)).toMatchObject({
      kind: "failed",
      modelResponses: [{ outputTokens: 20, finishReason }],
    });
  });

  it("does not retry a cold tool-use reply", async () => {
    const rig = setup({
      async *events() {
        yield {
          type: "end",
          result: reply("", { toolCalls: [{ id: "x", name: "read", arguments: {} }] }),
        };
      },
    });
    expect((await rig.service.summarize(rig.input)).kind).toBe("failed");
    expect(rig.requests).toHaveLength(1);
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

  it("returns a too-large rejection from the provider event", async () => {
    const rig = setup({
      warm: true,
      async *events() {
        yield {
          type: "error",
          code: "context_overflow",
          message: "Too many tokens",
          retryable: false,
        };
      },
    });
    expect(await rig.service.summarize(rig.input)).toMatchObject({
      kind: "failed",
      rejectionReason: "request_too_large",
      modelResponses: [{ finishReason: "error" }],
    });
    expect(rig.requests).toHaveLength(1);
  });

  it("maps a thrown gateway context overflow to too large", async () => {
    const rig = setup({
      warm: true,
      async *events() {
        yield { type: "start", model: threadModel.id, provider: threadModel.provider };
        throw Object.assign(new Error("Too many tokens"), { code: "context_overflow" });
      },
    });
    expect(await rig.service.summarize(rig.input)).toMatchObject({
      kind: "failed",
      rejectionReason: "request_too_large",
      modelResponses: [{ finishReason: "error" }],
    });
    expect(rig.requests).toHaveLength(1);
  });
});

it.each([
  true,
  false,
])("appends changed-document guidance on warm=%s without rewriting the prefix", async (warm) => {
  const rig = setup({ warm });
  const before = JSON.stringify(rig.input.requestInHand);
  rig.input.changedDocuments = ["manuscript://chapter-12.md"];
  expect((await rig.service.summarize(rig.input)).kind).toBe("complete");
  const sent = rig.requests[0];
  expect(JSON.stringify(sent.messages)).toContain(
    "These documents changed after they were read; name them, do not restate their earlier text.",
  );
  expect(JSON.stringify(sent.messages)).toContain("manuscript://chapter-12.md");
  expect(JSON.stringify(sent.messages)).not.toContain("thread_history");
  expect(JSON.stringify(rig.input.requestInHand)).toBe(before);
  if (warm) expect(sent.messages.slice(0, -1)).toEqual(rig.input.requestInHand?.messages);
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

it("keeps the existing conditional open-request guidance for an assistant-row handoff cutoff", async () => {
  const rig = setup({ warm: true });
  rig.input.instruction = "handoff";
  rig.input.incomingAgentName = "Editor";
  rig.input.projection.turns[0].role = "assistant";
  const requestInHand = rig.input.requestInHand;
  if (!requestInHand) throw new Error("Expected a source request");
  requestInHand.messages.push({ role: "assistant", content: [{ type: "text", text: "Answer" }] });

  await rig.service.summarize(rig.input);

  const appended = rig.requests[0].messages.at(-1);
  const text = appended?.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  expect(text).toContain(
    "If the conversation ends with a user message you have not answered, report it as the open request; do not answer it.",
  );
  expect(text).not.toContain("immediately before this system update");
  expect(rig.requests[0].messages.slice(0, -1)).toEqual(requestInHand.messages);
  expect(onlyText(rig.requests[0], rig.requests[0].messages.length - 1)).toMatchSnapshot(
    "handoff otherwise prompt",
  );
});

it("does not call a system-origin user row the writer's open request", async () => {
  const rig = setup({ warm: true });
  rig.input.instruction = "handoff";
  rig.input.projection.turns[0].origin = "system";

  await rig.service.summarize(rig.input);

  const text = JSON.stringify(rig.requests[0].messages.at(-1));
  expect(text).toContain(
    "If the conversation ends with a user message you have not answered, report it as the open request; do not answer it.",
  );
  expect(text).not.toContain("immediately before this system update");
});

it("uses rolling at a cold cutoff", async () => {
  const rig = setup({ warm: false });
  const tools = [
    {
      type: "function" as const,
      name: "read",
      description: "Read a source document",
      inputSchema: { type: "object", properties: { uri: { type: "string" } } },
    },
  ];
  const requestInHand = rig.input.requestInHand;
  if (!requestInHand) throw new Error("Expected a source request");
  const sourceRequest = {
    ...requestInHand,
    tools,
    reasoning: { effort: "high" as const },
  };
  const outcome = await rig.service.summarize({
    ...rig.input,
    instruction: "handoff",
    requestInHand: sourceRequest,
  });

  expect(outcome).toMatchObject({ kind: "complete", summarizer: { path: "rolling" } });
  expect(rig.requests.length).toBeGreaterThan(0);
  expect(rig.requests[0].model).toBe(cheapModel.id);
  expect(rig.prefixCacheStateFor).toHaveBeenCalled();
});

it("C7b a cold transcript needs no source model when the cheap model is enabled", async () => {
  const rig = setup({ models: [cheapModel] });
  const outcome = await rig.service.summarize({
    ...rig.input,
    instruction: "handoff",
    incomingAgentName: "Editor",
    requestInHand: null,
  });
  expect(outcome.kind).toBe("complete");
  expect(rig.requests[0].model).toBe(cheapModel.id);
  expect(rig.prefixCacheStateFor).not.toHaveBeenCalled();
});

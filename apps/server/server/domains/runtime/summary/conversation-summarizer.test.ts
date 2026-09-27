/** The summarizer's provider-neutral request and paid-attempt contracts. */
import type { Block, Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import type {
  Gateway,
  GenerateRequest,
  GenerateResult,
  ModelInfo,
  StreamEvent,
} from "../gateway/index.js";
import { createTestAgentBinding } from "../loop/__tests__/runtime-fixtures.js";
import { estimateRequestTokens } from "../loop/compaction/index.js";
import { createConversationSummarizer } from "./conversation-summarizer.js";

const threadModel: ModelInfo = {
  id: "writer-model",
  provider: "writer-provider",
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
  contextWindow: 2400,
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
    turns: texts.map((_, i) => ({ id: `t${i}`, role: "user", position: i }) as Turn),
    blocks: texts.map(
      (text, i) =>
        ({ turnId: `t${i}`, blockType: "text", sequence: 0, textContent: text }) as Block,
    ),
  };
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
  const service = createConversationSummarizer({
    gateway,
    prefixCacheStateFor,
    agentRevisions: createTestAgentBinding(threadModel.id, "", () => ["thread"]),
    config: { model: cheapModel.id, maxOutputTokens: 300 },
  });
  const input: Parameters<typeof service.summarize>[0] = {
    threadId: "thread",
    turnId: "summary",
    instruction: "compaction",
    requestInHand: {
      model: threadModel.id,
      messages: [{ role: "user", content: [{ type: "text", text: "Task" }] }],
    },
    projection: projection(["Facts"]),
    signal: new AbortController().signal,
  };
  return { service, input, requests, prefixCacheStateFor };
}

describe("conversation summarizer", () => {
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
      reasoning: { effort: "high" },
      promptCacheKey: "owner",
      maxTokens: 500,
      providerOptions: { anthropic: { thinking: { type: "enabled" } } },
    };
    const before = JSON.stringify(rig.input.requestInHand);
    const result = await rig.service.summarize(rig.input);
    const { signal: _signal, correlation: _correlation, ...sent } = rig.requests[0];
    expect(JSON.stringify({ ...sent, messages: sent.messages.slice(0, -1) })).toBe(before);
    expect(JSON.stringify(rig.input.requestInHand)).toBe(before);
    expect(sent.messages.at(-1)?.content).toMatchObject([
      { type: "text", text: expect.stringContaining("style directions") },
    ]);
    expect(rig.prefixCacheStateFor).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "complete",
      summarizer: { path: "warm", segments: 1 },
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

  it("discards warm tool use and falls back to cold exactly once", async () => {
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
      kind: "complete",
      model: cheapModel.id,
      summarizer: { path: "cold", segments: 1 },
    });
    expect(outcome.modelResponses).toHaveLength(2);
    expect(rig.requests.map((r) => r.model)).toEqual([threadModel.id, cheapModel.id]);
    expect(rig.requests[1].tools).toBeUndefined();
  });

  it("segments only at turns and carries the running summary into each bounded request", async () => {
    const rig = setup({
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
      summarizer: { path: "cold", segments: 3 },
    });
    expect(outcome.modelResponses).toHaveLength(3);
    rig.requests.forEach((request, index) => {
      expect(estimateRequestTokens({ request, baseline: null })).toBeLessThan(
        cheapModel.contextWindow - 300,
      );
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

  it("retains a paid segment when the following turn cannot fit", async () => {
    const rig = setup();
    rig.input.projection = projection(["Small turn", "huge ".repeat(5000)]);
    const outcome = await rig.service.summarize(rig.input);
    expect(outcome.kind).toBe("failed");
    expect(outcome.modelResponses).toHaveLength(1);
  });

  it("falls back to the thread model when the configured provider is disabled, including idle callers", async () => {
    const rig = setup({ models: [threadModel] });
    rig.input.requestInHand = null;
    rig.input.instruction = "handoff_brief";
    expect((await rig.service.summarize(rig.input)).kind).toBe("complete");
    expect(rig.requests[0].model).toBe(threadModel.id);
    expect(JSON.stringify(rig.requests[0])).toContain("handoff brief");
  });

  it("forces cold despite warm state and renders images as URI and prior summaries as context", async () => {
    const rig = setup({ warm: true });
    rig.input.forceCold = true;
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
      content: { uri: "upload://map.png", data: "BASE64" },
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

  it("cancellation returns every attempted row including a discarded warm reply", async () => {
    const controller = new AbortController();
    const rig = setup({
      warm: true,
      async *events(_request, call) {
        if (call === 1)
          yield {
            type: "end",
            result: reply("", { toolCalls: [{ id: "x", name: "read", arguments: {} }] }),
          };
        else {
          yield { type: "usage", usage: { inputTokens: 42, outputTokens: 3 } };
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        }
      },
    });
    rig.input.signal = controller.signal;
    const result = await rig.service.summarize(rig.input);
    expect(result.kind).toBe("cancelled");
    expect(result.modelResponses).toHaveLength(2);
    expect(result.modelResponses[1]).toMatchObject({ inputTokens: 42, outputTokens: 3 });
  });
});

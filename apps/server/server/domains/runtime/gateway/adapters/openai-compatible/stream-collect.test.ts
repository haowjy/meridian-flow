/** Incomplete streamed calls cannot become executable or persisted history. */
import { describe, expect, it } from "vitest";
import { contentPartToBlockInput } from "../../../loop/streaming.js";
import { settleGenericCancelledResult } from "../../domain/cancel-settlement.js";
import { shouldPersistOpenRouterCancelledResult } from "../openrouter/cancel-settlement.js";
import {
  buildOpenRouterGenerateResult,
  createOpenRouterStreamAccumulator,
  eventsFromOpenRouterChunk,
} from "../openrouter/stream-collect.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromOpenAIChunk,
} from "./stream-collect.js";

function accumulator() {
  const acc = createStreamAccumulator("model", "compatible");
  [
    ...eventsFromOpenAIChunk(
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
      acc,
    ),
  ];
  return acc;
}

type ToolDelta = NonNullable<
  NonNullable<
    NonNullable<Parameters<typeof eventsFromOpenAIChunk>[0]["choices"]>[number]["delta"]
  >["tool_calls"]
>[number];

function tool(acc: ReturnType<typeof accumulator>, delta: ToolDelta) {
  return [...eventsFromOpenAIChunk({ choices: [{ delta: { tool_calls: [delta] } }] }, acc)];
}

describe("streamed tool identity finalization", () => {
  it.each([
    { index: 0, id: "call", function: { arguments: "{" } },
    { index: 0, function: { name: "read", arguments: "{}" } },
    { index: 0, id: "", function: { name: "read", arguments: "{}" } },
    { index: 0, id: "call", function: { name: " ", arguments: "{}" } },
  ])("drops an unexecutable fragment while retaining sibling calls, text and billing (%j)", (delta) => {
    const acc = accumulator();
    [...eventsFromOpenAIChunk({ choices: [{ delta: { content: "Kept text." } }] }, acc)];
    tool(acc, delta);
    tool(acc, {
      index: 1,
      id: "valid",
      function: { name: "read", arguments: '{"path":"chapter"}' },
    });
    const result = buildGenerateResult(acc);
    // Normal termination must fail explicitly, not complete an empty reply.
    expect(result.finishReason).toBe("error");
    expect(result.content).toEqual([
      { type: "text", text: "Kept text." },
      { type: "tool_use", toolCallId: "valid", toolName: "read", input: { path: "chapter" } },
    ]);
    expect(result.toolCalls).toEqual([
      { id: "valid", name: "read", arguments: { path: "chapter" } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
    const settled = settleGenericCancelledResult({ model: "model", result });
    expect(settled?.persist).toBe(true);
    const rows = settled?.result.content.map((part, index) =>
      contentPartToBlockInput(part, "turn", index, "response", "compatible"),
    );
    expect(rows?.map((row) => row?.blockType)).toEqual(["text", "tool_use"]);
    expect(rows?.[1]?.content).toMatchObject({ toolCallId: "valid" });
  });

  it("waits for late identity fields and still repairs malformed argument JSON", () => {
    const acc = accumulator();
    expect(tool(acc, { index: 0, function: { arguments: '{"in": 6c4a}' } })).toEqual([]);
    tool(acc, { index: 0, id: "late", function: { name: "read" } });
    [...eventsFromOpenAIChunk({ choices: [{ finish_reason: "tool_calls" }] }, acc)];
    const result = buildGenerateResult(acc);
    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "late", name: "read", arguments: { in: "6c4a" } }]);
    expect(result.content).toEqual([
      { type: "tool_use", toolCallId: "late", toolName: "read", input: { in: "6c4a" } },
    ]);
  });

  it("retains a complete identity with explicit argument parse failure for tool-error recovery", () => {
    const acc = accumulator();
    tool(acc, { index: 0, id: "call", function: { name: "read", arguments: "[]" } });
    const result = buildGenerateResult(acc);
    expect(result.content[0]).toMatchObject({
      type: "tool_use",
      toolCallId: "call",
      toolName: "read",
      input: {},
      inputParseError: { raw: "[]" },
    });
    expect(result.toolCalls[0]).toMatchObject({
      id: "call",
      arguments: {},
      argumentsParseError: { raw: "[]" },
    });
    expect(
      contentPartToBlockInput(result.content[0], "turn", 0, "response", "compatible")?.content,
    ).toEqual({ toolCallId: "call", toolName: "read", input: {} });
  });
});

describe("interrupted argument finalization", () => {
  it.each([
    "{",
    '{"path":"chapter',
    "",
    " ",
    "[]",
    "null",
  ])("discards an unfinished argument buffer without repairing it (%j)", (raw) => {
    const acc = accumulator();
    [...eventsFromOpenAIChunk({ choices: [{ delta: { content: "Kept text." } }] }, acc)];
    tool(acc, { index: 0, id: "partial", function: { name: "read", arguments: raw } });
    tool(acc, { index: 1, id: "complete", function: { name: "read", arguments: "{}" } });
    const result = buildGenerateResult(acc, "interrupted");
    expect(result.content).toEqual([
      { type: "text", text: "Kept text." },
      { type: "tool_use", toolCallId: "complete", toolName: "read", input: {} },
    ]);
    expect(result.toolCalls).toEqual([{ id: "complete", name: "read", arguments: {} }]);
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
    expect(settleGenericCancelledResult({ model: "model", result })?.persist).toBe(true);
  });

  it.each([
    { raw: '{"in": 6c4a}', input: { in: "6c4a" } },
    { raw: "", input: {} },
  ])("keeps normal argument repair once a terminal choice arrived (%j)", ({ raw, input }) => {
    const acc = accumulator();
    tool(acc, { index: 0, id: "complete", function: { name: "read", arguments: raw } });
    [...eventsFromOpenAIChunk({ choices: [{ finish_reason: "tool_calls" }] }, acc)];
    const result = buildGenerateResult(acc, "interrupted");
    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "complete", name: "read", arguments: input }]);
  });

  it("still repairs normal completions without a terminal marker", () => {
    const acc = accumulator();
    tool(acc, { index: 0, id: "complete", function: { name: "read", arguments: '{"in": 6c4a}' } });
    expect(buildGenerateResult(acc).toolCalls).toEqual([
      { id: "complete", name: "read", arguments: { in: "6c4a" } },
    ]);
  });

  it("keeps OpenRouter reconciliation and earlier completed responses outside partial filtering", () => {
    const earlier = accumulator();
    tool(earlier, { index: 0, id: "executed", function: { name: "read", arguments: "{}" } });
    const completed = buildGenerateResult(earlier);
    const before = structuredClone(completed);
    const acc = createOpenRouterStreamAccumulator("model", "openrouter");
    [
      ...eventsFromOpenRouterChunk(
        {
          id: "generation",
          choices: [
            {
              delta: {
                content: "Kept text.",
                tool_calls: [
                  { index: 0, id: "partial", function: { name: "read", arguments: "{" } },
                  { index: 1, id: "complete", function: { name: "read", arguments: "{}" } },
                ],
              },
            },
          ],
        },
        acc,
      ),
    ];
    const result = buildOpenRouterGenerateResult(acc, "interrupted");
    expect(result.content).toEqual([
      { type: "text", text: "Kept text." },
      { type: "tool_use", toolCallId: "complete", toolName: "read", input: {} },
    ]);
    expect(result.providerRequestId).toBe("generation");
    expect(result.providerData).toMatchObject({ generationId: "generation" });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(shouldPersistOpenRouterCancelledResult(result)).toBe(true);
    expect(completed).toEqual(before);
  });
});

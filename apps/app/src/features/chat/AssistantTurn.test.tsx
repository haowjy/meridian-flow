/**
 * AssistantTurn.test — behavioral contracts for assistant turn rendering.
 *
 * Guards protocol normalization (no raw tool placeholders), streaming buffer
 * caps, curated-vs-stream output preference, and reducer-driven partial status.
 */

import type { Block, JsonValue, Turn } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import { applyAguiEventToStore } from "@/core/session/reduce-turn-event";

import { AssistantTurn } from "./AssistantTurn";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => <>{children}</>,
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, ""),
  plural: (value: number, forms: { one: string; other: string }) =>
    (value === 1 ? forms.one : forms.other).replace("#", String(value)),
}));

describe("AssistantTurn segment rendering", () => {
  it("renders reasoning and the answer frontier as separate visible content", () => {
    const html = renderAssistantTurn([
      reasoningBlock(0, "Private reasoning stays folded"),
      textBlock(1, "Visible answer frontier"),
    ]);

    const text = visibleText(html);
    expect(text).toContain("Private reasoning stays folded");
    expect(text).toContain("Visible answer frontier");
    expect(html.indexOf("Private reasoning stays folded")).toBeLessThan(
      html.indexOf("Visible answer frontier"),
    );
  });

  it("keeps checkpoint frontiers visible between stacked segments", () => {
    const html = renderAssistantTurn([
      reasoningBlock(0, "Reasoning before checkpoint"),
      textBlock(1, "Context before checkpoint"),
      checkpointBlock(2, "Approve the plan?"),
      reasoningBlock(3, "Reasoning after checkpoint"),
      textBlock(4, "Continuation answer"),
    ]);

    const text = visibleText(html);
    expect(text).toContain("Reasoning before checkpoint");
    expect(text).toContain("Context before checkpoint");
    expect(text).toContain("Approve the plan?");
    expect(text).toContain("Reasoning after checkpoint");
    expect(text).toContain("Continuation answer");
    expect(html.indexOf("Approve the plan?")).toBeLessThan(html.indexOf("Continuation answer"));
  });

  it("renders a settled durable tool pair as one row without raw tool placeholders", () => {
    const html = renderAssistantTurn([
      toolUseBlock(0, {
        toolCallId: "t1",
        toolName: "read",
        input: { path: "README.md" },
      }),
      toolResultBlock(1, {
        toolCallId: "t1",
        output: { summary: "Read complete" },
      }),
    ]);

    expectToolRowWithoutProtocolLeak(html);
    expect(visibleText(html)).toContain("README.md");
  });

  it("renders a live merged complete tool block the same as a settled durable tool pair", () => {
    const liveHtml = renderAssistantTurn(
      [
        toolUseBlock(0, {
          toolCallId: "t1",
          toolName: "read",
          input: { path: "README.md" },
          output: { summary: "Read complete" },
        }),
      ],
      "streaming",
    );
    const settledHtml = renderAssistantTurn([
      toolUseBlock(0, {
        toolCallId: "t1",
        toolName: "read",
        input: { path: "README.md" },
      }),
      toolResultBlock(1, {
        toolCallId: "t1",
        output: { summary: "Read complete" },
      }),
    ]);

    expectToolRowWithoutProtocolLeak(liveHtml);
    expectToolRowWithoutProtocolLeak(settledHtml);
    expect(visibleText(liveHtml)).toContain("README.md");
    expect(visibleText(settledHtml)).toContain("README.md");
  });

  it("includes the streamed live output tail in the row fold while running", () => {
    const longBuffer = Array.from({ length: 20 }, (_, i) => `bash-line-${i}`).join("\n");
    const html = renderAssistantTurn(
      [
        toolUseBlock(
          0,
          {
            toolCallId: "t1",
            toolName: "bash",
            input: { command: "ls" },
            streamedOutput: longBuffer,
          },
          "partial",
        ),
      ],
      "streaming",
    );

    const text = visibleText(html);
    expect(text).toContain("bash-line-19");
    expect(text).toContain("bash-line-6");
    expect(text).not.toContain("bash-line-0");
    expect(text).not.toContain("bash-line-5");
    expect(text).toContain("ls");
  });

  it("shows the curated final output in the bash row fold once the tool completes", () => {
    const html = renderAssistantTurn([
      toolUseBlock(0, {
        toolCallId: "t1",
        toolName: "bash",
        input: { command: "ls" },
        output: "exit 0",
        streamedOutput: "file_a\nfile_b\n",
      }),
    ]);

    const text = visibleText(html);
    expect(text).toContain("exit 0");
    expect(text).not.toContain("file_a");
  });

  it("marks reducer-produced partial read calls with partial block status", () => {
    const store = createThreadStore({
      now: Date.parse("2026-01-01T00:00:00.000Z"),
      queryClient: new QueryClient(),
    });

    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "turn_1",
    });
    applyAguiEventToStore(store.getState(), "thread_1", {
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "read",
    });

    const turn = store.getState().turns("thread_1")?.[0];
    expect(turn?.blocks[0]).toMatchObject({
      blockType: "tool_use",
      status: "partial",
      content: { output: null },
    });
  });
});

function renderAssistantTurn(blocks: Block[], status: Turn["status"] = "complete"): string {
  return renderToStaticMarkup(<AssistantTurn turn={assistantTurn(blocks, status)} />);
}

function expectToolRowWithoutProtocolLeak(html: string) {
  expect(visibleText(html)).toContain("Read");
  expect(html).not.toMatch(/\(tool_(use|result)\)/);
}

function assistantTurn(blocks: Block[], status: Turn["status"] = "complete"): Turn {
  return {
    id: "turn_1",
    threadId: "thread_1",
    role: "assistant",
    status,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    createdAt: "2026-06-08T00:00:00.000Z",
    completedAt: status === "complete" ? "2026-06-08T00:00:01.000Z" : null,
    blocks,
    siblingIds: [],
    responses: [],
  };
}

function block(
  sequence: number,
  blockType: Block["blockType"],
  content: JsonValue,
  overrides: Partial<Block> = {},
): Block {
  return {
    id: `block_${sequence}`,
    turnId: "turn_1",
    responseId: null,
    blockType,
    sequence,
    textContent: textContentFor(blockType, content),
    content,
    provider: null,
    providerData: null,
    executionSide: "server",
    status: "complete",
    collapsedContent: null,
    createdAt: "2026-06-08T00:00:00.000Z",
    ...overrides,
  };
}

function reasoningBlock(sequence: number, text: string): Block {
  return block(sequence, "reasoning", { text });
}

function textBlock(sequence: number, text: string): Block {
  return block(sequence, "text", { text });
}

function checkpointBlock(sequence: number, question: string): Block {
  return block(sequence, "custom", {
    kind: "choice",
    props: {
      question,
      options: [
        { value: "approve", label: "Approve" },
        { value: "revise", label: "Revise" },
      ],
      recommended: "approve",
      requiresHuman: false,
    },
    checkpoint: { id: "checkpoint_1", timeoutMs: 270_000 },
  });
}

function toolUseBlock(
  sequence: number,
  content: JsonValue,
  status: Block["status"] = "complete",
): Block {
  return block(sequence, "tool_use", content, { status });
}

function toolResultBlock(sequence: number, content: JsonValue): Block {
  return block(sequence, "tool_result", content);
}

function textContentFor(blockType: Block["blockType"], content: JsonValue): string | null {
  if (
    (blockType === "text" || blockType === "reasoning" || blockType === "thinking") &&
    content &&
    typeof content === "object" &&
    !Array.isArray(content) &&
    typeof content.text === "string"
  ) {
    return content.text;
  }
  return null;
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

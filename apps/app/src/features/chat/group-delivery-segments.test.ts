// @ts-nocheck
/**
 * group-delivery-segments.test — verifies delivery segmentation normalizes raw
 * tool protocol blocks before rendering.
 *
 * These tests protect the streaming≡settled contract: a live merged tool block
 * and a durable tool_use/tool_result pair must become the same logical segment.
 */
import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { type DeliverySegment, groupDeliverySegments } from "./group-delivery-segments";

function block(
  id: string,
  blockType: Block["blockType"],
  content: JsonValue = null,
  status: Block["status"] = "complete",
): Block {
  return {
    id,
    turnId: "turn_1",
    responseId: null,
    blockType,
    sequence: 0,
    textContent: null,
    content,
    provider: null,
    providerData: null,
    executionSide: "server",
    status,
    collapsedContent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const toolUse = (id: string, content: JsonValue) => block(id, "tool_use", content);
const toolResult = (id: string, content: JsonValue) => block(id, "tool_result", content);

describe("groupDeliverySegments", () => {
  it("leaves non-tool blocks ungrouped", () => {
    const textA = block("t1", "text");
    const textB = block("t2", "text");
    expect(groupDeliverySegments([textA, textB])).toEqual([
      { kind: "block", block: textA },
      { kind: "block", block: textB },
    ]);
  });

  it("pairs durable tool_use and tool_result blocks by toolCallId into one tool segment", () => {
    const use = toolUse("u1", {
      toolCallId: "call_1",
      toolName: "search",
      input: { query: "rna" },
    });
    const result = toolResult("r1", {
      toolCallId: "call_1",
      output: { results: [{ title: "RNA", url: "https://example.test" }] },
    });

    const segments = groupDeliverySegments([use, result]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "tool",
      tool: {
        toolCallId: "call_1",
        toolName: "search",
        input: { query: "rna" },
        output: { results: [{ title: "RNA", url: "https://example.test" }] },
        status: "complete",
        isError: false,
        keyBlock: use,
      },
    });
    expectNoRawToolBlockSegments(segments);
  });

  it("groups two distinct durable tools in a row as one logical tool-run", () => {
    const useA = toolUse("u1", { toolCallId: "call_1", toolName: "search", input: { query: "a" } });
    const resultA = toolResult("r1", { toolCallId: "call_1", output: { ok: "a" } });
    const useB = toolUse("u2", {
      toolCallId: "call_2",
      toolName: "read",
      input: { path: "notes.md" },
    });
    const resultB = toolResult("r2", { toolCallId: "call_2", output: { ok: "b" } });

    const segments = groupDeliverySegments([useA, resultA, useB, resultB]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "tool-run",
      tools: [
        { toolCallId: "call_1", output: { ok: "a" }, status: "complete", keyBlock: useA },
        { toolCallId: "call_2", output: { ok: "b" }, status: "complete", keyBlock: useB },
      ],
    });
    expectNoRawToolBlockSegments(segments);
  });

  it("treats a live merged tool_use with output as one complete tool segment", () => {
    const use = toolUse("u1", {
      toolCallId: "call_1",
      toolName: "search",
      input: '{"query":"rna"}',
      output: { results: [] },
      message: "Searching",
    });

    const segments = groupDeliverySegments([use]);

    expect(segments).toMatchObject([
      {
        kind: "tool",
        tool: {
          toolCallId: "call_1",
          toolName: "search",
          input: '{"query":"rna"}',
          output: { results: [] },
          status: "complete",
          message: "Searching",
          keyBlock: use,
        },
      },
    ]);
    expectNoRawToolBlockSegments(segments);
  });

  it("treats a live tool_use without output as a partial tool segment", () => {
    const use = block(
      "u1",
      "tool_use",
      {
        toolCallId: "call_1",
        toolName: "search",
        input: '{"query":"rna',
        message: "Searching",
      },
      "partial",
    );

    const segments = groupDeliverySegments([use]);

    expect(segments).toMatchObject([
      {
        kind: "tool",
        tool: {
          toolCallId: "call_1",
          toolName: "search",
          input: '{"query":"rna',
          output: null,
          status: "partial",
          message: "Searching",
          keyBlock: use,
        },
      },
    ]);
    expectNoRawToolBlockSegments(segments);
  });

  it("falls back to adjacent pairing only when toolCallId is absent", () => {
    const use = toolUse("u1", { toolName: "search", input: { query: "rna" } });
    const result = toolResult("r1", { output: { ok: true } });

    expect(groupDeliverySegments([use, result])).toMatchObject([
      {
        kind: "tool",
        tool: {
          toolCallId: null,
          toolName: "search",
          output: { ok: true },
          status: "complete",
          keyBlock: use,
        },
      },
    ]);
  });

  it("leaves id-less results stray instead of mis-pairing them to adjacent id-bearing tools", () => {
    const useA = toolUse("u1", { toolCallId: "call_1", toolName: "search" });
    const useB = toolUse("u2", { toolCallId: "call_2", toolName: "read" });
    const resultA = toolResult("r1", { output: { ok: "a" } });
    const resultB = toolResult("r2", { output: { ok: "b" } });

    const segments = groupDeliverySegments([useA, useB, resultA, resultB]);

    expect(segments).toMatchObject([
      {
        kind: "tool-run",
        tools: [
          { toolCallId: "call_1", output: null, status: "complete", keyBlock: useA },
          { toolCallId: "call_2", output: null, status: "complete", keyBlock: useB },
          { toolCallId: null, output: { ok: "a" }, status: "complete", keyBlock: resultA },
          { toolCallId: null, output: { ok: "b" }, status: "complete", keyBlock: resultB },
        ],
      },
    ]);
  });

  it("surfaces streamedOutput from a live partial tool_use block on the ToolView", () => {
    const use = block(
      "u1",
      "tool_use",
      {
        toolCallId: "call_1",
        toolName: "bash",
        input: '{"command":"ls"}',
        streamedOutput: "file_a\nfile_b\n",
      },
      "partial",
    );

    const segments = groupDeliverySegments([use]);

    expect(segments).toMatchObject([
      {
        kind: "tool",
        tool: {
          toolCallId: "call_1",
          status: "partial",
          streamedOutput: "file_a\nfile_b\n",
        },
      },
    ]);
  });

  it("prefers the non-empty streamedOutput from a tool_result when pairing a durable pair", () => {
    const use = toolUse("u1", {
      toolCallId: "call_1",
      toolName: "bash",
      input: '{"command":"ls"}',
      streamedOutput: null,
    });
    const result = toolResult("r1", {
      toolCallId: "call_1",
      output: "exit 0",
      streamedOutput: "file_a\nfile_b\n",
    });

    const segments = groupDeliverySegments([use, result]);

    expect(segments).toMatchObject([
      {
        kind: "tool",
        tool: {
          toolCallId: "call_1",
          status: "complete",
          output: "exit 0",
          streamedOutput: "file_a\nfile_b\n",
        },
      },
    ]);
  });

  it("leaves image-producing tool results as raw block segments for ImageBlock rendering", () => {
    const use = toolUse("u1", { toolCallId: "call_1", toolName: "show_demo_image" });
    const imageResult = toolResult("r1", {
      toolCallId: "call_1",
      toolName: "show_demo_image",
      output: {
        url: "https://example.test/demo.png",
        alt: "Demo image",
        caption: "Generated preview",
      },
    });

    expect(groupDeliverySegments([use, imageResult])).toEqual([
      { kind: "tool", tool: expect.objectContaining({ toolCallId: "call_1", keyBlock: use }) },
      { kind: "block", block: imageResult },
    ]);
  });
});

function expectNoRawToolBlockSegments(segments: DeliverySegment[]) {
  for (const segment of segments) {
    if (segment.kind === "block") {
      expect(segment.block.blockType.startsWith("tool_")).toBe(false);
    }
  }
  expect(JSON.stringify(segments)).not.toContain("(tool_");
}

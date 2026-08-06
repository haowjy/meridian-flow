/**
 * Pins the durable delivery of server result metadata: a tool_result block's
 * `content.metadata` must reach the paired ToolView, because the work receipt
 * rides there and the renderer trusts the view, not the blocks.
 */
import type { Block } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";

import { groupDeliverySegments } from "./group-delivery-segments";

function block(sequence: number, blockType: Block["blockType"], content: Block["content"]): Block {
  return {
    id: `block-${sequence}`,
    turnId: "turn-1",
    sequence,
    blockType,
    status: "complete",
    content,
    textContent: null,
  } as Block;
}

it("carries tool_result metadata onto the paired tool view", () => {
  const receipt = {
    category: "mutate",
    line: "Created Work Tournament arc.",
    inverse: { command: "delete", workId: "w1" },
  };
  const segments = groupDeliverySegments([
    block(0, "tool_use", {
      toolCallId: "call_1",
      toolName: "work",
      input: { command: "create", name: "Tournament arc" },
    }),
    block(1, "tool_result", {
      toolCallId: "call_1",
      output: { slug: "tournament-arc" },
      metadata: { workReceipt: receipt },
    }),
  ]);

  expect(segments).toHaveLength(1);
  const segment = segments[0];
  if (segment?.kind !== "tool") throw new Error("expected one paired tool view");
  expect(segment.tool.metadata).toEqual({ workReceipt: receipt });
  expect(segment.tool.status).toBe("complete");
});

it("leaves metadata null when the result carried none", () => {
  const segments = groupDeliverySegments([
    block(0, "tool_use", { toolCallId: "call_1", toolName: "work", input: { command: "list" } }),
    block(1, "tool_result", { toolCallId: "call_1", output: [] }),
  ]);

  const segment = segments[0];
  if (segment?.kind !== "tool") throw new Error("expected one paired tool view");
  expect(segment.tool.metadata).toBeNull();
});

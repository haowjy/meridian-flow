import type { Block, TurnStatus } from "@meridian/contracts/protocol";
import { isTerminalTurnStatus } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { partitionTurnSegments } from "./partition-turn-segments";

function block(
  sequence: number,
  blockType: Block["blockType"],
  content: Block["content"] = null,
): Block {
  return {
    id: `block-${sequence}`,
    turnId: "turn-1",
    sequence,
    blockType,
    status: "complete",
    content,
    textContent: blockType === "text" || blockType === "reasoning" ? `block ${sequence}` : null,
  } as Block;
}

function partition(blocks: Block[], status: TurnStatus) {
  return partitionTurnSegments(blocks, isTerminalTurnStatus(status));
}

function sequences(blocks: Block[]) {
  return blocks.map((item) => item.sequence);
}

it("keeps the same tools-only frontier visible live and folds it on settle", () => {
  const blocks = [block(0, "reasoning"), block(1, "tool_use"), block(2, "tool_result")];

  expect(sequences(partition(blocks, "streaming")[0]?.frontier ?? [])).toEqual([1, 2]);
  expect(sequences(partition(blocks, "complete")[0]?.frontier ?? [])).toEqual([]);
  expect(partition(blocks, "complete")[0]?.foldRuns.map((run) => sequences(run.blocks))).toEqual([
    [0],
    [1, 2],
  ]);
});

it("folds only tool protocol blocks from an interleaved settled frontier", () => {
  const blocks = [
    block(0, "reasoning"),
    block(1, "text"),
    block(2, "tool_use"),
    block(3, "tool_result"),
    block(4, "text"),
    block(5, "image"),
  ];

  expect(sequences(partition(blocks, "pending")[0]?.frontier ?? [])).toEqual([1, 2, 3, 4, 5]);
  const settled = partition(blocks, "complete")[0];
  expect(settled?.foldRuns.map((run) => sequences(run.blocks))).toEqual([[0], [2, 3]]);
  expect(sequences(settled?.frontier ?? [])).toEqual([1, 4, 5]);
});

it("keeps image-bearing tool results visible as images rather than tool rows", () => {
  const imageResult = block(1, "tool_result", {
    toolName: "show_demo_image",
    output: { url: "data:image/png;base64,AA==" },
  });
  const settled = partition([block(0, "tool_use"), imageResult], "complete")[0];

  expect(settled?.foldRuns.flatMap((run) => sequences(run.blocks))).toEqual([0]);
  expect(sequences(settled?.frontier ?? [])).toEqual([1]);
});

it("partitions resolved interrupt segments independently", () => {
  const interrupt = block(3, "custom", {
    interrupt: { id: "interrupt-1" },
  } as Block["content"]);
  const blocks = [
    block(0, "reasoning"),
    block(1, "tool_use"),
    block(2, "tool_result"),
    interrupt,
    block(4, "reasoning"),
    block(5, "tool_use"),
    block(6, "tool_result"),
    block(7, "text"),
  ];

  const settled = partition(blocks, "complete");
  expect(settled).toHaveLength(2);
  expect(settled.map((segment) => sequences(segment.frontier))).toEqual([[3], [7]]);
  expect(
    settled.map((segment) => segment.foldRuns.flatMap((run) => sequences(run.blocks))),
  ).toEqual([
    [0, 1, 2],
    [4, 5, 6],
  ]);
});

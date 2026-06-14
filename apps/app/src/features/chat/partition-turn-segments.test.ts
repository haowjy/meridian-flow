/**
 * partition-turn-segments tests — guards the structural Thinking/Activity contract.
 *
 * Purpose: Exercises the documented lifecycle, checkpoint segmentation, and the
 * live-equals-settled invariant for the pure partitioning function. The tests
 * assert layouts by block id so status changes cannot masquerade as structural
 * differences.
 */
import type { Block } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import {
  isCheckpointBlock,
  isReasoningBlock,
  partitionTurnSegments,
  type Run,
  type TurnSegment,
} from "./partition-turn-segments";

function block(
  id: string,
  blockType: Block["blockType"],
  text?: string,
  overrides: Partial<Block> = {},
): Block {
  return {
    id,
    turnId: "turn_1",
    responseId: null,
    blockType,
    sequence: Number(id.replace(/\D/g, "")) || 0,
    textContent: text ?? null,
    content: text ? { text } : null,
    provider: null,
    providerData: null,
    executionSide: "server",
    status: "complete",
    collapsedContent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function checkpoint(id: string): Block {
  return block(id, "custom", undefined, {
    content: {
      kind: "choice",
      props: {},
      checkpoint: { id: `checkpoint_${id}` },
    },
  });
}

function layout(segments: TurnSegment[]) {
  return segments.map((segment) => ({
    foldRuns: segment.foldRuns.map(runLayout),
    frontier: segment.frontier.map((block) => block.id),
  }));
}

function runLayout(run: Run) {
  return { kind: run.kind, blocks: run.blocks.map((block) => block.id) };
}

describe("block classifiers", () => {
  it("classifies reasoning and thinking blocks as reasoning", () => {
    expect(isReasoningBlock(block("r0", "reasoning"))).toBe(true);
    expect(isReasoningBlock(block("t0", "thinking"))).toBe(true);
    expect(isReasoningBlock(block("a0", "text"))).toBe(false);
  });

  it("treats custom blocks with a checkpoint id as checkpoint boundaries", () => {
    expect(isCheckpointBlock(checkpoint("c1"))).toBe(true);
    expect(
      isCheckpointBlock(block("c2", "custom", undefined, { content: { checkpoint: {} } })),
    ).toBe(false);
    expect(
      isCheckpointBlock(
        block("c3", "custom", undefined, { content: { checkpoint: { id: "checkpoint_c3" } } }),
      ),
    ).toBe(true);
    expect(isCheckpointBlock(block("t1", "text"))).toBe(false);
  });
});

describe("partitionTurnSegments lifecycle", () => {
  it("state 1: reasoning-only turn has an empty frontier", () => {
    const r0 = block("r0", "reasoning");

    expect(layout(partitionTurnSegments([r0]))).toEqual([
      { foldRuns: [{ kind: "reasoning", blocks: ["r0"] }], frontier: [] },
    ]);
  });

  it("state 2: first delivery is the visible frontier", () => {
    const blocks = [block("r0", "reasoning"), block("a1", "text")];

    expect(layout(partitionTurnSegments(blocks))).toEqual([
      { foldRuns: [{ kind: "reasoning", blocks: ["r0"] }], frontier: ["a1"] },
    ]);
  });

  it("states 3 and 4: contiguous activity stays in the frontier", () => {
    const state3 = [block("r0", "reasoning"), block("a1", "text"), block("a2", "tool_use")];
    const state4 = [...state3, block("a3", "text")];

    expect(layout(partitionTurnSegments(state3))).toEqual([
      { foldRuns: [{ kind: "reasoning", blocks: ["r0"] }], frontier: ["a1", "a2"] },
    ]);
    expect(layout(partitionTurnSegments(state4))).toEqual([
      { foldRuns: [{ kind: "reasoning", blocks: ["r0"] }], frontier: ["a1", "a2", "a3"] },
    ]);
  });

  it("state 5 transient: trailing reasoning folds while prior activity remains frontier", () => {
    const blocks = [
      block("r0", "reasoning"),
      block("a1", "text"),
      block("a2", "tool_use"),
      block("a3", "text"),
      block("r4", "reasoning"),
    ];

    expect(layout(partitionTurnSegments(blocks))).toEqual([
      {
        foldRuns: [
          { kind: "reasoning", blocks: ["r0"] },
          { kind: "reasoning", blocks: ["r4"] },
        ],
        frontier: ["a1", "a2", "a3"],
      },
    ]);
  });

  it("state 6: new delivery rolls the prior activity run into the fold", () => {
    const blocks = [
      block("r0", "reasoning"),
      block("a1", "text"),
      block("a2", "tool_use"),
      block("a3", "text"),
      block("r4", "reasoning"),
      block("a5", "text"),
    ];

    expect(layout(partitionTurnSegments(blocks))).toEqual([
      {
        foldRuns: [
          { kind: "reasoning", blocks: ["r0"] },
          { kind: "activity", blocks: ["a1", "a2", "a3"] },
          { kind: "reasoning", blocks: ["r4"] },
        ],
        frontier: ["a5"],
      },
    ]);
  });
});

describe("partitionTurnSegments checkpoints", () => {
  it("keeps a turn without checkpoints as one segment", () => {
    const blocks = [block("r0", "reasoning"), block("a1", "text")];

    expect(partitionTurnSegments(blocks)).toHaveLength(1);
  });

  it("splits one checkpoint mid-turn and keeps the checkpoint run as segment 1 frontier", () => {
    const blocks = [
      block("r0", "reasoning"),
      block("a1", "text"),
      checkpoint("c2"),
      block("r3", "reasoning"),
      block("a4", "text"),
    ];

    expect(layout(partitionTurnSegments(blocks))).toEqual([
      { foldRuns: [{ kind: "reasoning", blocks: ["r0"] }], frontier: ["a1", "c2"] },
      { foldRuns: [{ kind: "reasoning", blocks: ["r3"] }], frontier: ["a4"] },
    ]);
  });

  it("splits multiple checkpoints into stacked segments", () => {
    const blocks = [
      block("a0", "text"),
      checkpoint("c1"),
      block("r2", "reasoning"),
      block("a3", "text"),
      checkpoint("c4"),
      block("a5", "text"),
    ];

    expect(layout(partitionTurnSegments(blocks))).toEqual([
      { foldRuns: [], frontier: ["a0", "c1"] },
      { foldRuns: [{ kind: "reasoning", blocks: ["r2"] }], frontier: ["a3", "c4"] },
      { foldRuns: [], frontier: ["a5"] },
    ]);
  });

  it("does not add an empty continuation segment after a terminal checkpoint", () => {
    const blocks = [block("a0", "text"), checkpoint("c1")];

    expect(layout(partitionTurnSegments(blocks))).toEqual([
      { foldRuns: [], frontier: ["a0", "c1"] },
    ]);
  });

  it("keeps reasoning-only post-checkpoint segments folded with an empty frontier", () => {
    const blocks = [checkpoint("c0"), block("r1", "reasoning")];

    expect(layout(partitionTurnSegments(blocks))).toEqual([
      { foldRuns: [], frontier: ["c0"] },
      { foldRuns: [{ kind: "reasoning", blocks: ["r1"] }], frontier: [] },
    ]);
  });

  it("does not treat custom component blocks without checkpoint ids as boundaries", () => {
    const custom = block("x1", "custom", undefined, { content: { kind: "choice", props: {} } });
    const blocks = [block("a0", "text"), custom, block("a2", "text")];

    expect(layout(partitionTurnSegments(blocks))).toEqual([
      { foldRuns: [], frontier: ["a0", "x1", "a2"] },
    ]);
  });
});

describe("partitionTurnSegments invariants", () => {
  it("partitions live and settled blocks with the same structure regardless of block status", () => {
    const liveBlocks = [
      block("r0", "reasoning", undefined, { status: "partial" }),
      block("a1", "text", "draft", { status: "partial" }),
      block("r2", "reasoning", undefined, { status: "partial" }),
    ];
    const settledBlocks = liveBlocks.map((liveBlock) => ({
      ...liveBlock,
      status: "complete" as const,
    }));

    expect(layout(partitionTurnSegments(liveBlocks))).toEqual(
      layout(partitionTurnSegments(settledBlocks)),
    );
  });
});

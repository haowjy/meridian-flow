import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { partitionTurnSegments } from "./partition-turn-segments";

function block(args: {
  blockType: Block["blockType"];
  sequence: number;
  content?: JsonValue;
  status?: Block["status"];
}): Block {
  return {
    id: `block-${args.sequence}`,
    turnId: "turn-1",
    responseId: null,
    blockType: args.blockType,
    sequence: args.sequence,
    content: args.content ?? null,
    status: args.status ?? "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const writeUse = block({
  blockType: "tool_use",
  sequence: 1,
  content: { toolCallId: "write-1", toolName: "write", input: { command: "read" } },
});
const writeResult = block({
  blockType: "tool_result",
  sequence: 2,
  content: { toolCallId: "write-1", output: "passage" },
});
const spawnUse = block({
  blockType: "tool_use",
  sequence: 3,
  content: { toolCallId: "spawn-1", toolName: "spawn", input: { prompt: "check" } },
});
const spawnResult = block({
  blockType: "tool_result",
  sequence: 4,
  content: {
    toolCallId: "spawn-1",
    toolName: "spawn",
    output: { status: "completed", report: { threadId: "child-1", summary: "2+2=4." } },
  },
});
const spawnCard = block({
  blockType: "custom",
  sequence: 5,
  content: {
    kind: "helper-result",
    props: {
      agentName: "Helper",
      status: "completed",
      summary: "2+2=4.",
      childThreadId: "child-1",
    },
  },
});

describe("partitionTurnSegments durable settlement", () => {
  it("splits at the spawn helper-result card like an interrupt", () => {
    const reasoning = block({ blockType: "reasoning", sequence: 0 });
    const after = block({ blockType: "text", sequence: 6 });
    const segments = partitionTurnSegments(
      [reasoning, writeUse, writeResult, spawnUse, spawnResult, spawnCard, after],
      true,
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]?.frontier.map((b) => b.sequence)).toEqual([5]);
    expect(segments[0]?.foldRuns.flatMap((run) => run.blocks).map((b) => b.sequence)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(segments[1]?.frontier.map((b) => b.sequence)).toEqual([6]);
    expect(segments[1]?.foldRuns).toEqual([]);
  });

  it("keeps a running spawn card on the live frontier", () => {
    const running = block({
      blockType: "custom",
      sequence: 1,
      content: { kind: "helper-result", props: { status: "running", agentName: "Helper" } },
    });
    const [segment] = partitionTurnSegments(
      [block({ blockType: "reasoning", sequence: 0 }), running],
      false,
    );
    expect(segment?.frontier.map((b) => b.sequence)).toEqual([1]);
    expect(segment?.foldRuns.flatMap((run) => run.blocks).map((b) => b.sequence)).toEqual([0]);
  });
});

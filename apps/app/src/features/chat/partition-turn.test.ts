import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { partitionTurn } from "./partition-turn";

function block(args: {
  blockType: Block["blockType"];
  sequence: number;
  content?: JsonValue;
  textContent?: string;
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
    textContent: args.textContent,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const reasoning = (sequence: number, text: string) =>
  block({ blockType: "reasoning", sequence, textContent: text });
const prose = (sequence: number, text: string) =>
  block({ blockType: "text", sequence, textContent: text });
const writeUse = (sequence: number) =>
  block({
    blockType: "tool_use",
    sequence,
    content: { toolCallId: `write-${sequence}`, toolName: "write", input: { command: "read" } },
  });
const writeResult = (sequence: number, useSequence: number) =>
  block({
    blockType: "tool_result",
    sequence,
    content: { toolCallId: `write-${useSequence}`, output: "passage" },
  });
const spawnUse = (sequence: number) =>
  block({
    blockType: "tool_use",
    sequence,
    content: { toolCallId: `spawn-${sequence}`, toolName: "spawn", input: { prompt: "check" } },
  });
const spawnResult = (sequence: number, useSequence: number) =>
  block({
    blockType: "tool_result",
    sequence,
    content: {
      toolCallId: `spawn-${useSequence}`,
      output: { status: "completed", report: { threadId: "child-1", summary: "2+2=4." } },
    },
  });
const spawnCard = (sequence: number) =>
  block({
    blockType: "custom",
    sequence,
    content: {
      kind: "helper-result",
      props: { agentName: "Helper", status: "completed", summary: "2+2=4.", childThreadId: "c" },
    },
  });
const threadMessageUse = (sequence: number) =>
  block({
    blockType: "tool_use",
    sequence,
    content: {
      toolCallId: `thread-message-${sequence}`,
      toolName: "thread_message",
      input: { handle: "p3", prompt: "keep going" },
    },
  });
const threadMessageResult = (sequence: number, useSequence: number) =>
  block({
    blockType: "tool_result",
    sequence,
    content: {
      toolCallId: `thread-message-${useSequence}`,
      output: { status: "completed", report: { threadId: "child-1", summary: "Done." } },
    },
  });

const kinds = (items: ReturnType<typeof partitionTurn>) => items.map((item) => item.kind);

describe("partitionTurn", () => {
  it("keeps prose visible between process runs, in chronological order", () => {
    const items = partitionTurn([
      reasoning(0, "First thought."),
      prose(1, "First paragraph."),
      reasoning(2, "Second thought."),
      prose(3, "Second paragraph."),
    ]);

    expect(kinds(items)).toEqual(["process", "text", "process", "text"]);
    expect(items[0]).toMatchObject({ runs: [{ kind: "reasoning", blocks: [{ sequence: 0 }] }] });
    expect(items[1]).toMatchObject({ block: { sequence: 1 } });
    expect(items[2]).toMatchObject({ runs: [{ kind: "reasoning", blocks: [{ sequence: 2 }] }] });
    expect(items[3]).toMatchObject({ block: { sequence: 3 } });
  });

  it("folds process tools into the same process item as adjacent reasoning", () => {
    const items = partitionTurn([reasoning(0, "Reading."), writeUse(1), writeResult(2, 1)]);

    expect(kinds(items)).toEqual(["process"]);
    expect(items[0]).toMatchObject({
      runs: [
        { kind: "reasoning", blocks: [{ sequence: 0 }] },
        { kind: "activity", blocks: [{ sequence: 1 }, { sequence: 2 }] },
      ],
    });
  });

  it("lets prose split a process run so later reasoning starts a new fold", () => {
    const items = partitionTurn([
      writeUse(1),
      writeResult(2, 1),
      prose(3, "Result of the read."),
      writeUse(4),
      writeResult(5, 4),
    ]);

    expect(kinds(items)).toEqual(["process", "text", "process"]);
    expect(items[0]).toMatchObject({
      runs: [{ kind: "activity", blocks: [{ sequence: 1 }, { sequence: 2 }] }],
    });
    expect(items[2]).toMatchObject({
      runs: [{ kind: "activity", blocks: [{ sequence: 4 }, { sequence: 5 }] }],
    });
  });

  it("emits an artifact between process runs and closes the prior run", () => {
    const items = partitionTurn([reasoning(0, "Spawn."), spawnCard(1), reasoning(2, "After.")]);

    expect(kinds(items)).toEqual(["process", "artifact", "process"]);
    expect(items[1]).toMatchObject({ block: { sequence: 1 } });
  });

  it("drops hidden spawn protocol and keeps only the card", () => {
    const items = partitionTurn([spawnUse(1), spawnResult(2, 1), spawnCard(3), prose(4, "Done.")]);

    expect(kinds(items)).toEqual(["artifact", "text"]);
    expect(items[0]).toMatchObject({ block: { sequence: 3 } });
    expect(items[1]).toMatchObject({ block: { sequence: 4 } });
  });

  it("renders return_result as the child's report", () => {
    const returnUse = block({
      blockType: "tool_use",
      sequence: 1,
      content: {
        toolCallId: "return-1",
        toolName: "return_result",
        input: { summary: "First line.\nFull report.", payload: { answer: 42 }, artifacts: [] },
      },
    });
    const returnResult = block({
      blockType: "tool_result",
      sequence: 2,
      content: { toolCallId: "return-1", output: { ok: true } },
    });
    const items = partitionTurn([returnUse, returnResult]);

    expect(kinds(items)).toEqual(["report"]);
    expect(items[0]).toMatchObject({
      kind: "report",
      block: { sequence: 1 },
      report: { summary: "First line.\nFull report.", payload: { answer: 42 }, partial: false },
    });
  });

  it("drops hidden thread_message protocol and keeps only the card", () => {
    const items = partitionTurn([
      threadMessageUse(1),
      threadMessageResult(2, 1),
      spawnCard(3),
      prose(4, "Continuing."),
    ]);

    expect(kinds(items)).toEqual(["artifact", "text"]);
    expect(items[0]).toMatchObject({ block: { sequence: 3 } });
    expect(items[1]).toMatchObject({ block: { sequence: 4 } });
  });

  it("drops empty reasoning and does not let it split a process run", () => {
    const items = partitionTurn([
      writeUse(1),
      writeResult(2, 1),
      block({ blockType: "reasoning", sequence: 3, textContent: "  " }),
      writeUse(4),
      writeResult(5, 4),
    ]);

    expect(kinds(items)).toEqual(["process"]);
    expect(items[0]).toMatchObject({
      runs: [{ kind: "activity", blocks: [1, 2, 4, 5].map((sequence) => ({ sequence })) }],
    });
  });

  it("emits nothing when the only block is empty reasoning", () => {
    expect(
      partitionTurn([block({ blockType: "reasoning", sequence: 0, textContent: "" })]),
    ).toEqual([]);
  });

  it("treats an image block as an artifact", () => {
    const items = partitionTurn([block({ blockType: "image", sequence: 0, content: {} })]);

    expect(kinds(items)).toEqual(["artifact"]);
  });

  it("drops empty text blocks", () => {
    expect(partitionTurn([prose(0, "   ")])).toEqual([]);
  });

  it("keeps the spawn card and drops both protocol halves across the production order", () => {
    // Persisted order is tool_use, then the helper-result card, then tool_result.
    const items = partitionTurn([spawnUse(1), spawnCard(2), spawnResult(3, 1), prose(4, "After.")]);

    expect(kinds(items)).toEqual(["artifact", "text"]);
    expect(items[0]).toMatchObject({ block: { sequence: 2 } });
    expect(items[1]).toMatchObject({ block: { sequence: 4 } });
  });

  it("treats a thinking block as process and a file block as an artifact", () => {
    const thinking = partitionTurn([
      block({ blockType: "thinking", sequence: 0, textContent: "Pondering." }),
    ]);
    expect(kinds(thinking)).toEqual(["process"]);

    const file = partitionTurn([block({ blockType: "file", sequence: 0, content: {} })]);
    expect(kinds(file)).toEqual(["artifact"]);
  });

  it("drops activity placeholders", () => {
    expect(
      partitionTurn([block({ blockType: "activity" as Block["blockType"], sequence: 0 })]),
    ).toEqual([]);
  });

  it("drops ask_user protocol and keeps the choice card", () => {
    const askUse = block({
      blockType: "tool_use",
      sequence: 1,
      content: { toolCallId: "ask-1", toolName: "ask_user", input: {} },
    });
    const askResult = block({
      blockType: "tool_result",
      sequence: 2,
      content: { toolCallId: "ask-1" },
    });
    const choiceCard = block({
      blockType: "custom",
      sequence: 3,
      content: { kind: "choice", props: {} },
    });
    const items = partitionTurn([askUse, askResult, choiceCard]);

    expect(kinds(items)).toEqual(["artifact"]);
    expect(items[0]).toMatchObject({ block: { sequence: 3 } });
  });
});

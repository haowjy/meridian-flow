/**
 * return_result settlement persists tool_result and child-report together.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../loop/persistence.js", () => ({
  persistAndAppendEvents: vi.fn(async (_deps, _threadId, operation) => operation()),
}));

import { persistAndAppendEvents } from "../loop/persistence.js";
import { persistReturnResult, type SpawnTranscript } from "./spawn-transcript.js";

function transcript(): SpawnTranscript {
  return {
    persistence: {} as SpawnTranscript["persistence"],
    threadId: "thread-1" as ThreadId,
    turnId: "turn-1",
    blockSeqRef: { value: 3 },
    allBlocks: [],
    events: [],
  };
}

describe("persistReturnResult", () => {
  beforeEach(() => {
    vi.mocked(persistAndAppendEvents).mockClear();
  });

  it("persists tool_result and child-report in one transaction; card is last", async () => {
    const active = transcript();
    const settled = await persistReturnResult(active, {
      toolCallId: "call-1",
      outcome: { ok: true },
      summary: "done",
    });

    expect(persistAndAppendEvents).toHaveBeenCalledOnce();
    expect(settled.endTurn).toBe(true);
    expect(active.allBlocks.map((block) => block.blockType)).toEqual(["tool_result", "custom"]);
    const tool = active.allBlocks[0];
    const card = active.allBlocks[1];
    expect(tool && card && card.sequence > tool.sequence).toBe(true);
    expect(active.events.map((event) => event.type)).toEqual([
      "block.upserted",
      "tool.result",
      "block.upserted",
    ]);
    const cardEvent = active.events[2];
    expect(cardEvent?.type).toBe("block.upserted");
    if (cardEvent?.type !== "block.upserted") return;
    expect(cardEvent.block.blockType).toBe("custom");
    expect(cardEvent.block.content).toMatchObject({
      kind: "child-report",
      props: { summary: "done" },
    });
  });

  it("persists a failed envelope without a card or endTurn", async () => {
    const active = transcript();
    const settled = await persistReturnResult(active, {
      toolCallId: "call-1",
      outcome: { ok: false, message: "already returned" },
      summary: "ignored",
    });

    expect(persistAndAppendEvents).toHaveBeenCalledOnce();
    expect(settled.endTurn).toBe(false);
    expect(active.allBlocks.map((block) => block.blockType)).toEqual(["tool_result"]);
    expect(active.events.map((event) => event.type)).toEqual(["block.upserted", "tool.result"]);
  });
});

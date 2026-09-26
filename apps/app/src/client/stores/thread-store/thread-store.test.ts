import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { createThreadStore } from "./thread-store";

function setup() {
  return createThreadStore({
    now: 0,
    threadCache: {
      upsertThread() {},
      patchThread() {},
      invalidateThread() {},
      invalidateThreadSnapshot() {},
    },
  });
}

function customBlock(props: Record<string, JsonValue>): Block {
  return {
    id: "card-1",
    turnId: "turn-1",
    responseId: null,
    blockType: "custom",
    sequence: 4,
    content: { kind: "helper-result", props },
    status: "complete",
    textContent: null,
    createdAt: "2026-09-23T00:00:00.000Z",
  };
}

describe("thread store block upserts", () => {
  it("does not change turn or block references for duplicate historical replacement", () => {
    const store = setup();
    store.getState().ensureAssistantTurn("thread-1", "turn-1");
    store.getState().ensureAssistantTurn("thread-1", "turn-2");
    store
      .getState()
      .upsertAssistantBlock("thread-1", "turn-1", customBlock({ outcome: "succeeded" }));
    const before = store.getState().turns("thread-1") ?? [];
    const beforeBlocks = before[0]?.blocks;
    const otherTurn = before[1];

    store
      .getState()
      .upsertAssistantBlock("thread-1", "turn-1", customBlock({ outcome: "succeeded" }));

    const after = store.getState().turns("thread-1") ?? [];
    expect(after).toBe(before);
    expect(after[0]?.blocks).toBe(beforeBlocks);
    expect(after[1]).toBe(otherTurn);
  });
});

describe("durable block wire freshness", () => {
  it("keeps the cursor and snapshot floor monotonic beyond safe integers", () => {
    const store = setup();
    const actions = store.getState();
    const seq = "9007199254740993000";
    expect(actions.acceptDurableBlockSeq("thread-1", seq)).toBe(true);
    expect(actions.acceptDurableBlockSeq("thread-1", seq)).toBe(false);
    expect(actions.acceptDurableBlockSeq("thread-1", "9007199254740992999")).toBe(false);
    expect(actions.acceptDurableBlockSeq("thread-1", "invalid")).toBe(false);
    expect(actions.acceptsThreadSnapshot("thread-1", seq)).toBe(false);
    expect(actions.acceptsThreadSnapshot("thread-1", "9007199254740993001")).toBe(true);
  });

  it("does not let a stale snapshot alter lifecycle or terminal blocks", () => {
    const store = setup();
    const actions = store.getState();
    actions.ensureAssistantTurn("thread-1", "turn-1");
    actions.upsertAssistantBlock("thread-1", "turn-1", customBlock({ outcome: "done" }));
    const before = actions.turns("thread-1");
    actions.acceptDurableBlockSeq("thread-1", "375000");
    const accepted = actions.applyThreadSnapshot(
      { id: "thread-1", projectId: "project-1" } as never,
      [],
      { nextSeq: "375000", lifecycle: { actionRequired: false, runningTurnId: null } },
    );
    expect(accepted).toBe(false);
    expect(actions.turns("thread-1")).toBe(before);
    expect(store.getState().durableBlockCursorByThread["thread-1"]).toBe("375000");
  });
});

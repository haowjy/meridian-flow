// @vitest-environment jsdom
/**
 * The live transcript drops a block when the server prunes it. Pins the
 * `meridian.block.pruned` frame to the store's block removal, so a retired
 * background run card cannot linger after a reload-less settle.
 */
import type { AGUIEvent, Block } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import { applyAguiEventToStore } from "./reduce-turn-event";

type ThreadStoreApi = ReturnType<typeof createThreadStore>;

function store(): ThreadStoreApi {
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

function customBlock(id: string): Block {
  return {
    id,
    turnId: "turn-1",
    responseId: null,
    blockType: "custom",
    sequence: 0,
    textContent: null,
    content: { kind: "helper-result", props: { status: "running" } },
    provider: null,
    providerData: null,
    executionSide: "server",
    status: "complete",
    collapsedContent: null,
    createdAt: new Date(0).toISOString(),
  };
}

function pruneEvent(blockId: string): AGUIEvent {
  return {
    type: EventType.CUSTOM,
    name: "meridian.block.pruned",
    value: { blockId },
  } as AGUIEvent;
}

describe("block prune reduction", () => {
  it("removes the pruned block from the live turn", () => {
    const api = store();
    api.getState().ensureAssistantTurn("thread-1", "turn-1");
    api.getState().upsertAssistantBlock("thread-1", "turn-1", customBlock("card-1"));

    applyAguiEventToStore(api.getState(), "thread-1", pruneEvent("card-1"));

    expect(api.getState().turns("thread-1")?.[0]?.blocks).toHaveLength(0);
  });

  it("ignores a prune frame for an unknown block id", () => {
    const api = store();
    api.getState().ensureAssistantTurn("thread-1", "turn-1");
    api.getState().upsertAssistantBlock("thread-1", "turn-1", customBlock("card-1"));

    applyAguiEventToStore(api.getState(), "thread-1", pruneEvent("other"));

    expect(api.getState().turns("thread-1")?.[0]?.blocks).toHaveLength(1);
  });
});

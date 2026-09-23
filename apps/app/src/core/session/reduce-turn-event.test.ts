// @vitest-environment jsdom
/**
 * Durable custom projections are consumed by live listeners, never by the
 * transcript. Before the skip they fell through to the generic
 * `blockType: "custom"` branch, whose `{ name, value }` content has no `kind`
 * and rendered "Unknown component: missing kind" while the turn streamed.
 */
import type { AGUIEvent } from "@meridian/contracts/protocol";
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

function customEvent(name: string, value: unknown): AGUIEvent {
  return { type: EventType.CUSTOM, name, value } as AGUIEvent;
}

describe("durable custom projection reduction", () => {
  it("replaces a historical card after RUN_FINISHED without changing the active turn", () => {
    const api = store();
    api.getState().ensureAssistantTurn("thread-1", "historical");
    api.getState().ensureAssistantTurn("thread-1", "active");
    api.getState().patchTurnStatus("thread-1", "historical", "complete");
    const beforeActive = api.getState().turns("thread-1")?.[1];
    const block = {
      id: "card-1",
      turnId: "historical",
      blockType: "custom",
      sequence: 3,
      content: { kind: "helper-result", props: { status: "completed" } },
    };

    applyAguiEventToStore(
      api.getState(),
      "thread-1",
      customEvent("meridian.block.upserted", { block }),
    );

    const turns = api.getState().turns("thread-1");
    expect(turns?.[0]?.status).toBe("complete");
    expect(turns?.[0]?.blocks[0]?.id).toBe("card-1");
    expect(turns?.[1]).toBe(beforeActive);
  });

  it("invalidates the durable snapshot instead of minting a missing historical turn", () => {
    const api = store();
    let invalidated = 0;
    const state = api.getState();
    const target = {
      ...state,
      invalidateThreadSnapshot: () => invalidated++,
    };

    applyAguiEventToStore(
      target,
      "thread-1",
      customEvent("meridian.block.upserted", {
        block: { id: "card-2", turnId: "gone", blockType: "custom", sequence: 0, content: {} },
      }),
    );

    expect(invalidated).toBe(1);
    expect(api.getState().turns("thread-1")).toBeUndefined();
  });

  it("does not project meridian.inbox.changed into a transcript block", () => {
    const api = store();
    api.getState().ensureAssistantTurn("thread-1", "turn-1");

    applyAguiEventToStore(
      api.getState(),
      "thread-1",
      customEvent("meridian.inbox.changed", { items: [] }),
    );

    expect(api.getState().turns("thread-1")?.[0]?.blocks).toHaveLength(0);
  });

  it("does not project meridian.work_context.changed into a transcript block", () => {
    const api = store();
    api.getState().ensureAssistantTurn("thread-1", "turn-1");

    applyAguiEventToStore(
      api.getState(),
      "thread-1",
      customEvent("meridian.work_context.changed", {
        threadId: "thread-1",
        projectId: "project-1",
        scope: { workId: "work-1", workSlug: null },
      }),
    );

    expect(api.getState().turns("thread-1")?.[0]?.blocks).toHaveLength(0);
  });
});

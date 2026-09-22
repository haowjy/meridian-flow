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
    },
  });
}

function customEvent(name: string, value: unknown): AGUIEvent {
  return { type: EventType.CUSTOM, name, value } as AGUIEvent;
}

describe("durable custom projection reduction", () => {
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

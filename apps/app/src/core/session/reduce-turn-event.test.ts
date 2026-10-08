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

describe("tool result reduction", () => {
  it("keeps the typed result beside the model's text, across later tool events", () => {
    const api = store();
    api.getState().ensureAssistantTurn("thread-1", "turn-1");
    const result = { schema: "meridian.agent-edit.v1", command: "read", status: "success" };
    applyAguiEventToStore(api.getState(), "thread-1", {
      type: EventType.TOOL_CALL_START,
      toolCallId: "call-1",
      toolCallName: "read",
    } as AGUIEvent);
    applyAguiEventToStore(api.getState(), "thread-1", {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "run-1",
      toolCallId: "call-1",
      content: "status: success; path: ch1.md",
      result,
    } as AGUIEvent);
    applyAguiEventToStore(api.getState(), "thread-1", {
      type: EventType.TOOL_CALL_END,
      toolCallId: "call-1",
    } as AGUIEvent);

    const block = api.getState().turns("thread-1")?.[0]?.blocks[0];
    expect(block?.content).toMatchObject({
      output: "status: success; path: ch1.md",
      result,
    });
  });
});

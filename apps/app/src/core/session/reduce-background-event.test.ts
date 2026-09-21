import type { AGUIEvent, Block, JsonValue } from "@meridian/contracts/protocol";
import { EventSchemas, EventType } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import type { ThreadStoreActions } from "@/client/stores";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";

import { applyBackgroundRunEvent, backgroundRunBlockId } from "./reduce-background-event";

const THREAD = "thread-1";

function backgroundEvent(name: string, value: JsonValue): AGUIEvent {
  return EventSchemas.parse({ type: EventType.CUSTOM, name, value });
}

function createActions(): ThreadStoreActions {
  return createThreadStore({
    now: 0,
    threadCache: {
      upsertThread() {},
      patchThread() {},
      invalidateThread() {},
    },
  }).getState();
}

function blockContent(block: Block): Record<string, unknown> {
  return block.content as Record<string, unknown>;
}

function propsOf(block: Block): Record<string, unknown> {
  return blockContent(block).props as Record<string, unknown>;
}

describe("reduce-background-event", () => {
  it("shows a running helper card on the parent turn when a run starts", () => {
    const actions = createActions();
    actions.ensureAssistantTurn(THREAD, "turn-1");

    const handled = applyBackgroundRunEvent(
      actions,
      THREAD,
      backgroundEvent("meridian.background.started", {
        parentThreadId: THREAD,
        parentTurnId: "turn-1",
        childThreadId: "child-1",
        agentSlug: "code-reviewer",
        description: "Review the chapter",
      }),
    );

    expect(handled).toBe(true);
    const block = actions.turns(THREAD)?.[0]?.blocks[0];
    expect(block?.id).toBe(backgroundRunBlockId("child-1"));
    expect(block?.blockType).toBe("custom");
    expect(blockContent(block as Block).kind).toBe("helper-result");
    expect(propsOf(block as Block)).toMatchObject({
      agentSlug: "code-reviewer",
      agentName: "Code Reviewer",
      status: "running",
      childThreadId: "child-1",
      title: "Review the chapter",
    });
  });

  it("clears the running card when the run completes", () => {
    const actions = createActions();
    actions.ensureAssistantTurn(THREAD, "turn-1");

    applyBackgroundRunEvent(
      actions,
      THREAD,
      backgroundEvent("meridian.background.started", {
        parentThreadId: THREAD,
        parentTurnId: "turn-1",
        childThreadId: "child-1",
        agentSlug: "helper",
      }),
    );
    applyBackgroundRunEvent(
      actions,
      THREAD,
      backgroundEvent("meridian.background.completed", {
        parentThreadId: THREAD,
        parentTurnId: "turn-1",
        childThreadId: "child-1",
      }),
    );

    expect(actions.turns(THREAD)?.[0]?.blocks).toEqual([]);
  });

  it("clears the running card when the run fails", () => {
    const actions = createActions();
    actions.ensureAssistantTurn(THREAD, "turn-1");

    applyBackgroundRunEvent(
      actions,
      THREAD,
      backgroundEvent("meridian.background.started", {
        parentThreadId: THREAD,
        parentTurnId: "turn-1",
        childThreadId: "child-2",
        agentSlug: "helper",
      }),
    );
    applyBackgroundRunEvent(
      actions,
      THREAD,
      backgroundEvent("meridian.background.failed", {
        parentThreadId: THREAD,
        parentTurnId: "turn-1",
        childThreadId: "child-2",
        error: "boom",
      }),
    );

    expect(actions.turns(THREAD)?.[0]?.blocks).toEqual([]);
  });

  it("clears a card on a settled parent turn that is no longer running", () => {
    const actions = createActions();
    actions.ensureAssistantTurn(THREAD, "turn-1");

    applyBackgroundRunEvent(
      actions,
      THREAD,
      backgroundEvent("meridian.background.started", {
        parentThreadId: THREAD,
        parentTurnId: "turn-1",
        childThreadId: "child-3",
        agentSlug: "helper",
      }),
    );
    actions.patchTurnStatus(THREAD, "turn-1", "complete");

    applyBackgroundRunEvent(
      actions,
      THREAD,
      backgroundEvent("meridian.background.completed", {
        parentThreadId: THREAD,
        parentTurnId: "turn-1",
        childThreadId: "child-3",
      }),
    );

    expect(actions.turns(THREAD)?.[0]?.blocks).toEqual([]);
  });

  it("attaches to the active assistant turn when the event omits parentTurnId", () => {
    const actions = createActions();
    actions.ensureAssistantTurn(THREAD, "turn-1");

    applyBackgroundRunEvent(
      actions,
      THREAD,
      backgroundEvent("meridian.background.started", {
        childThreadId: "child-4",
        agentSlug: "helper",
      }),
    );

    const block = actions.turns(THREAD)?.find((turn) => turn.id === "turn-1")?.blocks[0];
    expect(block?.id).toBe(backgroundRunBlockId("child-4"));
  });

  it("ignores settled events with no running card and unrelated custom events", () => {
    const actions = createActions();
    actions.ensureAssistantTurn(THREAD, "turn-1");

    expect(
      applyBackgroundRunEvent(
        actions,
        THREAD,
        backgroundEvent("meridian.background.completed", { childThreadId: "missing" }),
      ),
    ).toBe(true);
    expect(actions.turns(THREAD)?.[0]?.blocks).toEqual([]);

    expect(
      applyBackgroundRunEvent(
        actions,
        THREAD,
        backgroundEvent("meridian.work_context.changed", { childThreadId: "missing" }),
      ),
    ).toBe(false);
  });

  it("drops malformed background payloads without touching turns", () => {
    const actions = createActions();
    actions.ensureAssistantTurn(THREAD, "turn-1");

    expect(
      applyBackgroundRunEvent(
        actions,
        THREAD,
        backgroundEvent("meridian.background.started", { agentSlug: "helper" }),
      ),
    ).toBe(true);
    expect(actions.turns(THREAD)?.[0]?.blocks).toEqual([]);
  });

  it("reuses one block id across repeated started events for the same child", () => {
    const actions = createActions();
    actions.ensureAssistantTurn(THREAD, "turn-1");
    const started = backgroundEvent("meridian.background.started", {
      parentThreadId: THREAD,
      parentTurnId: "turn-1",
      childThreadId: "child-5",
      agentSlug: "helper",
    });

    applyBackgroundRunEvent(actions, THREAD, started);
    applyBackgroundRunEvent(actions, THREAD, started);

    const blocks = actions.turns(THREAD)?.[0]?.blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe(backgroundRunBlockId("child-5"));
  });
});

import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createTurnRunner } from "../turn-runner.js";

describe("createTurnRunner background child registry", () => {
  function runner() {
    return createTurnRunner({
      orchestrator: {
        async runTurn() {
          return {
            userTurnId: "turn-user",
            assistantTurnId: "turn-assistant",
            events: (async function* () {
              yield* [];
            })(),
          };
        },
      },
      eventSink: createInMemoryEventSink(),
      hub: { headSeq: async () => 0n } as never,
      repos: { turns: { findById: async () => null } as never },
    });
  }

  it("keeps background helpers alive on default parent cleanup", () => {
    const childRunner = runner();
    const parentId = "parent-thread";
    const controller = new AbortController();
    childRunner.childRunRegistry.registerBackgroundChild(
      parentId as never,
      "child-thread" as never,
      controller,
    );

    childRunner.childRunRegistry.abortChildrenOf(parentId as never);
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts background helpers when parent cancellation includes background", () => {
    const childRunner = runner();
    const parentId = "parent-thread";
    const controller = new AbortController();
    childRunner.childRunRegistry.registerBackgroundChild(
      parentId as never,
      "child-thread" as never,
      controller,
    );

    childRunner.childRunRegistry.abortChildrenOf(parentId as never, { includeBackground: true });
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts descendants when a child is aborted directly", () => {
    const childRunner = runner();
    const child = new AbortController();
    const grandchild = new AbortController();
    childRunner.childRunRegistry.registerChild(
      "parent-thread" as never,
      "child-thread" as never,
      child,
    );
    childRunner.childRunRegistry.registerBackgroundChild(
      "child-thread" as never,
      "grandchild-thread" as never,
      grandchild,
    );

    childRunner.childRunRegistry.abortChild("child-thread" as never);
    expect(child.signal.aborted).toBe(true);
    expect(grandchild.signal.aborted).toBe(true);
  });

  it("flushes helper results after clearing the running turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flushes: string[] = [];
    const childRunner = createTurnRunner({
      orchestrator: {
        async runTurn() {
          return {
            userTurnId: "turn-user",
            assistantTurnId: "turn-assistant",
            events: (async function* () {
              await gate;
              yield* [];
            })(),
          };
        },
      },
      eventSink: createInMemoryEventSink(),
      hub: { headSeq: async () => 0n } as never,
      repos: { turns: { findById: async () => null } as never },
      helperResultDelivery: { flush: async (threadId) => void flushes.push(threadId as string) },
    });

    const started = await childRunner.startTurn({
      threadId: "parent-thread" as never,
      userText: "parent",
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started.assistantTurnId).toBe("turn-assistant");
    expect(flushes).toContain("parent-thread");
  });

  it("aborts background helpers when an active parent turn is cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const background = new AbortController();
    const childRunner = createTurnRunner({
      orchestrator: {
        async runTurn() {
          return {
            userTurnId: "turn-user",
            assistantTurnId: "turn-assistant",
            events: (async function* () {
              await gate;
              yield* [];
            })(),
          };
        },
      },
      eventSink: createInMemoryEventSink(),
      hub: { headSeq: async () => 0n } as never,
      repos: { turns: { findById: async () => null } as never },
    });

    childRunner.childRunRegistry.registerBackgroundChild(
      "parent-thread" as never,
      "child-thread" as never,
      background,
    );

    const started = childRunner.startTurn({ threadId: "parent-thread", userText: "parent" });
    const { assistantTurnId } = await started;
    const cancelled = await childRunner.cancel("parent-thread" as never, assistantTurnId as never);
    expect(cancelled).toBe("cancelled");
    expect(background.signal.aborted).toBe(true);
    release();
    await started;
  });
});

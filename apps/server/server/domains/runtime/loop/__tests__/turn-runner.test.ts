import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../../observability/index.js";

import { createTurnRunner } from "../turn-runner.js";

async function* emptyEvents() {
  // Empty async generator for turn-runner tests.
}

describe("createTurnRunner", () => {
  it("reserves a thread before orchestrator setup completes", async () => {
    let releaseRunTurn!: () => void;
    const runTurnGate = new Promise<void>((resolve) => {
      releaseRunTurn = resolve;
    });
    let runTurnCalls = 0;
    const runner = createTurnRunner({
      orchestrator: {
        async runTurn() {
          runTurnCalls += 1;
          await runTurnGate;
          return {
            userTurnId: "turn-user",
            assistantTurnId: "turn-assistant",
            events: emptyEvents(),
          };
        },
      },
      eventSink: createInMemoryEventSink(),
      hub: {
        headSeq: async () => 0n,
      } as never,
      repos: {
        turns: {
          findById: async () => null,
        } as never,
      },
    });

    const first = runner.startTurn({ threadId: "thread-1", userText: "first" });
    await expect(runner.startTurn({ threadId: "thread-1", userText: "second" })).rejects.toThrow(
      "Turn already running for thread: thread-1",
    );

    releaseRunTurn();
    await expect(first).resolves.toMatchObject({ assistantTurnId: "turn-assistant" });
    expect(runTurnCalls).toBe(1);
  });

  it("does not abort background children during parent turn cleanup", async () => {
    const runner = createTurnRunner({
      orchestrator: {
        async runTurn() {
          return {
            userTurnId: "turn-user",
            assistantTurnId: "turn-assistant",
            events: emptyEvents(),
          };
        },
      },
      eventSink: createInMemoryEventSink(),
      hub: {
        headSeq: async () => 0n,
      } as never,
      repos: {
        turns: {
          findById: async () => null,
        } as never,
      },
    });
    const foreground = new AbortController();
    const background = new AbortController();

    runner.childRunRegistry.registerChild("parent-thread", "foreground-child", foreground);
    runner.childRunRegistry.registerBackgroundChild(
      "parent-thread" as never,
      "background-child" as never,
      background,
    );

    await runner.startTurn({ threadId: "parent-thread", userText: "parent" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(foreground.signal.aborted).toBe(true);
    expect(background.signal.aborted).toBe(false);
  });
});

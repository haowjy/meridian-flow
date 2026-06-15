import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../../observability/index.js";

import { createTurnRunner, StaleConnectionTokenError } from "../turn-runner.js";

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

  it("cancels only turns owned by the disconnecting connection token", async () => {
    let runSignal: AbortSignal | undefined;
    const runner = createTurnRunner({
      orchestrator: {
        async runTurn({ signal }) {
          runSignal = signal;
          return {
            userTurnId: "turn-user",
            assistantTurnId: "turn-assistant",
            events: (async function* hangForever() {
              await new Promise(() => {});
            })(),
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

    runner.registerLiveConnectionToken("token-a");
    void runner.startTurn({
      threadId: "thread-owned",
      userText: "owned",
      connectionToken: "token-a",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runner.getRunningTurnId("thread-owned")).toBe("turn-assistant");

    runner.cancelTurnsOwnedByConnectionToken("token-b");
    expect(runSignal?.aborted).toBe(false);

    runner.cancelTurnsOwnedByConnectionToken("token-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runSignal?.aborted).toBe(true);
  });

  it("refuses to start a turn when the connection token closed before startTurn", async () => {
    let runTurnCalled = false;
    const runner = createTurnRunner({
      orchestrator: {
        async runTurn() {
          runTurnCalled = true;
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

    runner.registerLiveConnectionToken("token-stale");
    runner.unregisterLiveConnectionToken("token-stale");

    await expect(
      runner.startTurn({
        threadId: "thread-stale",
        userText: "late",
        connectionToken: "token-stale",
      }),
    ).rejects.toBeInstanceOf(StaleConnectionTokenError);
    expect(runTurnCalled).toBe(false);
    expect(runner.getRunningTurnId("thread-stale")).toBeNull();
  });
});

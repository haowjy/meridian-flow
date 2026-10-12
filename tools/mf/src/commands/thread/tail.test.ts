/** Tail confirms snapshot outcomes without dropping queued failures or presentation state. */
import type { AGUIEvent } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { startFakeStack, THREAD_ID } from "../../test-support/fake-stack";

it.each([
  "error",
  "cancelled",
] as const)("reconciles %s after an inbox checkpoint before the terminal event", async (status) => {
  const stack = await startFakeStack();
  try {
    stack.turns.push({ id: "A", role: "assistant", status: "streaming", error: null, text: "" });
    const tail = stack.mf([
      "thread",
      "tail",
      THREAD_ID,
      "--until-idle",
      "--timeout",
      "1s",
      "--json",
    ]);
    while (!stack.socketCount()) await new Promise((resolve) => setTimeout(resolve, 1));
    for (const turn of stack.turns) turn.status = status;
    stack.publish({
      type: "CUSTOM",
      name: "meridian.inbox.changed",
      value: { items: [] },
    } as AGUIEvent);
    stack.publish(
      status === "error"
        ? ({ type: "RUN_ERROR", message: "boom" } as AGUIEvent)
        : ({ type: "RUN_FINISHED", threadId: THREAD_ID, runId: "A" } as AGUIEvent),
    );
    const result = await tail;
    expect(result.code).toBe(status === "error" ? 1 : 5);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      outcome: status === "error" ? "failed" : "cancelled",
      turns: [{ turnId: "A", status }],
    });
    expect(
      records.some(
        (record) => record.type === (status === "error" ? "turn.failed" : "turn.finished"),
      ),
    ).toBe(true);
  } finally {
    await stack.close();
  }
});

it("covers every turn in batched catch-up and reports failure even after a later cancellation", async () => {
  const stack = await startFakeStack();
  try {
    stack.turns.push({ id: "A", role: "assistant", status: "streaming", error: null, text: "" });
    stack.publish({ type: "RUN_STARTED", threadId: THREAD_ID, runId: "A" } as AGUIEvent);
    stack.publish({
      type: "CUSTOM",
      name: "meridian.inbox.changed",
      value: { items: [] },
    } as AGUIEvent);
    stack.publish({ type: "RUN_ERROR", message: "boom" } as AGUIEvent);
    stack.turns.push({ id: "B", role: "assistant", status: "cancelled", error: null, text: "" });
    stack.publish({ type: "RUN_STARTED", threadId: THREAD_ID, runId: "B" } as AGUIEvent);
    stack.publish({ type: "RUN_FINISHED", threadId: THREAD_ID, runId: "B" } as AGUIEvent);
    const tail = stack.mf([
      "thread",
      "tail",
      THREAD_ID,
      "--since",
      "0",
      "--until-idle",
      "--timeout",
      "1s",
      "--json",
    ]);
    while (!stack.socketCount()) await new Promise((resolve) => setTimeout(resolve, 1));
    const first = stack.turns.find((turn) => turn.id === "A");
    if (first) first.status = "error";
    const result = await tail;
    expect(result.code).toBe(1);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      outcome: "failed",
      turns: [
        { turnId: "A", status: "error" },
        { turnId: "B", status: "cancelled" },
      ],
    });
    expect(records.map((record) => record.type)).toContain("turn.failed");
  } finally {
    await stack.close();
  }
});

it.each([
  "missing",
  "streaming",
] as const)("never proves a named %s turn complete", async (status) => {
  const stack = await startFakeStack();
  try {
    stack.turns.push({ id: "A", role: "assistant", status: "streaming", error: null, text: "" });
    const tail = stack.mf([
      "thread",
      "tail",
      THREAD_ID,
      "--until-idle",
      "--timeout",
      "1s",
      "--json",
    ]);
    while (!stack.socketCount()) await new Promise((resolve) => setTimeout(resolve, 1));
    stack.snapshotPolicy.running = false;
    if (status === "missing") stack.turns.splice(0);
    stack.publish({ type: "RUN_FINISHED", threadId: THREAD_ID, runId: "A" } as AGUIEvent);
    const result = await tail;
    expect(result.code).toBe(6);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      outcome: "unproven",
      reason: "unconfirmed",
      turns: [{ turnId: "A", status }],
    });
  } finally {
    await stack.close();
  }
});

it("caps a slow initial snapshot at the remaining command deadline", async () => {
  const stack = await startFakeStack();
  try {
    stack.snapshotPolicy.delayMs = 500;
    const started = Date.now();
    const result = await stack.mf([
      "thread",
      "tail",
      THREAD_ID,
      "--until-idle",
      "--timeout",
      "40ms",
      "--json",
    ]);
    expect(result.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(300);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "timeout",
      snapshotUnavailable: true,
    });
  } finally {
    await stack.close();
  }
});

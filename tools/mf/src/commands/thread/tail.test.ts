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
      name: "meridian.run_state",
      value: {
        version: "9999",
        items: [],
        sentThrough: 0,
        execution: null,
        mode: "direct",
        blocked: null,
      },
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
      name: "meridian.run_state",
      value: {
        version: "9999",
        items: [],
        sentThrough: 0,
        execution: null,
        mode: "direct",
        blocked: null,
      },
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
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      outcome: "timeout",
      reason: "unconfirmed",
      snapshotUnavailable: true,
      next: [`./mf thread tail ${THREAD_ID} --until-idle`],
    });
    expect(report).not.toHaveProperty("stillRunning");
    expect(report).not.toHaveProperty("owed");
  } finally {
    await stack.close();
  }
});

it.each([
  "tool",
  "text",
] as const)("preserves %s presentation across a checkpoint on one socket", async (kind) => {
  const stack = await startFakeStack();
  try {
    const turn = {
      id: "A",
      role: "assistant" as const,
      status: "streaming",
      error: null,
      text: "",
    };
    stack.turns.push(turn);
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
    const publish = (event: unknown) => stack.publish(event as AGUIEvent);
    publish({ type: "RUN_STARTED", threadId: THREAD_ID, runId: "A" });
    if (kind === "tool") {
      publish({ type: "TOOL_CALL_START", toolCallId: "write-1", toolCallName: "doc_write" });
      publish({ type: "TOOL_CALL_ARGS", toolCallId: "write-1", delta: '{"uri":"kb://notes.md"}' });
      publish({
        type: "TOOL_CALL_RESULT",
        toolCallId: "write-1",
        messageId: "staged",
        content: "staged",
      });
    } else {
      publish({ type: "TEXT_MESSAGE_START", messageId: "A::0", role: "assistant" });
      publish({ type: "TEXT_MESSAGE_CONTENT", messageId: "A::0", delta: "Hello " });
    }
    const closing = (version: string) =>
      publish({
        type: "CUSTOM",
        name: "meridian.run_state",
        value: {
          version,
          items: [],
          sentThrough: 0,
          execution: null,
          mode: "direct",
          blocked: null,
        },
      });
    closing("9999");
    while (stack.snapshotReads() < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    if (kind === "tool")
      publish({
        type: "TOOL_CALL_RESULT",
        toolCallId: "write-1",
        messageId: "committed",
        content: "committed",
      });
    else {
      publish({ type: "TEXT_MESSAGE_CONTENT", messageId: "A::0", delta: "there" });
      publish({ type: "TEXT_MESSAGE_END", messageId: "A::0" });
    }
    turn.status = "complete";
    if (kind === "text") turn.text = "Hello there";
    publish({ type: "RUN_FINISHED", threadId: THREAD_ID, runId: "A" });
    // The closing record follows the turn's end in the same commit; it is what tail looks at.
    closing("10000");
    const result = await tail;
    expect(result.code).toBe(0);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (kind === "tool")
      expect(records).toContainEqual(
        expect.objectContaining({
          type: "tool.settled",
          name: "doc_write",
          args: '{"uri":"kb://notes.md"}',
          result: "committed",
        }),
      );
    else
      expect(records.find((record) => record.type === "message.completed")).toMatchObject({
        text: "Hello there",
      });
    expect(records.at(-1)).toMatchObject({ liveView: "matches" });
    expect(stack.socketCount()).toBe(1);
  } finally {
    await stack.close();
  }
});

it.each([
  {
    name: "lost start with retained error",
    gap: true,
    failure: true,
    code: 1,
    outcome: "failed",
    reason: null,
  },
  {
    name: "gap without a failure",
    gap: true,
    failure: false,
    code: 6,
    outcome: "unproven",
    reason: "replay_truncated",
  },
  {
    name: "unattributed error without a mapped start",
    gap: false,
    failure: true,
    code: 1,
    outcome: "failed",
    reason: null,
  },
])("counts $name without inventing covered membership", async ({
  gap,
  failure,
  code,
  outcome,
  reason,
}) => {
  const stack = await startFakeStack();
  try {
    const first = {
      id: "A",
      role: "assistant" as const,
      status: "streaming",
      error: null,
      text: "",
    };
    stack.turns.push(first, {
      id: "B",
      role: "assistant",
      status: failure ? "error" : "complete",
      error: failure ? "B failed" : null,
      text: "",
    });
    if (gap) {
      stack.publish({ type: "RUN_STARTED", threadId: THREAD_ID, runId: "B" } as AGUIEvent);
      stack.socketPolicy.replayFloor = "1";
    }
    if (failure) stack.publish({ type: "RUN_ERROR", message: "B failed" } as AGUIEvent);
    // The initial HTTP snapshot sees A running; subscription replay sees idle.
    // B's start is either absent or below the retention floor.
    stack.server.once("upgrade", () => {
      first.status = "complete";
    });
    const result = await stack.mf([
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
    expect(result.code).toBe(code);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.some((record) => record.type === "gap")).toBe(gap);
    expect(records.some((record) => record.type === "turn.failed")).toBe(failure);
    expect(records.some((record) => record.type === "turn.started")).toBe(false);
    expect(records.at(-1)).toMatchObject({
      type: "result",
      command: "thread.tail",
      outcome,
      reason,
      idle: true,
      turns: [{ turnId: "A", status: "complete" }],
      // A replay gap leaves nothing fair to compare.
      ...(gap ? { liveView: "not_observed" } : {}),
    });
  } finally {
    await stack.close();
  }
});

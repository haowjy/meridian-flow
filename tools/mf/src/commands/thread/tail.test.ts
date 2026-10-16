/** Tail confirms snapshot outcomes without dropping queued failures or presentation state. */
import { EventType } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import { startWire, type Wire } from "../../test-support/wire";
import {
  frames,
  inboxItem,
  ndjson,
  openReply,
  publishRecord,
  replyTurn,
  snapshotOf,
  THREAD_ID,
  userTurn,
} from "../../test-support/wire-fixtures";

let wire: Wire;
beforeEach(async () => {
  wire = await startWire();
});
afterEach(() => wire.close());

const tail = (...args: string[]) => wire.mf(["thread", "tail", THREAD_ID, ...args]);
const lastRecord = (stdout: string) => ndjson(stdout).at(-1);

describe("tail --until-idle", () => {
  it.each([
    "error",
    "cancelled",
  ] as const)("reconciles %s after an inbox checkpoint before the terminal event", async (status) => {
    wire.snapshot = openReply("A");
    wire.play(async () => {
      await wire.until(() => wire.subscriptions >= 1);
      wire.snapshot = () =>
        snapshotOf({ seq: wire.head, turns: [replyTurn("A", 1, { status, error: null })] });
      publishRecord(wire);
      wire.publish(status === "error" ? frames.failed("boom") : frames.finished("A"));
    });
    const result = await tail("--until-idle", "--timeout", "1s", "--json");
    expect(result.code).toBe(status === "error" ? EXIT.failed : EXIT.cancelled);
    expect(lastRecord(result.stdout)).toMatchObject({
      outcome: status === "error" ? "failed" : "cancelled",
      turns: [{ turnId: "A", status }],
    });
    expect(
      ndjson(result.stdout).some(
        (record) => record.type === (status === "error" ? "turn.failed" : "turn.finished"),
      ),
    ).toBe(true);
  });

  it("covers every turn in batched catch-up and reports failure even after a later cancellation", async () => {
    wire.publish(frames.started("A"));
    publishRecord(wire);
    wire.publish(frames.failed("boom"));
    wire.publish(frames.started("B"));
    wire.publish(frames.finished("B"));
    const cancelledB = replyTurn("B", 2, { status: "cancelled" });
    wire.snapshot = (read) =>
      read === 1
        ? snapshotOf({
            seq: 5,
            turns: [replyTurn("A", 1, { status: "streaming" }), cancelledB],
            record: { execution: { executionId: "exec-A", currentTurnId: "A" } },
          })
        : snapshotOf({
            seq: 5,
            turns: [replyTurn("A", 1, { status: "error", error: "boom" }), cancelledB],
          });
    const result = await tail("--since", "0", "--until-idle", "--timeout", "1s", "--json");
    expect(result.code).toBe(EXIT.failed);
    expect(lastRecord(result.stdout)).toMatchObject({
      outcome: "failed",
      turns: [
        { turnId: "A", status: "error" },
        { turnId: "B", status: "cancelled" },
      ],
    });
    expect(ndjson(result.stdout).map((record) => record.type)).toContain("turn.failed");
  });

  it.each([
    "missing",
    "streaming",
  ] as const)("never proves a named %s turn complete", async (status) => {
    wire.snapshot = openReply("A");
    wire.play(async () => {
      await wire.until(() => wire.subscriptions >= 1);
      wire.snapshot = () =>
        snapshotOf({
          seq: wire.head,
          turns: status === "missing" ? [] : [replyTurn("A", 1, { status: "streaming" })],
        });
      wire.publish(frames.finished("A"));
      publishRecord(wire);
    });
    const result = await tail("--until-idle", "--timeout", "30s", "--json");
    expect(result.code).toBe(EXIT.unproven);
    expect(lastRecord(result.stdout)).toMatchObject({
      outcome: "unproven",
      reason: "unconfirmed",
      turns: [{ turnId: "A", status }],
    });
  });

  it("caps a slow initial snapshot at the remaining command deadline", async () => {
    wire.fail("snapshot", { delayMs: 500 }, Number.POSITIVE_INFINITY);
    const started = Date.now();
    const result = await tail("--until-idle", "--timeout", "40ms", "--json");
    expect(result.code).toBe(EXIT.timeout);
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
  });

  it.each([
    "tool",
    "text",
  ] as const)("preserves %s presentation across a checkpoint on one socket", async (kind) => {
    const final = (seq: number) =>
      snapshotOf({
        seq,
        turns: [replyTurn("A", 1, kind === "text" ? { text: "Hello there" } : {})],
      });
    // Reads: the initial one and the checkpoint's still show A open; the third shows it done.
    wire.snapshot = (read) => (read < 3 ? openReply("A", wire.head) : final(wire.head));
    wire.play(async () => {
      await wire.until(() => wire.subscriptions >= 1);
      wire.publish(frames.started("A"));
      if (kind === "tool") {
        for (const event of frames.toolCall(
          "write-1",
          "doc_write",
          '{"uri":"kb://notes.md"}',
          "staged",
        ))
          wire.publish(event);
      } else for (const event of frames.text("A", "Hello ").slice(0, 2)) wire.publish(event);
      publishRecord(wire);
      await wire.until(() => wire.reads >= 2);
      if (kind === "tool") wire.publish(frames.toolResult("write-1", "committed"));
      else for (const event of frames.text("A", "there").slice(1)) wire.publish(event);
      wire.publish(frames.finished("A"));
      publishRecord(wire);
    });
    const result = await tail("--until-idle", "--timeout", "1s", "--json");
    expect(result.code).toBe(EXIT.ok);
    const records = ndjson(result.stdout);
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
    expect(wire.connections).toBe(1);
  });

  it.each([
    {
      name: "lost start with retained error",
      gap: true,
      failure: true,
      code: EXIT.failed,
      outcome: "failed",
      reason: null,
    },
    {
      name: "gap without a failure",
      gap: true,
      failure: false,
      code: EXIT.unproven,
      outcome: "unproven",
      reason: "replay_truncated",
    },
    {
      name: "unattributed error without a mapped start",
      gap: false,
      failure: true,
      code: EXIT.failed,
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
    if (gap) wire.publish(frames.started("B"));
    if (failure) wire.publish(frames.failed("B failed"));
    // The journal's retention starts at seq 1: a cursor below it is told what was skipped.
    if (gap)
      wire.onSubscribe = (cursor) =>
        BigInt(cursor.lastSeq) < 1n
          ? {
              type: "gap",
              threadId: THREAD_ID,
              cause: "replay_limit_exceeded",
              fromSeq: cursor.lastSeq,
              toSeq: "1",
            }
          : undefined;
    const B = replyTurn("B", 2, failure ? { status: "error", error: "B failed" } : {});
    // The initial read sees A open; the subscription and every later read see the chat idle.
    wire.snapshot = (read) =>
      read === 1
        ? snapshotOf({
            seq: wire.head,
            turns: [replyTurn("A", 1, { status: "streaming" }), B],
            record: { execution: { executionId: "exec-A", currentTurnId: "A" } },
          })
        : snapshotOf({ seq: wire.head, turns: [replyTurn("A", 1), B] });
    const result = await tail("--since", "0", "--until-idle", "--timeout", "1s", "--json");
    expect(result.code).toBe(code);
    const records = ndjson(result.stdout);
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
  });
});

describe("thread tail --until-idle", () => {
  it("follows both consecutive replies before confirming idle", async () => {
    // One execution answers the message in two replies; the record between them still owes it.
    wire.publish(frames.started("reply-first"));
    wire.publish(frames.finished("reply-first"));
    publishRecord(wire, { items: [inboxItem("u1", 1)], sentThrough: 1 });
    wire.publish(frames.started("reply-second"));
    wire.publish(frames.finished("reply-second"));
    publishRecord(wire, { sentThrough: 1 });
    const done = [
      replyTurn("reply-first", 1, { executionId: "exec-1" }),
      userTurn("u1", 2, "steer", "reply-second"),
      replyTurn("reply-second", 3, { executionId: "exec-1" }),
    ];
    wire.snapshot = (read) =>
      read === 1
        ? snapshotOf({
            turns: [
              replyTurn("reply-first", 1, { executionId: "exec-1", status: "streaming" }),
              userTurn("u1", 2, "steer", "reply-second"),
              replyTurn("reply-second", 3, { executionId: "exec-1", status: "pending" }),
            ],
            record: {
              items: [inboxItem("u1", 1)],
              sentThrough: 1,
              execution: { executionId: "exec-1", currentTurnId: "reply-first" },
            },
          })
        : snapshotOf({ seq: wire.head, turns: done, record: { sentThrough: 1 } });
    const result = await tail("--since", "0", "--until-idle", "--timeout", "1s", "--json");
    expect(result.code).toBe(EXIT.ok);
    const records = ndjson(result.stdout);
    expect(
      records.filter((record) => record.type === "turn.finished").map((record) => record.turnId),
    ).toEqual(["reply-first", "reply-second"]);
    expect(records.at(-1)).toMatchObject({
      type: "result",
      command: "thread.tail",
      outcome: "complete",
      reason: null,
      turnId: "reply-second",
    });
  });

  it("confirms the lease release after a turn finishes, not the turn alone", async () => {
    wire.snapshot = openReply("a1");
    wire.play(async () => {
      await wire.until(() => wire.subscriptions >= 1);
      // The turn is done and the record idle, but the lease is still awake.
      wire.snapshot = () =>
        snapshotOf({ seq: wire.head, awake: true, turns: [replyTurn("a1", 1, { text: "Hi" })] });
      wire.publish(frames.started("a1"));
      wire.publish(frames.finished("a1"));
      publishRecord(wire);
      await new Promise((resolve) => setTimeout(resolve, 40));
      wire.snapshot = () =>
        snapshotOf({ seq: wire.head, turns: [replyTurn("a1", 1, { text: "Hi" })] });
      wire.publish({
        type: EventType.CUSTOM,
        name: "meridian.thread.status",
        value: { status: { kind: "asleep" }, runningTurnId: null },
      });
    });
    const result = await tail("--until-idle", "--timeout", "1s", "--json");
    expect(result.code).toBe(EXIT.ok);
    const records = ndjson(result.stdout);
    expect(records).toContainEqual(
      expect.objectContaining({ type: "event", name: "meridian.thread.status" }),
    );
    expect(records.at(-1)).toMatchObject({ outcome: "complete", reason: null, turnId: "a1" });
  });

  it("returns immediately on an already-idle chat", async () => {
    const result = await tail("--until-idle", "--timeout", "100ms", "--json");
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "result",
      command: "thread.tail",
      outcome: "complete",
      reason: null,
      threadId: THREAD_ID,
      turnId: null,
      turns: [],
      idle: true,
    });
    expect(result.stderr).toBe("");
    const text = await tail("--until-idle");
    expect(text.code).toBe(EXIT.ok);
    expect(text.stdout).toBe("");
    expect(text.stderr).toBe("complete: chat idle, no turn ran during the wait\n");
    expect(wire.subscriptions).toBe(0);
  });

  it("reports a final timeout snapshot without stopping the run", async () => {
    wire.snapshot = openReply("a1");
    const result = await tail("--until-idle", "--timeout", "100ms", "--json");
    expect(result.code).toBe(EXIT.timeout);
    expect(lastRecord(result.stdout)).toMatchObject({
      type: "result",
      command: "thread.tail",
      outcome: "timeout",
      reason: "running",
      stillRunning: { status: "streaming" },
    });
    expect(wire.requestsOf("stop")).toHaveLength(0);
    expect(wire.requestsOf("cancel")).toHaveLength(0);
  });

  it("times out with an awake lease after an orphan error and empty inbox", async () => {
    wire.publish(frames.failed("orphaned"));
    publishRecord(wire, { version: "9999" });
    wire.snapshot = snapshotOf({
      seq: 2,
      awake: true,
      turns: [replyTurn("orphan-turn", 1, { status: "error", error: "orphaned" })],
    });
    const result = await tail("--since", "0", "--until-idle", "--timeout", "100ms", "--json");
    expect(result.code).toBe(EXIT.timeout);
    const records = ndjson(result.stdout);
    expect(records).toContainEqual(expect.objectContaining({ type: "turn.failed" }));
    expect(records).toContainEqual(
      expect.objectContaining({ type: "event", name: "meridian.run_state" }),
    );
    expect(records.at(-1)).toMatchObject({
      outcome: "timeout",
      reason: "lease_awake",
      stillRunning: null,
      owed: [],
      snapshotStale: true,
      next: [`./mf thread tail ${THREAD_ID} --until-idle`],
    });
    const text = await tail("--until-idle", "--timeout", "100ms");
    expect(text.code).toBe(EXIT.timeout);
    expect(text.stderr).toContain(
      "timeout: last snapshot showed no running turn or owed message, but the chat was awake; idle is unconfirmed",
    );
  });
});

/** Tail confirms snapshot outcomes without dropping queued failures or presentation state. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import { startWire, type Wire } from "../../test-support/wire";
import {
  frames,
  ndjson,
  openReply,
  publishRecord,
  replyTurn,
  snapshotOf,
  THREAD_ID,
} from "../../test-support/wire-fixtures";

let wire: Wire;
beforeEach(async () => {
  wire = await startWire();
});
afterEach(() => wire.close());

const tail = (...args: string[]) => wire.mf(["thread", "tail", THREAD_ID, ...args]);
const lastRecord = (stdout: string) => ndjson(stdout).at(-1);

describe("tail --until-idle", () => {
  it("covers every turn in batched catch-up and reports failure even after a later cancellation", async () => {
    wire.publish(frames.started("A"));
    publishRecord(wire);
    wire.publish(frames.failed("boom"));
    wire.publish(frames.started("B"));
    wire.publish(frames.finished("B"));
    const cancelledB = replyTurn("B", 2, { status: "cancelled" });
    // The first read, taken before the evidence frames, sees A open; the join's catch-up delivers
    // the frames above its cursor, and every later read sees the chat idle.
    wire.snapshot = (read) =>
      read === 1
        ? snapshotOf({
            seq: 0,
            turns: [replyTurn("A", 1, { status: "streaming" })],
            record: { execution: { executionId: "exec-A", currentTurnId: "A" } },
          })
        : snapshotOf({
            seq: 5,
            turns: [replyTurn("A", 1, { status: "error", error: "boom" }), cancelledB],
          });
    const result = await tail("--until-idle", "--timeout", "1s", "--json");
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

  it("never proves a named turn complete when the read lacks it", async () => {
    wire.snapshot = openReply("A");
    wire.play(async () => {
      await wire.until(() => wire.subscriptions >= 1);
      wire.snapshot = () =>
        snapshotOf({
          seq: wire.head,
          turns: [],
        });
      wire.publish(frames.finished("A"));
      publishRecord(wire);
    });
    const result = await tail("--until-idle", "--timeout", "30s", "--json");
    expect(result.code).toBe(EXIT.unproven);
    expect(lastRecord(result.stdout)).toMatchObject({
      outcome: "unproven",
      reason: "unconfirmed",
      turns: [{ turnId: "A", status: "missing" }],
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
  ])("counts $name with membership from the proving read", async ({
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
              requestId: cursor.requestId,
              threadId: THREAD_ID,
              cause: "replay_limit_exceeded",
              fromSeq: cursor.lastSeq,
              toSeq: "1",
            }
          : undefined;
    const B = replyTurn("B", 2, failure ? { status: "error", error: "B failed" } : {});
    // The first read, taken before the evidence, sees A open; every later read sees the chat idle.
    wire.snapshot = (read) =>
      read === 1
        ? snapshotOf({
            seq: 0,
            turns: [replyTurn("A", 1, { status: "streaming" })],
            record: { execution: { executionId: "exec-A", currentTurnId: "A" } },
          })
        : snapshotOf({ seq: wire.head, turns: [replyTurn("A", 1), B] });
    const result = await tail("--until-idle", "--timeout", "1s", "--json");
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
      turns: [
        { turnId: "A", status: "complete" },
        { turnId: "B", status: failure ? "error" : "complete" },
      ],
      // A replay gap leaves nothing fair to compare.
      ...(gap ? { liveView: "not_observed" } : {}),
    });
  });
});

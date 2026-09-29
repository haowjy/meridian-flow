/** Optimistic queued commands merged with the server inbox, and withdrawal outcomes. */
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  type ControlAction,
  controlsReducer,
  type LocalControl,
  mergeQueuedControls,
  placeQueuedControls,
  type QueuedControl,
} from "./thread-controls";

const COMPACT = { kind: "compact" } as const;

function run(actions: ControlAction[], start: readonly LocalControl[] = []) {
  return actions.reduce(controlsReducer, start);
}

function inboxItem(
  id: string,
  control: PendingInboxItem["control"] = COMPACT,
  seq = 1,
): PendingInboxItem {
  return {
    id,
    seq,
    intent: "control",
    control,
    provenance: { kind: "writer", actorId: "writer" },
    deliveryState: "awaiting_run",
    summary: "Compact conversation",
    enqueuedAt: "2026-09-28T00:00:00.000Z",
  };
}

const EMPTY: ThreadPendingInbox = { items: [] };

function merge(
  local: readonly LocalControl[],
  pending: ThreadPendingInbox = EMPTY,
  options: { executed?: string[]; leaf?: string | null } = {},
) {
  return mergeQueuedControls({
    local,
    pending,
    executedControlIds: new Set(options.executed ?? []),
    leafTurnId: options.leaf ?? "leaf-1",
  }).map(({ id, status }) => ({ id, status }));
}

describe("optimistic enqueue", () => {
  it("shows the control as queued before the server answers", () => {
    const local = run([{ type: "enqueue", id: "k", control: COMPACT, afterTurnId: null }]);
    expect(merge(local)).toEqual([{ id: "k", status: "queued" }]);
  });

  it("is idempotent on a repeated enqueue of the same id", () => {
    const local = run([
      { type: "enqueue", id: "k", control: COMPACT, afterTurnId: null },
      { type: "enqueue", id: "k", control: COMPACT, afterTurnId: null },
    ]);
    expect(local).toHaveLength(1);
  });

  it("keeps an accepted control queued until the inbox echo, then yields to the server row", () => {
    const accepted = run([
      { type: "enqueue", id: "k", control: COMPACT, afterTurnId: null },
      { type: "enqueued", id: "k", pending: inboxItem("k"), turnId: null },
    ]);
    expect(merge(accepted)).toEqual([{ id: "k", status: "queued" }]);
    const echoed = run([{ type: "observe", pendingIds: new Set(["k"]) }], accepted);
    expect(merge(echoed, { items: [inboxItem("k")] })).toEqual([{ id: "k", status: "queued" }]);
    // Consumed by the run: gone from the inbox, and the local entry is done.
    expect(merge(echoed)).toEqual([]);
  });

  it("drops a control a turn already names, even before the inbox echo", () => {
    const accepted = run([
      { type: "enqueue", id: "k", control: COMPACT, afterTurnId: null },
      { type: "enqueued", id: "k", pending: inboxItem("k"), turnId: null },
    ]);
    expect(merge(accepted, EMPTY, { executed: ["k"] })).toEqual([]);
  });

  it("drops a control the server reports as already run", () => {
    const local = run([
      { type: "enqueue", id: "k", control: COMPACT, afterTurnId: null },
      { type: "enqueued", id: "k", pending: null, turnId: "c" },
    ]);
    expect(merge(local)).toEqual([]);
  });

  it("keeps a failed enqueue on the item, and Retry returns it to queued with the same id", () => {
    const failed = run([
      { type: "enqueue", id: "k", control: COMPACT, afterTurnId: null },
      { type: "enqueue_failed", id: "k" },
    ]);
    expect(merge(failed)).toEqual([{ id: "k", status: "failed" }]);
    const retried = run([{ type: "retry", id: "k" }], failed);
    expect(merge(retried)).toEqual([{ id: "k", status: "queued" }]);
    expect(retried[0]?.id).toBe("k");
  });
});

describe("withdrawal", () => {
  const listed = run([
    { type: "enqueue", id: "k", control: COMPACT, afterTurnId: null },
    { type: "enqueued", id: "k", pending: inboxItem("k"), turnId: null },
    { type: "observe", pendingIds: new Set(["k"]) },
  ]);

  it("removes the row at once, before the server answers", () => {
    const withdrawing = run([{ type: "withdraw", id: "k" }], listed);
    expect(merge(withdrawing, { items: [inboxItem("k")] })).toEqual([]);
  });

  it("keeps a withdrawn row gone, even behind a lagging inbox frame", () => {
    const withdrawn = run(
      [
        { type: "withdraw", id: "k" },
        { type: "withdrawn", id: "k", outcome: "withdrawn", leafTurnId: "leaf-1" },
      ],
      listed,
    );
    expect(merge(withdrawn, { items: [inboxItem("k")] })).toEqual([]);
    expect(merge(withdrawn)).toEqual([]);
  });

  it("says a started command already started, until its divider takes over", () => {
    const started = run(
      [
        { type: "withdraw", id: "k" },
        { type: "withdrawn", id: "k", outcome: "already_started", leafTurnId: "leaf-1" },
      ],
      listed,
    );
    expect(merge(started)).toEqual([{ id: "k", status: "already_started" }]);
    expect(merge(started, EMPTY, { executed: ["k"] })).toEqual([]);
    expect(merge(started, EMPTY, { leaf: "leaf-2" })).toEqual([]);
  });

  it("shadows a server-only row so its withdrawal still lands", () => {
    const local = run([{ type: "withdraw", id: "server", control: COMPACT }]);
    expect(merge(local, { items: [inboxItem("server")] })).toEqual([]);
    const failed = run([{ type: "withdraw_failed", id: "server" }], local);
    expect(merge(failed, { items: [inboxItem("server")] })).toEqual([
      { id: "server", status: "withdraw_failed" },
    ]);
  });

  it("brings the row back, withdrawable, after a failed withdrawal", () => {
    const failed = run(
      [
        { type: "withdraw", id: "k" },
        { type: "withdraw_failed", id: "k" },
      ],
      listed,
    );
    expect(merge(failed, { items: [inboxItem("k")] })).toEqual([
      { id: "k", status: "withdraw_failed" },
    ]);
    // It ran meanwhile: gone from the inbox, so nothing is left to withdraw.
    expect(merge(failed)).toEqual([]);
  });
});

describe("server inbox rows", () => {
  it("lists control rows in inbox order and ignores writer messages", () => {
    const message: PendingInboxItem = { ...inboxItem("m"), intent: "message", control: undefined };
    expect(
      merge([], {
        items: [inboxItem("a"), message, inboxItem("b")],
      }),
    ).toEqual([
      { id: "a", status: "queued" },
      { id: "b", status: "queued" },
    ]);
  });
});

describe("queue order", () => {
  const message = (id: string, seq: number): PendingInboxItem => ({
    ...inboxItem(id, undefined, seq),
    intent: "message",
    deliveryState: "waiting",
  });

  it("remembers the writer message each command was sent after, in seq order", () => {
    const pending = {
      items: [
        message("m2", 4),
        inboxItem("c2", COMPACT, 5),
        inboxItem("c1", { kind: "compact", instructions: "Keep the names" }, 2),
        message("m1", 1),
        { ...message("notice", 3), provenance: { kind: "system", source: "work" } } as const,
      ],
    };
    const queued = mergeQueuedControls({
      local: [],
      pending,
      executedControlIds: new Set(),
      leafTurnId: null,
    });
    expect(queued.map(({ id, afterTurnId, control }) => ({ id, afterTurnId, control }))).toEqual([
      { id: "c1", afterTurnId: "m1", control: { kind: "compact", instructions: "Keep the names" } },
      { id: "c2", afterTurnId: "m2", control: COMPACT },
    ]);
  });

  it("keeps a local command's anchor until the inbox lists it", () => {
    const local = run([{ type: "enqueue", id: "k", control: COMPACT, afterTurnId: "m1" }]);
    expect(
      mergeQueuedControls({
        local,
        pending: EMPTY,
        executedControlIds: new Set(),
        leafTurnId: null,
      })[0]?.afterTurnId,
    ).toBe("m1");
  });

  const control = (id: string, afterTurnId: string | null): QueuedControl => ({
    id,
    control: COMPACT,
    status: "queued",
    afterTurnId,
  });
  const slots = (
    controls: QueuedControl[],
    rowTurnIds: (string | null)[],
    queued: string[],
  ): Record<number, string[]> =>
    Object.fromEntries(
      [
        ...placeQueuedControls({
          controls,
          rowTurnIds,
          queuedTurnIds: new Set(queued),
        }),
      ].map(([index, placed]) => [index, placed.map((entry) => entry.id)]),
    );

  it("renders a command right after the queued message it was sent after", () => {
    expect(slots([control("c", "m1")], ["u", "a", "m1", "m2"], ["m1", "m2"])).toEqual({ 3: ["c"] });
  });

  it("leads the queued messages when it was sent before them all", () => {
    expect(slots([control("c", null)], ["u", "a", "m1"], ["m1"])).toEqual({ 2: ["c"] });
  });

  it("ends the transcript when no message waits", () => {
    expect(slots([control("c", null)], ["u", "a"], [])).toEqual({ 2: ["c"] });
  });

  it("falls back to the front of the queue once its message was read", () => {
    // m1 was adopted by the running reply; m2 still waits.
    expect(slots([control("c", "m1")], ["u", "m1", "a", "m2"], ["m2"])).toEqual({ 3: ["c"] });
  });

  it("keeps commands sharing a slot in the order given", () => {
    expect(slots([control("c1", "m1"), control("c2", "m1")], ["u", "a", "m1"], ["m1"])).toEqual({
      3: ["c1", "c2"],
    });
  });

  it("never anchors to an inherited row", () => {
    expect(slots([control("c", "m1")], [null, "a", "m1"], ["m1"])).toEqual({ 3: ["c"] });
  });
});

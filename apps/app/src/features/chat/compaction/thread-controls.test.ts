/** Optimistic queued controls merged with the server inbox, and withdrawal outcomes. */
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  type ControlAction,
  controlsReducer,
  type LocalControl,
  mergeQueuedControls,
} from "./thread-controls";

const COMPACT = { kind: "compact" } as const;

function run(actions: ControlAction[], start: readonly LocalControl[] = []) {
  return actions.reduce(controlsReducer, start);
}

function inboxItem(id: string, control: PendingInboxItem["control"] = COMPACT): PendingInboxItem {
  return {
    id,
    seq: 1,
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
    const local = run([{ type: "enqueue", id: "k", control: COMPACT }]);
    expect(merge(local)).toEqual([{ id: "k", status: "queued" }]);
  });

  it("is idempotent on a repeated enqueue of the same id", () => {
    const local = run([
      { type: "enqueue", id: "k", control: COMPACT },
      { type: "enqueue", id: "k", control: COMPACT },
    ]);
    expect(local).toHaveLength(1);
  });

  it("keeps an accepted control queued until the inbox echo, then yields to the server row", () => {
    const accepted = run([
      { type: "enqueue", id: "k", control: COMPACT },
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
      { type: "enqueue", id: "k", control: COMPACT },
      { type: "enqueued", id: "k", pending: inboxItem("k"), turnId: null },
    ]);
    expect(merge(accepted, EMPTY, { executed: ["k"] })).toEqual([]);
  });

  it("drops a control the server reports as already run", () => {
    const local = run([
      { type: "enqueue", id: "k", control: COMPACT },
      { type: "enqueued", id: "k", pending: null, turnId: "c" },
    ]);
    expect(merge(local)).toEqual([]);
  });

  it("keeps a failed enqueue on the item, and Retry returns it to queued with the same id", () => {
    const failed = run([
      { type: "enqueue", id: "k", control: COMPACT },
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
    { type: "enqueue", id: "k", control: COMPACT },
    { type: "enqueued", id: "k", pending: inboxItem("k"), turnId: null },
    { type: "observe", pendingIds: new Set(["k"]) },
  ]);

  it("shows withdrawing while the request is in flight", () => {
    const withdrawing = run([{ type: "withdraw", id: "k" }], listed);
    expect(merge(withdrawing, { items: [inboxItem("k")] })).toEqual([
      { id: "k", status: "withdrawing" },
    ]);
  });

  it.each([
    "withdrawn",
    "stopping",
    "already_finished",
  ] as const)("lands %s on the item until the transcript moves on", (outcome) => {
    const settled = run(
      [
        { type: "withdraw", id: "k" },
        { type: "withdrawn", id: "k", outcome, leafTurnId: "leaf-1" },
      ],
      listed,
    );
    // Fresher than a lagging inbox frame that still lists the row.
    expect(merge(settled, { items: [inboxItem("k")] })).toEqual([{ id: "k", status: outcome }]);
    expect(merge(settled)).toEqual([{ id: "k", status: outcome }]);
    expect(merge(settled, EMPTY, { leaf: "leaf-2" })).toEqual([]);
  });

  it("hides a stop outcome once the divider it stopped is in the transcript", () => {
    const stopping = run(
      [
        { type: "withdraw", id: "k" },
        { type: "withdrawn", id: "k", outcome: "stopping", leafTurnId: "leaf-1" },
      ],
      listed,
    );
    expect(merge(stopping, EMPTY, { executed: ["k"] })).toEqual([]);
  });

  it("shadows a server-only row so its withdrawal still lands", () => {
    const local = run([{ type: "withdraw", id: "server", control: COMPACT }]);
    expect(merge(local, { items: [inboxItem("server")] })).toEqual([
      { id: "server", status: "withdrawing" },
    ]);
  });

  it("keeps the row withdrawable after a failed withdrawal", () => {
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
  });
});

describe("server inbox rows", () => {
  it("lists control rows in inbox order and ignores writer messages", () => {
    const message: PendingInboxItem = { ...inboxItem("m"), intent: "message", control: undefined };
    expect(
      merge([], {
        items: [
          inboxItem("a"),
          message,
          inboxItem("b", { kind: "compaction_undo", compactionTurnId: "c" }),
        ],
      }),
    ).toEqual([
      { id: "a", status: "queued" },
      { id: "b", status: "queued" },
    ]);
  });
});

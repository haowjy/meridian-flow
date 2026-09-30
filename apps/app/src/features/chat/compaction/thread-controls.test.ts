/** Optimistic queued commands merged with the server inbox, and withdrawal outcomes. */
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  type ControlAction,
  controlsReducer,
  type LocalControls,
  mergeQueuedControls,
  NO_LOCAL_CONTROLS,
} from "./thread-controls";

const COMPACT = { kind: "compact" } as const;

function run(actions: ControlAction[], start: LocalControls = NO_LOCAL_CONTROLS) {
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
  local: LocalControls,
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
    expect(local.sends).toHaveLength(1);
  });

  it("keeps an accepted control queued until the inbox lists it, then drops it for the server row", () => {
    const accepted = run([
      { type: "enqueue", id: "k", control: COMPACT },
      { type: "enqueued", id: "k", pending: inboxItem("k"), turnId: null },
    ]);
    expect(merge(accepted)).toEqual([{ id: "k", status: "queued" }]);
    const echoed = run([{ type: "listed", pendingIds: new Set(["k"]) }], accepted);
    expect(echoed.sends).toEqual([]);
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
    expect(retried.sends[0]?.id).toBe("k");
  });
});

describe("withdrawal", () => {
  const listed = run([
    { type: "enqueue", id: "k", control: COMPACT },
    { type: "enqueued", id: "k", pending: inboxItem("k"), turnId: null },
    { type: "listed", pendingIds: new Set(["k"]) },
  ]);

  it("removes the row at once, before the server answers", () => {
    const withdrawing = run([{ type: "withdraw", id: "k" }], listed);
    expect(merge(withdrawing, { items: [inboxItem("k")] })).toEqual([]);
  });

  it("keeps a withdrawn row gone, even behind a lagging inbox frame", () => {
    const withdrawn = run(
      [
        { type: "withdraw", id: "k" },
        {
          type: "withdrawn",
          id: "k",
          control: COMPACT,
          outcome: "withdrawn",
          leafTurnId: "leaf-1",
        },
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
        {
          type: "withdrawn",
          id: "k",
          control: COMPACT,
          outcome: "already_started",
          leafTurnId: "leaf-1",
        },
      ],
      listed,
    );
    expect(merge(started)).toEqual([{ id: "k", status: "already_started" }]);
    expect(merge(started, EMPTY, { executed: ["k"] })).toEqual([]);
    expect(merge(started, EMPTY, { leaf: "leaf-2" })).toEqual([]);
  });

  it("hides a server-only row while its withdrawal is out", () => {
    const local = run([{ type: "withdraw", id: "server" }]);
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
  it("hides a failed enqueue the writer withdrew, even when a later frame lists it", () => {
    const withdrawn = run([
      { type: "enqueue", id: "k", control: COMPACT },
      { type: "enqueue_failed", id: "k" },
      { type: "withdraw", id: "k" },
      { type: "withdrawn", id: "k", control: COMPACT, outcome: "withdrawn", leafTurnId: "leaf-1" },
    ]);
    expect(merge(withdrawn)).toEqual([]);
    const listed = run([{ type: "listed", pendingIds: new Set(["k"]) }], withdrawn);
    expect(merge(listed, { items: [inboxItem("k")] })).toEqual([]);
  });

  it("keeps a failed enqueue's row, retryable, after its withdrawal fails", () => {
    const failed = run([
      { type: "enqueue", id: "k", control: COMPACT },
      { type: "enqueue_failed", id: "k" },
      { type: "withdraw", id: "k" },
      { type: "withdraw_failed", id: "k" },
    ]);
    expect(merge(failed)).toEqual([{ id: "k", status: "failed" }]);
  });
});

describe("server inbox rows", () => {
  it("lists control rows in inbox order and ignores writer messages", () => {
    const message: PendingInboxItem = { ...inboxItem("m"), intent: "message", control: undefined };
    expect(
      merge(NO_LOCAL_CONTROLS, {
        items: [inboxItem("a"), message, inboxItem("b")],
      }),
    ).toEqual([
      { id: "a", status: "queued" },
      { id: "b", status: "queued" },
    ]);
  });
});

describe("queue order", () => {
  it("lists commands oldest first, skipping messages, with their instructions", () => {
    const message = { ...inboxItem("m1", undefined, 2), intent: "message" } as const;
    const queued = mergeQueuedControls({
      local: NO_LOCAL_CONTROLS,
      pending: {
        items: [
          inboxItem("c1", { kind: "compact", instructions: "Keep the names" }, 1),
          message,
          inboxItem("c2", COMPACT, 3),
        ],
      },
      executedControlIds: new Set(),
      leafTurnId: null,
    });
    expect(queued.map(({ id, control }) => ({ id, control }))).toEqual([
      { id: "c1", control: { kind: "compact", instructions: "Keep the names" } },
      { id: "c2", control: COMPACT },
    ]);
  });
});

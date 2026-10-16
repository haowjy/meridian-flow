/** The synced thread's freshness and admission rules, on the pure transitions. */
import type { Block, JsonValue, Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  acceptDurableBlockSeq,
  acceptsSnapshot,
  acknowledgeAdmission,
  appendLocalUserTurn,
  applyRead,
  EMPTY_SYNCED_THREAD,
  removeTurns,
  type SyncedThread,
  syncedTurnStore,
} from "./synced-thread";

function customBlock(props: Record<string, JsonValue>): Block {
  return {
    id: "card-1",
    turnId: "turn-1",
    responseId: null,
    blockType: "custom",
    sequence: 4,
    content: { kind: "helper-result", props },
    status: "complete",
    textContent: null,
    createdAt: "2026-09-23T00:00:00.000Z",
  };
}

function cellOver(initial: SyncedThread = EMPTY_SYNCED_THREAD) {
  let value: SyncedThread | undefined = initial;
  return {
    cell: { get: () => value, set: (_threadId: string, next: SyncedThread) => (value = next) },
    value: () => value as SyncedThread,
  };
}

const localRow = {
  id: "turn_local_1",
  role: "user",
  status: "pending",
  blocks: [],
} as never as Turn;

describe("durable block wire freshness", () => {
  it("keeps the cursor and snapshot floor monotonic beyond safe integers", () => {
    let synced = EMPTY_SYNCED_THREAD;
    const accept = (seq: string) => {
      const next = acceptDurableBlockSeq(synced, seq);
      if (next) synced = next;
      return next !== null;
    };
    const seq = "9007199254740993000";
    expect(accept(seq)).toBe(true);
    expect(accept(seq)).toBe(false);
    expect(accept("9007199254740992999")).toBe(false);
    expect(accept("invalid")).toBe(false);
    expect(acceptsSnapshot(synced, seq)).toBe(false);
    expect(acceptsSnapshot(synced, "9007199254740993001")).toBe(true);
  });

  it("does not let a stale read alter the turns", () => {
    const { cell, value } = cellOver();
    const store = syncedTurnStore({ cell, now: () => "2026-09-23T00:00:00.000Z" });
    store.ensureAssistantTurn("thread-1", "turn-1");
    store.upsertAssistantBlock("thread-1", "turn-1", customBlock({ outcome: "done" }));
    const before = store.turns("thread-1");
    cell.set("thread-1", acceptDurableBlockSeq(value(), "375000") as SyncedThread);
    expect(applyRead(value(), { turns: [], nextSeq: "375000", runningTurnId: null })).toBeNull();
    expect(store.turns("thread-1")).toBe(before);
    expect(value().durableCursor).toBe("375000");
  });
});

it("drops an optimistic row whose admission answer names a message another tab handed back", () => {
  // Risk: a delayed admission answer bringing back a message that already left the chat.
  const when = "2026-09-23T00:00:00.000Z";
  let synced = appendLocalUserTurn(EMPTY_SYNCED_THREAD, localRow);
  synced = removeTurns(synced, ["turn-server-1"], "7000");
  synced = acknowledgeAdmission(synced, localRow.id, "turn-server-1", "6001", when);
  expect(synced.turns).toEqual([]);
  // A read taken before the removal does not bring it back either.
  const stale = applyRead(synced, {
    turns: [{ id: "turn-server-1", role: "user", blocks: [] } as never],
    nextSeq: "6500",
    runningTurnId: null,
  });
  expect(stale?.turns).toEqual([]);

  // A newer read clears the removal's tombstone while the optimistic row still waits for its
  // answer; the late answer must still find the removal.
  let waiting = appendLocalUserTurn(EMPTY_SYNCED_THREAD, localRow);
  waiting = removeTurns(waiting, ["turn-server-2"], "7000");
  waiting = applyRead(waiting, { turns: [], nextSeq: "8000", runningTurnId: null }) as SyncedThread;
  expect(waiting.turns.map((turn) => turn.id)).toEqual([localRow.id]);
  waiting = acknowledgeAdmission(waiting, localRow.id, "turn-server-2", "6001", when);
  expect(waiting.turns).toEqual([]);
});

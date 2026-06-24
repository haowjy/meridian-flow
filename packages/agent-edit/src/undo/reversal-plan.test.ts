// Focused planner tests for retained-log write selection.
import { describe, expect, it } from "vitest";
import type { JournalSnapshot } from "../ports/types.js";
import type {
  ActiveWriteSummary,
  ReversalStore,
  WriteMutationRow,
} from "../ports/update-journal.js";
import { planUndo } from "./reversal-plan.js";

const DOC_ID = "doc-1";
const THREAD_ID = "thread-a";

describe("reversal planner", () => {
  it("drops selected active writes whose mutation seqs are not retained", async () => {
    const store = fakeReversalStore({
      snapshot: snapshotWithSeqs([2]),
      activeWrites: [activeWrite("w1", 1), activeWrite("w2", 2)],
      mutations: new Map([
        ["w1", [mutation("w1", 1, "active")]],
        ["w2", [mutation("w2", 2, "active")]],
      ]),
    });

    const plan = await planUndo({
      reversalStore: store,
      docId: DOC_ID,
      threadId: THREAD_ID,
      selection: { kind: "all" },
    });

    expect(plan).toMatchObject({ ok: true, writeIds: ["w2"] });
    expect(plan.ok && [...plan.targetSeqs]).toEqual([2]);
  });

  it("returns nothing_to_undo when filtering removes every selected write", async () => {
    const store = fakeReversalStore({
      snapshot: snapshotWithSeqs([3]),
      activeWrites: [activeWrite("w1", 1), activeWrite("w2", 2)],
      mutations: new Map([
        ["w1", [mutation("w1", 1, "active")]],
        ["w2", [mutation("w2", 2, "active")]],
      ]),
    });

    await expect(
      planUndo({
        reversalStore: store,
        docId: DOC_ID,
        threadId: THREAD_ID,
        selection: { kind: "all" },
      }),
    ).resolves.toEqual({ ok: false, status: "nothing_to_undo" });
  });
});

function snapshotWithSeqs(seqs: readonly number[]): JournalSnapshot {
  return {
    checkpoint: null,
    updates: seqs.map((seq) => ({
      seq,
      update: new Uint8Array([seq]),
      meta: { origin: "agent:t", seq },
    })),
  };
}

function activeWrite(handle: string, seq: number): ActiveWriteSummary {
  const wId = Number(handle.slice(1));
  return { writeId: handle, handle, wId, turnId: `turn-${seq}`, createdSeq: seq };
}

function mutation(
  handle: string,
  seq: number,
  status: WriteMutationRow["status"],
): WriteMutationRow {
  const wId = Number(handle.slice(1));
  return { writeId: handle, handle, wId, turnId: `turn-${seq}`, createdSeq: seq, status };
}

function fakeReversalStore(input: {
  snapshot: JournalSnapshot;
  activeWrites: ActiveWriteSummary[];
  mutations: Map<string, WriteMutationRow[]>;
}): ReversalStore {
  return {
    reserveWriteOrdinal: async () => 1,
    readForReconstruction: async () => input.snapshot,
    latestActiveWrite: async () => input.activeWrites.at(-1),
    activeWriteSummary: async () => input.activeWrites,
    writeMinCreatedSeq: async (_documentId, _threadId, handle) =>
      input.mutations.get(handle)?.at(0)?.createdSeq,
    mutationsForWrite: async (_documentId, _threadId, handle) => input.mutations.get(handle) ?? [],
    persistUndo: async () => {},
    persistRedo: async () => ({ consumed: false }),
    readReversals: async () => [],
  } satisfies ReversalStore;
}

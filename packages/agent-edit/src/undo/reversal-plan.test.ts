// Focused planner tests for retained-log write selection.
import { describe, expect, it } from "vitest";
import type { JournalSnapshot, ReversalRecord } from "../ports/types.js";
import type {
  ActiveWriteSummary,
  ReversalStore,
  WriteMutationRow,
} from "../ports/update-journal.js";
import { planRedo, planUndo } from "./reversal-plan.js";

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

  it("selects exactly the active writes for a requested turn", async () => {
    const store = fakeReversalStore({
      snapshot: snapshotWithSeqs([1, 2, 3, 4]),
      activeWrites: [
        activeWrite("w1", 1, "turn-earlier"),
        activeWrite("w2", 2, "turn-target"),
        activeWrite("w3", 3, "turn-target"),
        activeWrite("w4", 4, "turn-later"),
      ],
      mutations: new Map([
        ["w1", [mutation("w1", 1, "active", "turn-earlier")]],
        ["w2", [mutation("w2", 2, "active", "turn-target")]],
        ["w3", [mutation("w3", 3, "active", "turn-target")]],
        ["w4", [mutation("w4", 4, "active", "turn-later")]],
      ]),
    });

    const plan = await planUndo({
      reversalStore: store,
      docId: DOC_ID,
      threadId: THREAD_ID,
      selection: { kind: "turn", turnId: "turn-target" },
    });

    expect(plan).toMatchObject({ ok: true, writeIds: ["w2", "w3"], turnId: "turn-target" });
    expect(plan.ok && [...plan.targetSeqs]).toEqual([2, 3]);
  });

  it("omitted turn undo targets the turn of the latest active write by created seq", async () => {
    const store = fakeReversalStore({
      snapshot: snapshotWithSeqs([1, 2, 3]),
      activeWrites: [
        activeWrite("w1", 1, "turn-first"),
        activeWrite("w2", 3, "turn-latest"),
        activeWrite("w3", 2, "turn-middle"),
      ],
      mutations: new Map([
        ["w1", [mutation("w1", 1, "active", "turn-first")]],
        ["w2", [mutation("w2", 3, "active", "turn-latest")]],
        ["w3", [mutation("w3", 2, "active", "turn-middle")]],
      ]),
    });

    const plan = await planUndo({
      reversalStore: store,
      docId: DOC_ID,
      threadId: THREAD_ID,
      selection: { kind: "turn" },
    });

    expect(plan).toMatchObject({ ok: true, writeIds: ["w2"], turnId: "turn-latest" });
  });

  it("returns nothing_to_undo for an empty or already-reversed turn", async () => {
    const store = fakeReversalStore({
      snapshot: snapshotWithSeqs([1, 2]),
      activeWrites: [activeWrite("w1", 1, "turn-active")],
      mutations: new Map([
        ["w1", [mutation("w1", 1, "active", "turn-active")]],
        ["w2", [mutation("w2", 2, "reversed", "turn-reversed", 3)]],
      ]),
    });

    await expect(
      planUndo({
        reversalStore: store,
        docId: DOC_ID,
        threadId: THREAD_ID,
        selection: { kind: "turn", turnId: "turn-reversed" },
      }),
    ).resolves.toEqual({ ok: false, status: "nothing_to_undo" });
  });

  it("selects a reversed turn for redo", async () => {
    const store = fakeReversalStore({
      snapshot: snapshotWithSeqs([1, 2, 3, 4, 5]),
      mutations: new Map([
        ["w1", [mutation("w1", 1, "reversed", "turn-earlier", 4)]],
        ["w2", [mutation("w2", 2, "reversed", "turn-target", 5)]],
        ["w3", [mutation("w3", 3, "reversed", "turn-target", 5)]],
      ]),
      reversals: [reversal(["w1"], "turn-earlier", 4), reversal(["w2", "w3"], "turn-target", 5)],
    });

    const plan = await planRedo({
      reversalStore: store,
      docId: DOC_ID,
      threadId: THREAD_ID,
      selection: { kind: "turn", turnId: "turn-target" },
    });

    expect(plan).toMatchObject({
      ok: true,
      direction: "redo",
      writeIds: ["w2", "w3"],
      turnId: "turn-target",
      redoGroup: { undoUpdateSeq: 5 },
    });
  });

  it("omitted turn redo targets the latest reversed turn", async () => {
    const store = fakeReversalStore({
      snapshot: snapshotWithSeqs([1, 2, 3, 4]),
      mutations: new Map([
        ["w1", [mutation("w1", 1, "reversed", "turn-earlier", 3)]],
        ["w2", [mutation("w2", 2, "reversed", "turn-latest", 4)]],
      ]),
      reversals: [reversal(["w1"], "turn-earlier", 3), reversal(["w2"], "turn-latest", 4)],
    });

    const plan = await planRedo({
      reversalStore: store,
      docId: DOC_ID,
      threadId: THREAD_ID,
      selection: { kind: "turn" },
    });

    expect(plan).toMatchObject({ ok: true, writeIds: ["w2"], turnId: "turn-latest" });
  });

  it("returns nothing_to_redo for an empty or active turn", async () => {
    const store = fakeReversalStore({
      snapshot: snapshotWithSeqs([1]),
      activeWrites: [activeWrite("w1", 1, "turn-active")],
      mutations: new Map([["w1", [mutation("w1", 1, "active", "turn-active")]]]),
    });

    await expect(
      planRedo({
        reversalStore: store,
        docId: DOC_ID,
        threadId: THREAD_ID,
        selection: { kind: "turn", turnId: "turn-active" },
      }),
    ).resolves.toEqual({ ok: false, status: "nothing_to_redo" });
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

function activeWrite(handle: string, seq: number, turnId = `turn-${seq}`): ActiveWriteSummary {
  const wId = Number(handle.slice(1));
  return { writeId: handle, handle, wId, turnId, createdSeq: seq };
}

function mutation(
  handle: string,
  seq: number,
  status: WriteMutationRow["status"],
  turnId = `turn-${seq}`,
  undoUpdateSeq?: number,
): WriteMutationRow {
  const wId = Number(handle.slice(1));
  return {
    writeId: handle,
    handle,
    wId,
    turnId,
    createdSeq: seq,
    status,
    ...(undoUpdateSeq !== undefined ? { undoUpdateSeq } : {}),
  };
}

function reversal(writeIds: string[], turnId: string, undoUpdateSeq: number): ReversalRecord {
  return {
    documentId: DOC_ID,
    threadId: THREAD_ID,
    turnId,
    writeIds,
    status: "reversed",
    undoUpdateSeq,
    reversedAt: new Date(undoUpdateSeq),
  };
}

function fakeReversalStore(input: {
  snapshot: JournalSnapshot;
  activeWrites?: ActiveWriteSummary[];
  mutations: Map<string, WriteMutationRow[]>;
  reversals?: ReversalRecord[];
}): ReversalStore {
  return {
    reserveWriteOrdinal: async () => 1,
    readForReconstruction: async () => input.snapshot,
    latestActiveWrite: async () => input.activeWrites?.at(-1),
    activeWriteSummary: async () => input.activeWrites ?? [],
    writeMinCreatedSeq: async (_documentId, _threadId, handle) =>
      input.mutations.get(handle)?.at(0)?.createdSeq,
    mutationsForWrite: async (_documentId, _threadId, handle) => input.mutations.get(handle) ?? [],
    mutationsForWrites: async (_documentId, _threadId, handles) => {
      const result = new Map<string, WriteMutationRow[]>();
      for (const handle of handles) {
        result.set(handle, input.mutations.get(handle) ?? []);
      }
      return result;
    },
    persistUndo: async () => {},
    persistRedo: async () => ({ consumed: false }),
    readReversals: async () => input.reversals ?? [],
  } satisfies ReversalStore;
}

/**
 * Two server processes over one draft (the P6 cell without sockets): each process has its own
 * branch coordinator, store and room, and a row one process commits reaches the other only
 * through the database. Every way this process's committed replica advances must carry what it
 * adds into its room (decision D25), or the next frame typed into that room is fenced:
 *
 * - `two-process-frames`: two tabs type at once, one per process.
 * - `two-process-fold`: A's live pull folds a row B committed while the pull computed.
 * - `two-process-compaction`: A's 512-row background compaction folds a row B committed.
 */
import assert from "node:assert/strict";
import { createDraftCoordinator } from "../../../../apps/server/server/domains/collab/domain/draft-coordinator.ts";
import type { DraftStore } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import {
  appendToFirstParagraph,
  gate,
  type Harness,
  observe,
  openHarness,
  type Probe,
  settled,
  Y,
} from "./harness.mts";

const KEYS = 20;

type Process = ReturnType<typeof openProcess>;

/** One server process: its coordinator over its own store, and one Hocuspocus room. */
function openProcess(harness: Harness, label: string, store: DraftStore = harness.store) {
  const room = new Y.Doc({ gc: false });
  const coordinator = createDraftCoordinator({
    onAppendCommitted: () => {},
    store,
    attemptScope: harness.attemptScope,
    onDraftUpdate: ({ update }) => Y.applyUpdate(room, update, "deliver"),
  });
  return { label, room, coordinator };
}

/**
 * A draft over "Base" with a room loaded in each process, the second process on its own
 * connections. `storeA` lets a probe pause process A's store.
 */
async function twoProcesses(
  harness: Harness,
  label: string,
  storeA?: DraftStore,
  wrap: (store: DraftStore) => DraftStore = (store) => store,
) {
  const { branchId } = await harness.seedWork(label);
  const { documentId, live } = await harness.seedDocument(label, "Base");
  const documentDraft = await harness.store.ensureDocumentDraft({
    documentId,
    branchId,
    liveDoc: live,
  });
  const other = await openHarness(harness.url);
  const a = openProcess(harness, "A", wrap(storeA ?? harness.store));
  const b = openProcess(other, "B", wrap(other.store));
  for (const process of [a, b]) {
    await process.coordinator.readDraft(documentDraft.draftId, async (doc) => {
      Y.applyUpdate(process.room, Y.encodeStateAsUpdate(doc));
    });
  }
  const generation = (await harness.readDraft(documentDraft.draftId)).generation;
  return { draftId: documentDraft.draftId, generation, live, a, b, other };
}

/** The tab's keystroke on its room's state: a fresh client inserting `token` at the end. */
function keystroke(room: Y.Doc, token: string): Uint8Array {
  const tab = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
    return appendToFirstParagraph(tab, token);
  } finally {
    tab.destroy();
  }
}

async function type(
  process: Process,
  draftId: string,
  generation: number,
  token: string,
  wall?: number[],
) {
  const update = keystroke(process.room, token);
  const started = performance.now();
  const result = await settled(
    process.coordinator.commitWriterUpdate({
      draftId,
      expectedGeneration: generation,
      updateData: update,
      roomDocument: process.room,
    }),
  );
  // Hocuspocus applies an admitted frame to the room; a refused one closes the socket.
  if (result.ok && result.value.admitted) Y.applyUpdate(process.room, update, "client");
  wall?.push(performance.now() - started);
  return result;
}

/** p50, p95 and max of `values`, rounded to a tenth of a millisecond. */
function latency(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) };
}

const roomText = (process: Process) => process.room.getXmlFragment("prosemirror").toString();

export const twoProcessFrames: Probe = {
  name: "two-process-frames",
  decision: "D25",
  expected: `frames: {"admitted":${2 * KEYS},"failures":{}}; ${2 * KEYS} tokens durable and in both rooms after a rejoin; no frame over 1 s, no DraftCasConflictError, one appendRows per frame`,
  async run(harness) {
    // One sequence point per frame (design §9): today's revision miss, retried inside the frame
    // as `DraftCasConflictError`, would show as a second `appendRows` call.
    let appendRowsCalls = 0;
    const counted = (store: DraftStore): DraftStore => ({
      ...store,
      appendRows(input) {
        appendRowsCalls += 1;
        return store.appendRows(input);
      },
    });
    const { draftId, generation, live, a, b, other } = await twoProcesses(
      harness,
      "two-process",
      undefined,
      counted,
    );
    live.destroy();
    const failures: Record<string, number> = {};
    const wall: number[] = [];
    let admitted = 0;
    for (let key = 0; key < KEYS; key += 1) {
      const results = await Promise.all([
        type(a, draftId, generation, ` A${key}`, wall),
        type(b, draftId, generation, ` B${key}`, wall),
      ]);
      for (const result of results) {
        if (result.ok) admitted += 1;
        else {
          const name = `${result.name}: ${result.message}`;
          failures[name] = (failures[name] ?? 0) + 1;
        }
      }
    }
    const tokens = (text: string) => (text.match(/ [AB]\d+/g) ?? []).length;
    const rooms: Record<string, number> = {};
    for (const process of [a, b]) {
      await process.coordinator.readDraft(draftId, async () => {});
      rooms[process.label] = tokens(roomText(process));
    }
    const appends = [...harness.appends, ...other.appends].filter(
      (append) => append.draftId === draftId,
    );
    await other.close();
    const durable = tokens((await harness.readDraft(draftId)).text);
    observe("frames", { admitted, failures });
    observe("tokens", { durable, rooms });
    // `lock_timeout` plays no part here: an append waits for the row as long as a holder holds it.
    observe("latency", {
      wallMs: latency(wall),
      waitMs: latency(appends.map((append) => append.waitMs)),
      holdMs: latency(appends.map((append) => append.holdMs)),
      foldedPrefixRows: appends.reduce((total, append) => total + append.prefixRows, 0),
      appendRowsCalls,
    });
    assert.equal(appendRowsCalls, 2 * KEYS, "a frame retried its sequence point");
    assert.ok(!Object.keys(failures).some((name) => name.startsWith("DraftCasConflictError")));
    assert.ok(Math.max(...wall) < 1_000, "a frame took a second or more");
    assert.equal(admitted, 2 * KEYS);
    assert.deepEqual(
      { durable, rooms },
      { durable: 2 * KEYS, rooms: { A: 2 * KEYS, B: 2 * KEYS } },
    );
  },
};

/** `store` whose first rewrite of `kind` waits for `release` once it has `entered`. */
function pausedRewrite(store: DraftStore, kind: "pull" | "compact") {
  const entered = gate();
  const release = gate();
  const done = gate();
  let held = false;
  const paused: DraftStore = {
    ...store,
    async commitRewrite(input) {
      if (held || input.operation.kind !== kind) return store.commitRewrite(input);
      held = true;
      entered.open();
      await release.wait;
      try {
        return await store.commitRewrite(input);
      } finally {
        done.open();
      }
    },
  };
  return { paused, entered, release, done };
}

export const twoProcessFold: Probe = {
  name: "two-process-fold",
  decision: "D25",
  expected: `room A holds FOREIGN after the pull; next: {"ok":true,"value":{"admitted":true}}`,
  async run(harness) {
    const pause = pausedRewrite(harness.store, "pull");
    const f = await twoProcesses(harness, "two-process-fold", pause.paused);
    try {
      appendToFirstParagraph(f.live, " LIVE");
      // A's pull has merged live into its candidate; B commits before the pull's rewrite runs,
      // so the rewrite folds B's row in under the branch lock.
      const pull = f.a.coordinator.pullFromDoc({ draftId: f.draftId, upstream: f.live });
      await pause.entered.wait;
      const foreign = await type(f.b, f.draftId, f.generation, " FOREIGN");
      pause.release.open();
      const pulled = await pull;
      const durable = (await harness.readDraft(f.draftId)).text;
      const room = roomText(f.a);
      const next = await type(f.a, f.draftId, f.generation, " NEXT");
      observe("pull", { foreign: foreign.ok, pulled, durable, room });
      observe("next", next);
      assert.equal(pulled, "pulled");
      assert.match(durable, /FOREIGN/);
      assert.match(room, /FOREIGN/);
      assert.deepEqual(next, { ok: true, value: { admitted: true } });
    } finally {
      f.live.destroy();
      await f.other.close();
    }
  },
};

const COMPACT_TAIL_ROWS = 512;

export const twoProcessCompaction: Probe = {
  name: "two-process-compaction",
  decision: "D25",
  expected: `tail 0 and room A holds FOREIGN after the compaction; next: {"ok":true,"value":{"admitted":true}}`,
  async run(harness) {
    const pause = pausedRewrite(harness.store, "compact");
    const f = await twoProcesses(harness, "two-process-compaction", pause.paused);
    try {
      f.live.destroy();
      // A tail one row short of the bound; the next frame triggers the background fold.
      const source = new Y.Doc({ gc: false });
      Y.applyUpdate(source, Y.encodeStateAsUpdate(f.a.room));
      const rows = Array.from({ length: COMPACT_TAIL_ROWS - 1 }, () => ({
        draftId: f.draftId,
        source: "writer" as const,
        updateData: appendToFirstParagraph(source, "x"),
      }));
      await f.a.coordinator.commitSegmentRows({
        draftId: f.draftId,
        expectedGeneration: f.generation,
        sourceDoc: source,
        rows,
      });
      source.destroy();
      await f.a.coordinator.readDraft(f.draftId, async () => {});
      await type(f.a, f.draftId, f.generation, " TRIGGER");
      await pause.entered.wait;
      const foreign = await type(f.b, f.draftId, f.generation, " FOREIGN");
      pause.release.open();
      await pause.done.wait;
      // The compaction delivers after its own commit returns.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const durable = await harness.readDraft(f.draftId);
      const room = roomText(f.a);
      const next = await type(f.a, f.draftId, f.generation, " NEXT");
      observe("compaction", {
        foreign: foreign.ok,
        tail: durable.tail,
        durableHasForeign: durable.text.includes("FOREIGN"),
        roomHasForeign: room.includes("FOREIGN"),
      });
      observe("next", next);
      assert.equal(durable.tail, 0);
      assert.match(durable.text, /FOREIGN/);
      assert.match(room, /FOREIGN/);
      assert.deepEqual(next, { ok: true, value: { admitted: true } });
    } finally {
      await f.other.close();
    }
  },
};

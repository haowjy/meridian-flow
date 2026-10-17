/**
 * Two server processes, two writers, one draft (the P6 cell without sockets): each process has
 * its own branch coordinator, store and room, and a tab types into each room at once. A row one
 * process commits reaches the other only through the database, so each frame's runtime read
 * must carry it into its room before the room is judged; a tab that rejoins (the SyncStep1
 * handshake reads through the same runtime) must find every token in its room.
 */
import assert from "node:assert/strict";
import { createBranchCoordinator } from "../../../../apps/server/server/domains/collab/domain/branch-coordinator.ts";
import { type Harness, observe, openHarness, type Probe, settled, Y } from "./harness.mts";

const KEYS = 20;

type Process = ReturnType<typeof openProcess>;

/** One server process: its coordinator over its own store, and one Hocuspocus room. */
function openProcess(harness: Harness, label: string) {
  const room = new Y.Doc({ gc: false });
  const coordinator = createBranchCoordinator({
    store: harness.store,
    attemptScope: harness.attemptScope,
    onBranchUpdate: ({ update }) => Y.applyUpdate(room, update, "publish"),
  });
  return { label, room, coordinator, harness };
}

/** The tab's keystroke on its room's state: a fresh client inserting `token` at the end. */
function keystroke(room: Y.Doc, token: string): Uint8Array {
  const tab = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
    const before = Y.encodeStateVector(tab);
    const paragraph = tab.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    text.insert(text.length, token);
    return Y.encodeStateAsUpdate(tab, before);
  } finally {
    tab.destroy();
  }
}

async function type(process: Process, branchId: string, generation: number, token: string) {
  const update = keystroke(process.room, token);
  const result = await settled(
    process.coordinator.commitWriterUpdate({
      branchId,
      expectedGeneration: generation,
      updateData: update,
      roomDocument: process.room,
    }),
  );
  // Hocuspocus applies an admitted frame to the room; a refused one closes the socket.
  if (result.ok && result.value.admitted) Y.applyUpdate(process.room, update, "client");
  return result;
}

export const twoProcessFrames: Probe = {
  name: "two-process-frames",
  decision: "D3",
  expected: `frames: {"admitted":${2 * KEYS},"failures":{}}; ${2 * KEYS} tokens durable and in both rooms after a rejoin`,
  async run(harness) {
    const { draftId } = await harness.seedWork("two-process");
    const { documentId, live } = await harness.seedDocument("two-process", "Base");
    const branch = await harness.store.ensureDraftBranch({ documentId, draftId, liveDoc: live });
    live.destroy();
    const generation = (await harness.readBranch(branch.branchId)).generation;
    const other = await openHarness(harness.url);
    const a = openProcess(harness, "A");
    const b = openProcess(other, "B");
    for (const process of [a, b]) {
      await process.coordinator.readBranch(branch.branchId, async (doc) => {
        Y.applyUpdate(process.room, Y.encodeStateAsUpdate(doc));
      });
    }
    const failures: Record<string, number> = {};
    let admitted = 0;
    for (let key = 0; key < KEYS; key += 1) {
      const results = await Promise.all([
        type(a, branch.branchId, generation, ` A${key}`),
        type(b, branch.branchId, generation, ` B${key}`),
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
      await process.coordinator.readBranch(branch.branchId, async () => {});
      rooms[process.label] = tokens(process.room.getXmlFragment("prosemirror").toString());
    }
    await other.close();
    const durable = tokens((await harness.readBranch(branch.branchId)).text);
    observe("frames", { admitted, failures });
    observe("tokens", { durable, rooms });
    assert.equal(admitted, 2 * KEYS);
    assert.deepEqual(
      { durable, rooms },
      { durable: 2 * KEYS, rooms: { A: 2 * KEYS, B: 2 * KEYS } },
    );
  },
};

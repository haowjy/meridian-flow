/** Admission contracts on the production response replay seam, using real cold Yjs documents. */
import { cloneYDoc, type JournalBatchAppendEntry } from "@meridian/agent-edit/integration";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { reconcileStagedDraftWrites } from "./draft-response-replay.js";

it.each([
  "chat replacement",
  "writer deletion",
])("admits ordinary concurrent %s like a Yjs peer", (concurrent) => {
  const base = new Y.Doc({ gc: false });
  base.getText("chapter").insert(0, "Alpha Beta.");
  const current = cloneYDoc(base),
    helper = cloneYDoc(base);
  const updates: Uint8Array[] = [];
  helper.on("update", (update: Uint8Array) => updates.push(update));
  helper.transact(() => {
    helper.getText("chapter").delete(6, 4);
    helper.getText("chapter").insert(6, "Delta");
  });
  const update = Y.mergeUpdates(updates);
  current.transact(() => {
    current.getText("chapter").delete(6, 4);
    if (concurrent === "chat replacement") current.getText("chapter").insert(6, "Gamma");
  });
  const expected = cloneYDoc(current);
  Y.applyUpdate(expected, update);
  const entry: JournalBatchAppendEntry = {
    docId: "chapter",
    update,
    meta: { origin: "agent:thread", seq: 0 },
    mutation: {
      mode: "threadPeer",
      threadId: "thread",
      turnId: null,
      actorKind: "agent",
      writeId: "replacement",
    },
  };
  try {
    expect(
      reconcileStagedDraftWrites(current, helper, [entry], Y.encodeStateAsUpdate(base)).keptEntries,
    ).toEqual([entry]);
    expect(current.getText("chapter").toString()).toBe(expected.getText("chapter").toString());
    expect(current.store.pendingStructs).toBeNull();
    expect(current.store.pendingDs).toBeNull();
  } finally {
    base.destroy();
    current.destroy();
    helper.destroy();
    expected.destroy();
  }
});

it("protects planning-visible identities removed by an explicit inverse", () => {
  const base = new Y.Doc({ gc: false });
  const text = base.getText("chapter");
  text.insert(0, "Alpha Beta.");
  const undo = new Y.UndoManager(text);
  text.delete(6, 4);
  text.insert(6, "Gamma");
  const planningState = Y.encodeStateAsUpdate(base);
  const helper = cloneYDoc(base);
  const updates: Uint8Array[] = [];
  helper.on("update", (update: Uint8Array) => updates.push(update));
  helper.transact(() => {
    helper.getText("chapter").delete(6, 5);
    helper.getText("chapter").insert(6, "Delta");
  });
  const inverse: Uint8Array[] = [];
  base.on("update", (update: Uint8Array) => inverse.push(update));
  undo.undo();
  const current = cloneYDoc(base);
  const entry: JournalBatchAppendEntry = {
    docId: "chapter",
    update: Y.mergeUpdates(updates),
    meta: { origin: "agent:thread", seq: 0 },
    mutation: {
      mode: "threadPeer",
      threadId: "thread",
      turnId: null,
      actorKind: "agent",
      writeId: "replacement",
    },
  };
  try {
    const replay = reconcileStagedDraftWrites(current, helper, [entry], planningState, inverse);
    expect(replay.keptEntries).toEqual([]);
    expect(replay.rejectedWrites).toEqual([{ writeId: "replacement", reason: "inverse" }]);
    expect(current.getText("chapter").toString()).toBe("Alpha Beta.");
  } finally {
    undo.destroy();
    base.destroy();
    helper.destroy();
    current.destroy();
  }
});

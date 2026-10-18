/** Admission contracts on the production response replay seam, using real cold Yjs documents. */
import { cloneYDoc, type JournalBatchAppendEntry } from "@meridian/agent-edit/integration";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { reconcileStagedDraftWrites } from "./draft-response-replay.js";

it("drops a whole multi-segment write and its later dependency, never its independent sibling", () => {
  const live = new Y.Doc({ gc: false });
  live.getText("chapter").insert(0, "red blue green");
  const draft = cloneYDoc(live),
    helper = cloneYDoc(draft);
  const delta = (doc: Y.Doc, mutate: () => void) => {
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(update);
    doc.on("update", collect);
    doc.transact(mutate);
    doc.off("update", collect);
    return Y.mergeUpdates(updates);
  };
  const retired = delta(draft, () => {
    draft.getText("chapter").delete(0, 3);
    draft.getText("chapter").insert(0, "gold");
  });
  Y.applyUpdate(helper, retired);
  const segment = (writeId: string, mutate: (doc: Y.Doc) => void): JournalBatchAppendEntry => {
    const peer = cloneYDoc(helper);
    try {
      const update = delta(peer, () => mutate(peer));
      Y.applyUpdate(helper, update);
      return {
        docId: "chapter",
        update,
        meta: { origin: "agent:thread", seq: 0 },
        mutation: {
          mode: "threadPeer",
          draftGeneration: 1,
          threadId: "thread",
          turnId: null,
          actorKind: "agent",
          writeId,
        },
      };
    } finally {
      peer.destroy();
    }
  };
  const rows = [
    segment("lost", (doc) => doc.getText("chapter").insert(2, "X")),
    segment("lost", (doc) => doc.getText("chapter").insert(doc.getText("chapter").length, "!")),
    segment("dependent", (doc) => doc.getText("chapter").insert(3, "Y")),
    segment("independent", (doc) => doc.getText("chapter").insert(7, "Z")),
  ];
  const current = cloneYDoc(live);
  try {
    const kept = reconcileStagedDraftWrites(
      current,
      helper,
      rows,
      [retired],
      Y.encodeStateAsUpdate(draft),
    );
    expect(kept.keptEntries.map((row) => row.mutation?.writeId)).toEqual(["independent"]);
    expect(kept.rejectedWrites).toEqual([
      { writeId: "lost", reason: "discard" },
      { writeId: "dependent", reason: "discard" },
    ]);
    expect(current.getText("chapter").toString()).toBe("red Zblue green");
    // The command boundary now sends one envelope with ordered parts; storage expands rows.
    const logical = cloneYDoc(live);
    const mutation = rows[0].mutation;
    if (!mutation) throw new Error("Missing test edit identity");
    try {
      const parts = rows.slice(0, 2).map((row) => row.update);
      const envelopes = [
        { ...rows[0], update: Y.mergeUpdates(parts), mutation: { ...mutation, editParts: parts } },
        ...rows.slice(2),
      ];
      expect(
        reconcileStagedDraftWrites(
          logical,
          helper,
          envelopes,
          [retired],
          Y.encodeStateAsUpdate(draft),
        ).keptEntries.map((entry) => entry.mutation?.writeId),
      ).toEqual(["independent"]);
      expect(logical.getText("chapter").toString()).toBe("red Zblue green");
    } finally {
      logical.destroy();
    }
    const forged = cloneYDoc(helper);
    const untouched = cloneYDoc(live);
    try {
      forged.getText("unrecorded").insert(0, "unexplained");
      expect(() =>
        reconcileStagedDraftWrites(
          untouched,
          forged,
          rows,
          [retired],
          Y.encodeStateAsUpdate(draft),
        ),
      ).toThrow("unexplained generation residual");
    } finally {
      forged.destroy();
      untouched.destroy();
    }
  } finally {
    current.destroy();
    live.destroy();
    draft.destroy();
    helper.destroy();
  }
});

it.each([
  "chat replacement",
  "writer deletion",
  "writer deletion after refork",
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
      draftGeneration: 1,
      threadId: "thread",
      turnId: null,
      actorKind: "agent",
      writeId: "replacement",
    },
  };
  try {
    expect(
      reconcileStagedDraftWrites(
        current,
        helper,
        [entry],
        concurrent === "writer deletion after refork" ? [Y.encodeStateAsUpdate(base)] : [],
        Y.encodeStateAsUpdate(base),
      ).keptEntries,
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
      draftGeneration: 1,
      threadId: "thread",
      turnId: null,
      actorKind: "agent",
      writeId: "replacement",
    },
  };
  try {
    const replay = reconcileStagedDraftWrites(current, helper, [entry], [], planningState, inverse);
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

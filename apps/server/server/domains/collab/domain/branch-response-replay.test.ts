/** Admission contracts on the production response replay seam, using real cold Yjs documents. */
import { cloneYDoc, type JournalBatchAppendEntry } from "@meridian/agent-edit/integration";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { reconcileStagedBranchWrites } from "./branch-response-replay.js";

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
          branchGeneration: 1,
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
    const kept = reconcileStagedBranchWrites(current, helper, rows, [retired]);
    expect(kept.map((row) => row.mutation?.writeId)).toEqual(["independent"]);
    expect(current.getText("chapter").toString()).toBe("red Zblue green");
    const forged = cloneYDoc(helper);
    const untouched = cloneYDoc(live);
    try {
      forged.getText("unrecorded").insert(0, "unexplained");
      expect(() => reconcileStagedBranchWrites(untouched, forged, rows, [retired])).toThrow(
        "unexplained generation residual",
      );
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

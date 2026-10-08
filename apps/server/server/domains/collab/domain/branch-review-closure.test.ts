/** Unit coverage for server-vended Apply/Discard classes. */

import type { ReviewHunk } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { assignReviewClasses } from "./branch-review-closure.js";
import {
  asPhysicalSourceUpdateIds,
  asSourceUpdateIds,
  type DraftReviewOperationInternal,
} from "./draft-review-types.js";

function op(
  id: string,
  sourceUpdateIds: number[],
  closureUpdateIds = sourceUpdateIds,
): Omit<DraftReviewOperationInternal, "closureClassId"> {
  return {
    operationId: id,
    sourceUpdateIds: asSourceUpdateIds(sourceUpdateIds),
    closureUpdateIds: asPhysicalSourceUpdateIds(closureUpdateIds),
    kind: "agent",
    contribution: "added",
    classification: "addition",
    hunkCount: 1,
  };
}

function hunk(id: string, operationIds: string[]): ReviewHunk {
  return {
    kind: "block",
    hunkId: id,
    operationIds,
    anchor: { relStart: "0", relEnd: "0" },
  };
}

describe("assignReviewClasses", () => {
  it.each([
    false,
    true,
  ])("fresh writer clients separate only independent locations (inside AI: %s)", (insideAi) => {
    const base = textDoc("Alpha remains. Beta remains. Gamma remains.");
    const draft = new Y.Doc({ gc: false });
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(base));
    const updates: Array<{ id: number; updateData: Uint8Array }> = [];
    const record = (id: number, client: number, edit: () => void) => {
      draft.clientID = client;
      const listener = (updateData: Uint8Array) => updates.push({ id, updateData });
      draft.on("update", listener);
      edit();
      draft.off("update", listener);
    };
    const text = draft.getText("chapter");
    record(1, 50001, () => text.insert(5, " green serpent"));
    record(2, 50002, () => text.insert(text.toString().indexOf("serpent") + 2, "WRITERBIT"));
    record(3, 50003, () =>
      text.insert(text.toString().indexOf(insideAi ? "green" : "Beta") + 2, "GOLDPLAIN"),
    );
    const operations = assignReviewClasses({
      operations: [op("ai", [1]), op("writer-a", [2]), op("writer-b", [3])],
      hunks: [],
      updates,
    });
    expect(operations[0]?.closureClassId).toBe(operations[1]?.closureClassId);
    if (insideAi) {
      expect(operations[2]?.closureClassId).toBe(operations[0]?.closureClassId);
    } else {
      expect(operations[2]?.closureClassId).not.toBe(operations[0]?.closureClassId);
      const published = new Y.Doc({ gc: false });
      Y.applyUpdate(published, Y.encodeStateAsUpdate(base));
      const selected = operations[0]?.closureUpdateIds ?? [];
      for (const update of updates.filter((row) => selected.some((id) => id === row.id)))
        Y.applyUpdate(published, update.updateData);
      expect(published.getText("chapter").toString()).toContain("WRITERBIT");
      expect(published.getText("chapter").toString()).not.toContain("GOLDPLAIN");
      expect(published.store.pendingStructs).toBeNull();
      const independent = new Y.Doc({ gc: false });
      Y.applyUpdate(independent, Y.encodeStateAsUpdate(base));
      const elsewhere = updates[2];
      if (!elsewhere) throw new Error("missing writer delta");
      Y.applyUpdate(independent, elsewhere.updateData);
      expect(independent.getText("chapter").toString()).toContain("GOLDPLAIN");
      expect(independent.getText("chapter").toString()).not.toContain("WRITERBIT");
      expect(independent.store.pendingStructs).toBeNull();
      independent.destroy();
      published.destroy();
    }
    draft.destroy();
    base.destroy();
  });

  it("does not join independent delta edits through tombstones already present on live", () => {
    const base = textDoc("Old base text. Alpha. Beta.");
    base.getText("chapter").delete(0, 14);
    const baseDeletedRanges = Y.decodeUpdate(Y.encodeStateAsUpdate(base)).ds.clients;
    const updates = ["Alpha", "Beta"].map((find, index) => {
      const peer = new Y.Doc({ gc: false });
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(base));
      const before = Y.encodeStateVector(peer);
      peer.getText("chapter").insert(peer.getText("chapter").toString().indexOf(find), "New ");
      const updateData = Y.encodeStateAsUpdate(peer, before);
      peer.destroy();
      return { id: index + 1, updateData };
    });
    const operations = assignReviewClasses({
      operations: [op("1", [1]), op("2", [2])],
      hunks: [hunk("h1", ["1"]), hunk("h2", ["2"])],
      updates,
      baseDeletedRanges: [...baseDeletedRanges].flatMap(([client, ranges]) =>
        ranges.map((range) => ({ client, clock: range.clock, length: range.len })),
      ),
    });
    expect(operations.map((operation) => operation.closureClassId)).toEqual([
      "closure:1",
      "closure:2",
    ]);
    base.destroy();
  });

  it("joins operations whose review closures share a physical row", () => {
    const operations = assignReviewClasses({
      operations: [op("a", [1], [1, 2]), op("b", [2], [2])],
      hunks: [hunk("h1", ["a"]), hunk("h2", ["b"])],
    });

    expect(new Set(operations.map((operation) => operation.closureClassId))).toEqual(
      new Set(["closure:a+b"]),
    );
    expect(operations.map((operation) => operation.sourceUpdateIds)).toEqual([[1], [2]]);
    expect(operations.map((operation) => operation.closureUpdateIds)).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });

  it("does not join operations only because one Apply source set contains the other", () => {
    const operations = assignReviewClasses({
      operations: [op("a", [1], [1]), op("b", [1, 2], [2])],
      hunks: [hunk("h1", ["a"]), hunk("h2", ["b"])],
    });

    expect(operations.map((operation) => operation.closureClassId)).toEqual([
      "closure:a",
      "closure:b",
    ]);
  });

  it("joins operations that share a visible hunk", () => {
    const operations = assignReviewClasses({
      operations: [op("a", [1]), op("b", [2])],
      hunks: [hunk("h1", ["a", "b"])],
    });

    expect(new Set(operations.map((operation) => operation.closureClassId))).toEqual(
      new Set(["closure:a+b"]),
    );
    expect(operations.map((operation) => operation.closureUpdateIds)).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });

  it.each([
    {
      name: "an AI insert anchored to an earlier AI insert in a different hunk",
      build: () => {
        const doc = textDoc("The cultivator crossed the pass.");
        const first = capture(doc, () => doc.getText("chapter").insert(14, "swiftly "));
        const second = capture(doc, () => doc.getText("chapter").insert(22, "and silently "));
        return { doc, updates: [first, second] };
      },
    },
    {
      name: "a later turn deleting earlier-turn text",
      build: () => {
        const doc = textDoc("The cultivator crossed the pass.");
        const first = capture(doc, () => doc.getText("chapter").insert(14, "swiftly "));
        const second = capture(doc, () => doc.getText("chapter").delete(14, 8));
        return { doc, updates: [first, second] };
      },
    },
    {
      name: "a block created by one turn and edited by another",
      build: () => {
        const doc = new Y.Doc({ gc: false });
        const fragment = doc.getXmlFragment("prosemirror");
        const first = capture(doc, () => {
          const paragraph = new Y.XmlElement("paragraph");
          const text = new Y.XmlText();
          text.insert(0, "New realm breakthrough.");
          paragraph.insert(0, [text]);
          fragment.insert(0, [paragraph]);
        });
        const second = capture(doc, () => {
          const paragraph = fragment.get(0) as Y.XmlElement;
          const text = paragraph.get(0) as Y.XmlText;
          text.insert(9, "sudden ");
        });
        return { doc, updates: [first, second] };
      },
    },
    {
      name: "a writer edit inside AI text",
      build: () => {
        const doc = textDoc("Chapter opening.");
        const first = capture(doc, () => doc.getText("chapter").insert(8, "AI-generated "));
        const second = capture(doc, () => doc.getText("chapter").insert(11, "writer-polished "));
        return { doc, updates: [first, second] };
      },
    },
  ])("joins $name", ({ build }) => {
    const { doc, updates } = build();
    try {
      const operations = assignReviewClasses({
        operations: [op("1", [1]), op("2", [2])],
        hunks: [hunk("h1", ["1"]), hunk("h2", ["2"])],
        updates: updates.map((update, index) => ({ id: index + 1, updateData: update })),
      });
      expect(operations.map((operation) => operation.closureClassId)).toEqual([
        "closure:1+2",
        "closure:1+2",
      ]);
    } finally {
      doc.destroy();
    }
  });

  it("collapses the synthetic three-turn chapter rewrite into one group", () => {
    const authority = textDoc(
      "At dawn, Lin climbed the mountain. At noon, he entered the sect. At dusk, he faced the elder.",
    );
    try {
      const turn1 = editFromFreshPeer(authority, (text) => {
        text.insert(9, "weary ");
        text.insert(59, "hidden ");
      });
      const turn2 = editFromFreshPeer(authority, (text) => {
        const weary = text.toString().indexOf("weary");
        text.delete(weary, "weary".length);
        text.insert(weary, "bloodied");
      });
      const turn3 = editFromFreshPeer(authority, (text) => {
        const bloodied = text.toString().indexOf("bloodied") + "bloodied".length;
        text.insert(bloodied, " but unbowed");
      });
      const operations = assignReviewClasses({
        operations: [op("1", [1]), op("2", [2]), op("3", [3])],
        hunks: [hunk("turn-1", ["1"]), hunk("turn-2", ["2"]), hunk("turn-3", ["3"])],
        updates: [turn1, turn2, turn3].map((update, index) => ({
          id: index + 1,
          updateData: update,
        })),
      });

      expect(new Set(operations.map((operation) => operation.closureClassId))).toEqual(
        new Set(["closure:1+2+3"]),
      );
    } finally {
      authority.destroy();
    }
  });

  it("carries an invisible supplier row into the visible operation's row set", () => {
    const doc = textDoc("Base.");
    try {
      const supplier = capture(doc, () => doc.getText("chapter").insert(5, " hidden"));
      const visible = capture(doc, () => doc.getText("chapter").insert(12, " visible"));
      const [operation] = assignReviewClasses({
        operations: [op("2", [2])],
        hunks: [hunk("visible", ["2"])],
        updates: [
          { id: 1, updateData: supplier },
          { id: 2, updateData: visible },
        ],
      });
      expect(operation?.closureUpdateIds).toEqual([1, 2]);
    } finally {
      doc.destroy();
    }
  });
});

function textDoc(initial: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.getText("chapter").insert(0, initial);
  return doc;
}

function capture(doc: Y.Doc, mutate: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  mutate();
  return Y.encodeStateAsUpdate(doc, before);
}

function editFromFreshPeer(authority: Y.Doc, mutate: (text: Y.Text) => void): Uint8Array {
  const peer = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(authority));
    const update = capture(peer, () => mutate(peer.getText("chapter")));
    Y.applyUpdate(authority, update);
    return update;
  } finally {
    peer.destroy();
  }
}

/**
 * Proof code. One test per numbered case of
 * work/release-coordination/findings/tree-cases-and-echoes.md, in that file's order, on one list
 * with one writer (the server appending for the writer, for chats and for live). `D` is a Work's
 * draft; `E` is a second chat writing into the same draft.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appliedNodes,
  applyDraft,
  childrenOf,
  discardDraft,
  discardedBy,
  fingerprint,
  LIVE,
  pendingRecords,
  recordsOf,
  replayView,
  restoreDiscard,
  sourceRoot,
  type TreeProjection,
  type TreeRecord,
  TreeWriter,
  treeViolations,
  undoApply,
  undoChange,
  type View,
  viewRecords,
} from "./index.js";
import { projectedRows } from "./rows.js";

const ROOT = sourceRoot("manuscript");

const cmd = () => crypto.randomUUID();

const WRITER = "user:writer";
const CHAT = "agent:c1/t1";
const CHAT2 = "agent:c2/t1";
const D: View = { draft: "work-1" };

function start() {
  const doc = new Y.Doc({ gc: false });
  const w = new TreeWriter(doc);
  const folder = (name: string, parent = ROOT, view: View = LIVE, actor = WRITER) =>
    w.create(view, actor, { kind: "folder", name, parent }).node;
  const chapter = (name: string, parent = ROOT, view: View = LIVE, actor = WRITER) =>
    w.create(view, actor, { kind: "document", filetype: "markdown", name, parent }).node;
  const names = (parent: string, view: View = LIVE) =>
    childrenOf(w.view(view), parent).map((node) => node.displayName);
  const at = (node: string, view: View = LIVE) => w.view(view).nodes.get(node);
  const valid = () => {
    expect(treeViolations(w.view(LIVE))).toEqual([]);
    expect(treeViolations(w.view(D))).toEqual([]);
  };
  return { doc, w, folder, chapter, names, at, valid };
}

/** Empties a Trash entry as the server does: the purge names what the entry covers now. */
function purge(w: TreeWriter, removal: { id: string; node: string }) {
  const entry = w.view(LIVE).trash.find((each) => each.id === removal.id);
  return w.purge("system", removal, entry ? [entry.node, ...entry.cascade] : []);
}

/** Drafted records review reports as "deleted in live": their node stands in the view only because they are pending. */
function targetGone(doc: Y.Doc, view: View): TreeRecord[] {
  const projection: TreeProjection = replayView(doc, view);
  return viewRecords(doc, view).filter(
    (op) => op.draft === view.draft && projection.nodes.get(op.node)?.keptByPending === true,
  );
}

describe("part 1: a draft and live changed the same thing", () => {
  it("1. draft moved a chapter, live renamed it: both stand", () => {
    const t = start();
    const arc = t.folder("Arc 3");
    const ch = t.chapter("Chapter 49");
    t.w.move(D, CHAT, ch, arc);
    t.w.rename(LIVE, WRITER, ch, "The Fall");
    expect(t.at(ch, D)).toMatchObject({ parent: arc, displayName: "The Fall" });
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.at(ch)).toMatchObject({ parent: arc, displayName: "The Fall" });
    t.valid();
  });

  it("2. both renamed it: the draft's name shows and wins on Apply; the record keeps the name it replaced", () => {
    const t = start();
    const ch = t.chapter("Chapter 49");
    t.w.rename(D, CHAT, ch, "Draft name");
    t.w.rename(LIVE, WRITER, ch, "Live name");
    expect(t.at(ch, D)?.displayName).toBe("Draft name");
    const [copy] = applyDraft(t.w, "work-1", WRITER, cmd()).copies;
    expect(t.at(ch)?.displayName).toBe("Draft name");
    // What review can say: the drafted rename was made over "Chapter 49"; live now says "Live name".
    expect(copy).toMatchObject({ type: "rename", fromName: "Live name" });
    const drafted = recordsOf(t.doc)
      .toArray()
      .find((op) => op.draft === "work-1");
    expect(drafted).toMatchObject({ fromName: "Chapter 49" });
  });

  it("3. draft moved a chapter into F, live deleted F: F stays, kept by what is inside", () => {
    const t = start();
    const f = t.folder("Arc 3");
    const ch = t.chapter("Chapter 49");
    t.w.move(D, CHAT, ch, f);
    const made = t.chapter("Chapter 50", f, D, CHAT);
    t.w.delete(LIVE, WRITER, f);
    expect(t.at(f)?.trashed).toBe(true);
    expect(t.at(f, D)).toMatchObject({ trashed: false, keptByChild: true });
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.at(f)).toMatchObject({ trashed: false, keptByChild: true });
    expect(t.names(f)).toEqual(["Chapter 49", "Chapter 50"]);
    expect(t.at(made)?.trashed).toBe(false);
    t.valid();
  });

  it("4. draft deleted F, live added a chapter to F: F kept, holding only the new chapter", () => {
    const t = start();
    const f = t.folder("Arc 2");
    const old = t.chapter("Chapter 1", f);
    t.w.delete(D, CHAT, f);
    const added = t.chapter("Chapter 2", f);
    expect(t.names(f, D)).toEqual(["Chapter 2"]);
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.at(old)?.trashed).toBe(true);
    expect(t.at(added)?.trashed).toBe(false);
    expect(t.at(f)).toMatchObject({ trashed: false, keptByChild: true });
    t.valid();
  });

  it("5. draft deleted F, live moved a chapter out of F: F gone, the chapter where it went", () => {
    const t = start();
    const f = t.folder("Arc 2");
    const keep = t.folder("Keep");
    const ch = t.chapter("Chapter 1", f);
    t.w.delete(D, CHAT, f);
    t.w.move(LIVE, WRITER, ch, keep);
    expect(t.at(f, D)?.trashed).toBe(true);
    expect(t.at(ch, D)).toMatchObject({ parent: keep, trashed: false });
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.at(f)?.trashed).toBe(true);
    expect(t.at(ch)).toMatchObject({ parent: keep, trashed: false });
    t.valid();
  });

  it("6. draft moved A into B, live moved B into A: the drafted move is skipped and reported", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B");
    const other = t.chapter("Other");
    const drafted = t.w.move(D, CHAT, a, b);
    t.w.rename(D, CHAT, other, "Renamed");
    t.w.move(LIVE, WRITER, b, a);
    expect(t.w.view(D).skipped).toEqual([{ record: drafted.id, reason: "cycle" }]);
    const { copies, left } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(copies.map((op) => op.type)).toEqual(["rename"]);
    expect(left).toEqual([
      { record: expect.objectContaining({ id: drafted.id }), why: "would_loop" },
    ]);
    expect(t.w.view(LIVE).skipped).toEqual([]);
    expect(t.at(b)).toMatchObject({ parent: a });
    expect(t.at(a)).toMatchObject({ parent: ROOT });
    expect(t.at(other)?.displayName).toBe("Renamed");
    t.valid();
  });

  it("7. both created Notes in F: both stay, the draft's shows a number until Apply and after", () => {
    const t = start();
    const f = t.folder("F");
    const drafted = t.chapter("Notes", f, D, CHAT);
    const live = t.chapter("Notes", f);
    expect(t.at(drafted, D)?.displayName).toBe("Notes (2)");
    expect(t.at(live, D)?.displayName).toBe("Notes");
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.at(live)?.displayName).toBe("Notes");
    expect(t.at(drafted)?.displayName).toBe("Notes (2)");
    t.valid();
  });

  it("8. both reordered a folder: one order, every node kept", () => {
    const t = start();
    const f = t.folder("F");
    const [a, b, c] = ["a", "b", "c"].map((n) => t.chapter(n, f)) as [string, string, string];
    t.w.move(D, CHAT, c, f, 0);
    t.w.move(LIVE, WRITER, a, f, 2);
    const order = t.names(f, D);
    expect([...order].sort()).toEqual(["a", "b", "c"]);
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.names(f)).toEqual(order);
    expect([a, b, c].every((n) => t.at(n)?.trashed === false)).toBe(true);
  });

  it("9. draft moved and renamed a chapter, live deleted it: the Work's view still shows it, marked; Apply lands both and brings it back", () => {
    const t = start();
    const arc = t.folder("Arc 3");
    const ch = t.chapter("Chapter 49");
    const other = t.chapter("Chapter 50");
    t.w.move(D, CHAT, ch, arc);
    t.w.rename(D, CHAT, ch, "The Fall");
    t.w.rename(D, CHAT, other, "Lands");
    t.w.delete(LIVE, WRITER, ch);
    expect(t.at(ch)?.trashed).toBe(true);
    expect(t.at(ch, D)).toMatchObject({
      parent: arc,
      displayName: "The Fall",
      trashed: false,
      keptByPending: true,
    });
    expect(targetGone(t.doc, D).map((op) => op.type)).toEqual(["move", "rename"]);
    const before = fingerprint(t.w.view(D), false);
    const { copies, left, lifted } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(copies.map((op) => op.type)).toEqual(["move", "rename", "rename"]);
    expect(left).toEqual([]);
    expect(lifted.map(({ node, copy }) => [node, copy.type])).toEqual([[ch, "move"]]);
    expect(t.at(ch)).toMatchObject({ trashed: false, parent: arc, displayName: "The Fall" });
    expect(fingerprint(t.w.view(D), false)).toBe(before);
    t.valid();
  });

  it("9b. the draft deleted it too: the delete wins in the Work's view", () => {
    const t = start();
    const arc = t.folder("Arc 3");
    const ch = t.chapter("Chapter 49");
    t.w.move(D, CHAT, ch, arc);
    t.w.delete(D, CHAT, ch);
    t.w.delete(LIVE, WRITER, ch);
    expect(t.at(ch, D)).toMatchObject({ trashed: true, keptByPending: false });
  });

  it("10. draft edited a chapter's text, live deleted the chapter (and its folder): the Work's view still shows it, marked", () => {
    const t = start();
    const f = t.folder("Doomed");
    const ch = t.chapter("Letter", f);
    t.w.delete(LIVE, WRITER, f);
    // The text draft is not in the tree list; the view is told which documents the Work holds
    // a pending text draft of.
    const view = replayView(t.doc, D, new Set([ch]));
    expect(view.nodes.get(ch)).toMatchObject({ trashed: false, keptByPending: true });
    expect(view.nodes.get(f)).toMatchObject({ trashed: false, keptByChild: true });
    expect(treeViolations(view)).toEqual([]);
    // Without a pending text draft, and in live, it is in Trash.
    expect(t.at(ch, D)?.trashed).toBe(true);
    expect(t.at(ch)?.trashed).toBe(true);
  });

  it("11. draft deleted a chapter, live edited its text: the delete applies; the tree list holds what review needs to warn", () => {
    const t = start();
    const ch = t.chapter("Chapter 49");
    const drafted = t.w.delete(D, CHAT, ch);
    // A live text edit writes nothing to the tree list. Review compares the document's text
    // journal with the time of the drafted delete.
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.at(ch)?.trashed).toBe(true);
    expect(drafted.actor).toBe(CHAT);
  });

  it("12. draft edited text, live moved and renamed the chapter: the node id is unchanged, so the text draft follows it", () => {
    const t = start();
    const arc = t.folder("Arc 3");
    const ch = t.chapter("Chapter 49");
    t.w.move(LIVE, WRITER, ch, arc);
    t.w.rename(LIVE, WRITER, ch, "The Fall");
    expect(t.at(ch, D)).toMatchObject({ id: ch, parent: arc, displayName: "The Fall" });
  });
});

describe("part 2: two authors inside one Work's draft", () => {
  it("13. both delete a folder, one not knowing about a new chapter: both count, one restore undoes both", () => {
    const t = start();
    const f = t.folder("Arc 2");
    const old = t.chapter("Chapter 1", f);
    // Chat 1 lists the folder and decides to delete; before its delete is written, chat 2 adds a
    // chapter and then deletes the folder having seen it.
    const seenByChat1 = [old];
    const added = t.chapter("Chapter 2", f, D, CHAT2);
    t.w.delete(D, CHAT2, f);
    t.w.author(D, CHAT, { type: "delete", node: f, cascade: seenByChat1 });
    expect(t.at(f, D)?.trashed).toBe(true);
    expect(t.at(added, D)?.trashed).toBe(true);
    t.w.restore(D, WRITER, f);
    expect([f, old, added].map((n) => t.at(n, D)?.trashed)).toEqual([false, false, false]);
    t.valid();
  });

  it("14. one discards 'create Arc' while the other had added a scene inside it: the scene is discarded with it when the discard saw it, and shown at the top when it did not", () => {
    const t = start();
    const arc = t.folder("Arc", ROOT, D, CHAT);
    const createArc = recordsOf(t.doc)
      .toArray()
      .find((op) => op.type === "create" && op.node === arc) as TreeRecord;
    const scene = t.chapter("Scene", arc, D, CHAT2);
    // Discard that saw the scene takes it too (case 20).
    const both = start();
    const arc2 = both.folder("Arc", ROOT, D, CHAT);
    both.chapter("Scene", arc2, D, CHAT2);
    const create2 = recordsOf(both.doc).toArray()[0] as TreeRecord;
    expect(discardDraft(both.w, "work-1", WRITER, cmd(), [create2.id])).toHaveLength(2);
    // A discard that did not see the scene (two writers, or a scene written after the discard
    // was computed): only the folder's create is settled.
    t.doc.transact(() => t.w.settle(CHAT, [createArc.id], "discarded"));
    const view = t.w.view(D);
    expect(view.rescued).toHaveLength(1);
    expect(view.nodes.get(scene)).toMatchObject({ parent: ROOT, trashed: false });
    expect(treeViolations(view)).toEqual([]);
  });

  it("15. both rename one chapter: one name, the later record's", () => {
    const t = start();
    const ch = t.chapter("Chapter 49");
    t.w.rename(D, CHAT, ch, "First");
    t.w.rename(D, CHAT2, ch, "Second");
    expect(t.at(ch, D)?.displayName).toBe("Second");
  });

  it("16. both create a chapter with one name in one folder: both stay, the later numbered", () => {
    const t = start();
    const f = t.folder("F");
    const first = t.chapter("Notes", f, D, CHAT);
    const second = t.chapter("Notes", f, D, CHAT2);
    expect([t.at(first, D)?.displayName, t.at(second, D)?.displayName]).toEqual([
      "Notes",
      "Notes (2)",
    ]);
  });
});

describe("part 3: Apply, Discard and Undo on part of a draft", () => {
  function reorganisation() {
    const t = start();
    const ch1 = t.chapter("Chapter 1");
    const ch2 = t.chapter("Chapter 2");
    const arc = t.folder("Arc", ROOT, D, CHAT);
    const scene = t.chapter("Scene", arc, D, CHAT);
    const moved = t.w.move(D, CHAT, ch1, arc);
    const renamed1 = t.w.rename(D, CHAT, ch2, "Second");
    const renamed2 = t.w.rename(D, CHAT, ch2, "Third");
    const drafted = () =>
      viewRecords(t.doc, D)
        .filter((op) => op.draft === "work-1")
        .map((op) => op.id);
    const idOf = (type: string, node: string) =>
      recordsOf(t.doc)
        .toArray()
        .find((op) => op.type === type && op.node === node && op.draft === "work-1")?.id as string;
    return { ...t, ch1, ch2, arc, scene, moved, renamed1, renamed2, drafted, idOf };
  }

  it("17. applies 'Scene in Arc' only: 'create Arc' comes with it, the rest stays drafted", () => {
    const t = reorganisation();
    const before = fingerprint(t.w.view(D));
    const { copies } = applyDraft(t.w, "work-1", WRITER, cmd(), [t.idOf("create", t.scene)]);
    expect(copies.map((op) => op.node)).toEqual([t.arc, t.scene]);
    expect(t.at(t.ch1)?.parent).toBe(ROOT);
    expect(fingerprint(t.w.view(D))).toBe(before);
    expect(t.drafted()).toEqual([t.moved.id, t.renamed1.id, t.renamed2.id]);
  });

  it("18. applies the second of two renames: the first comes with it", () => {
    const t = reorganisation();
    const { copies } = applyDraft(t.w, "work-1", WRITER, cmd(), [t.renamed2.id]);
    expect(copies.map((op) => op.carries)).toEqual([t.renamed1.id, t.renamed2.id]);
    expect(t.at(t.ch2)?.displayName).toBe("Third");
  });

  it("19. applies a move that depends on an earlier drafted move: both are taken, the draft's view is unchanged", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B");
    const c = t.folder("C");
    t.w.move(LIVE, WRITER, b, a); // live: A/B, C
    const first = t.w.move(D, CHAT, b, ROOT); // draft: B out of A
    const second = t.w.move(D, CHAT, a, b); // draft: A into B, valid only after the first
    void c;
    const before = fingerprint(t.w.view(D));
    const { copies } = applyDraft(t.w, "work-1", WRITER, cmd(), [second.id]);
    expect(copies.map((op) => op.carries)).toEqual([first.id, second.id]);
    expect(fingerprint(t.w.view(D))).toBe(before);
    expect(t.at(a)?.parent).toBe(b);
    t.valid();
  });

  it("20. discards 'create Arc': everything made in or moved into Arc goes with it, the rest stays", () => {
    const t = reorganisation();
    const gone = discardDraft(t.w, "work-1", WRITER, cmd(), [t.idOf("create", t.arc)]);
    expect(gone).toHaveLength(3);
    expect(t.at(t.ch1, D)?.parent).toBe(ROOT);
    expect(t.at(t.arc, D)).toBeUndefined();
    expect(t.at(t.ch2, D)?.displayName).toBe("Third");
  });

  it("21. applies everything: live equals what the Work's view showed", () => {
    const t = reorganisation();
    const before = fingerprint(t.w.view(D));
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(fingerprint(t.w.view(LIVE))).toBe(before);
    expect(t.drafted()).toEqual([]);
  });

  it("22. discards everything: the Work's view equals live", () => {
    const t = reorganisation();
    discardDraft(t.w, "work-1", WRITER, cmd());
    expect(fingerprint(t.w.view(D))).toBe(fingerprint(t.w.view(LIVE)));
  });

  it("23. undoes an applied move: the chapter returns to its exact place", () => {
    const t = reorganisation();
    const before = fingerprint(t.w.view(LIVE));
    const { copies } = applyDraft(t.w, "work-1", WRITER, cmd(), [t.moved.id]);
    const applied = copies.find((op) => op.carries === t.moved.id) as TreeRecord;
    const inverse = undoChange(t.w, LIVE, WRITER, applied.id);
    expect(inverse).toMatchObject({ type: "move", undoes: t.moved.id });
    expect(t.at(t.ch1)?.parent).toBe(ROOT);
    // The Arc folder came with the move; undoing the move leaves the folder (undo is per record).
    expect(fingerprint(t.w.view(LIVE))).not.toBe(before);
    expect(t.names(ROOT)).toEqual(["Chapter 1", "Chapter 2", "Arc"]);
  });

  it("24. undoes a move after someone moved the chapter again: refused as changed since", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B");
    const ch = t.chapter("Chapter 1");
    const move = t.w.move(LIVE, CHAT, ch, a);
    t.w.move(LIVE, WRITER, ch, b);
    expect(undoChange(t.w, LIVE, WRITER, move.id)).toBe("changed_since");
  });

  it("25. undoes a move back into a folder deleted since: the chapter stands in it, so the folder stands (rule 3)", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B");
    const ch = t.chapter("Chapter 1", a);
    const move = t.w.move(LIVE, CHAT, ch, b);
    t.w.delete(LIVE, WRITER, a);
    expect(undoChange(t.w, LIVE, WRITER, move.id)).toMatchObject({ type: "move", undoes: move.id });
    expect(t.at(ch)).toMatchObject({ parent: a, trashed: false });
    expect(t.at(a)).toMatchObject({ trashed: false, keptByChild: true });
  });

  it("26. undoes a folder delete: the folder and its contents come back", () => {
    const t = start();
    const f = t.folder("Arc 2");
    const ch = t.chapter("Chapter 1", f);
    const del = t.w.delete(LIVE, WRITER, f);
    expect(t.at(ch)?.trashed).toBe(true);
    undoChange(t.w, LIVE, WRITER, del.id);
    expect([t.at(f)?.trashed, t.at(ch)?.trashed]).toEqual([false, false]);
  });

  it("27. restores a chapter beside one of the same name: the restored one is numbered", () => {
    const t = start();
    const old = t.chapter("Notes");
    t.w.delete(LIVE, WRITER, old);
    const standing = t.chapter("Notes");
    t.w.restore(LIVE, WRITER, old);
    expect([t.at(standing)?.displayName, t.at(old)?.displayName]).toEqual(["Notes", "Notes (2)"]);
  });

  it("28. applies a Work where one part cannot land: the rest lands; the part is reported before and after, and stays in the draft", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B");
    const ch = t.chapter("Chapter 1");
    const gone = t.chapter("Chapter 2");
    const loop = t.w.move(D, CHAT, a, b);
    t.w.rename(D, CHAT, ch, "Renamed");
    const revived = t.w.rename(D, CHAT, gone, "Brought back");
    t.w.move(LIVE, WRITER, b, a);
    t.w.delete(LIVE, WRITER, gone);
    // Before Apply, the draft's view already says which part cannot land.
    expect(t.w.view(D).skipped).toEqual([{ record: loop.id, reason: "cycle" }]);
    expect(targetGone(t.doc, D).map((op) => op.node)).toEqual([gone]);
    const { copies, left } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(copies.map((op) => op.carries)).toEqual([expect.any(String), revived.id]);
    expect(left.map(({ record, why }) => [record.id, why])).toEqual([[loop.id, "would_loop"]]);
    expect(t.at(ch)?.displayName).toBe("Renamed");
    expect(t.at(a)?.parent).toBe(ROOT);
    // The rename of a node live had in Trash lands and brings it back (rule 9).
    expect(t.at(gone)).toMatchObject({ trashed: false, name: "Brought back" });
    // The writer fixes the cause in live, and the same drafted move now lands.
    t.w.move(LIVE, WRITER, b, ROOT);
    expect(t.w.view(D).skipped).toEqual([]);
    expect(applyDraft(t.w, "work-1", WRITER, cmd()).copies.map((op) => op.carries)).toEqual([
      loop.id,
    ]);
    expect(t.at(a)?.parent).toBe(b);
    t.valid();
  });
});

describe("found in review", () => {
  it("a move that would loop, followed by the move that makes it possible: the second lands, the first then shows as able to land, and lands next", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B", a); // live: A/B
    const loop = t.w.move(D, CHAT, a, b); // would put A inside itself
    const out = t.w.move(D, CHAT, b, ROOT);
    expect(t.w.view(D).skipped).toEqual([{ record: loop.id, reason: "cycle" }]);
    const first = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(first.copies.map((op) => op.carries)).toEqual([out.id]);
    expect(first.left.map(({ record }) => record.id)).toEqual([loop.id]);
    expect(t.at(b)?.parent).toBe(ROOT);
    expect(t.at(a)?.parent).toBe(ROOT);
    // Still pending, never marked applied, and now it fits.
    expect(t.w.view(D).skipped).toEqual([]);
    expect(t.at(a, D)?.parent).toBe(b);
    const second = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(second.copies.map((op) => op.carries)).toEqual([loop.id]);
    expect(t.at(a)?.parent).toBe(b);
    t.valid();
  });

  it("restoring one chapter out of a deleted folder brings back only that chapter; the folder stands holding it", () => {
    const t = start();
    const f = t.folder("Arc 2");
    const [c1, c2, c3] = ["c1", "c2", "c3"].map((n) => t.chapter(n, f)) as [string, string, string];
    t.w.delete(LIVE, WRITER, f);
    t.w.restore(LIVE, WRITER, c1);
    expect([c1, c2, c3].map((n) => t.at(n)?.trashed)).toEqual([false, true, true]);
    expect(t.at(f)).toMatchObject({ trashed: false, keptByChild: true });
    // Restoring the folder brings back the rest.
    t.w.restore(LIVE, WRITER, f);
    expect([c1, c2, c3].map((n) => t.at(n)?.trashed)).toEqual([false, false, false]);
    t.valid();
  });

  it("Undo of a delete after someone deleted it again: refused, so one author's Undo never reverses another's delete", () => {
    const t = start();
    const f = t.folder("F");
    t.chapter("x", f);
    const byChat = t.w.delete(LIVE, CHAT, f);
    t.w.restore(LIVE, WRITER, f);
    const y = t.chapter("y", f);
    t.w.delete(LIVE, WRITER, f);
    expect(undoChange(t.w, LIVE, CHAT, byChat.id)).toBe("already");
    expect([t.at(f)?.trashed, t.at(y)?.trashed]).toEqual([true, true]);
  });

  it("a Discard and an Undo of an Apply are records with an actor, and the list holds no deletions", () => {
    const t = reorganisedOnce();
    const log = () => t.doc.getArray<{ actor: string; to: string }>("settle").toArray();
    const { command } = applyDraft(t.w, "work-1", WRITER, cmd());
    const vectorAfterApply = Y.encodeStateVector(t.doc);
    undoApply(t.w, command, WRITER, cmd());
    expect(Y.encodeStateVector(t.doc)).not.toEqual(vectorAfterApply);
    discardDraft(t.w, "work-1", CHAT, cmd());
    expect(log().map((record) => [record.actor, record.to])).toEqual([
      [WRITER, "applied"],
      [WRITER, "pending"],
      [CHAT, "discarded"],
    ]);
    // Nothing in the doc was deleted: the delete set is empty.
    const snapshot = Y.snapshot(t.doc);
    expect(snapshot.ds.clients.size).toBe(0);
  });
});

describe("found in the second review", () => {
  it("a chat takes back its drafted delete of a chapter the writer has since deleted in live: it stays deleted, and Apply does not bring it back", () => {
    const t = start();
    const x = t.chapter("X");
    const drafted = t.w.delete(D, CHAT, x);
    t.w.delete(LIVE, WRITER, x);
    expect(undoChange(t.w, D, CHAT, drafted.id)).toMatchObject({
      type: "restore",
      undoes: drafted.id,
    });
    expect(t.at(x, D)?.trashed).toBe(true);
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.at(x)?.trashed).toBe(true);
    // The writer's own restore brings it back.
    t.w.restore(LIVE, WRITER, x);
    expect(t.at(x)?.trashed).toBe(false);
  });

  it("a move that cannot land and that the draft later overrode is settled, not left to come back", () => {
    const t = start();
    const x = t.folder("X");
    const b = t.folder("B", x); // live: X/B
    const c = t.folder("C");
    const loop = t.w.move(D, CHAT, x, b);
    t.w.move(D, CHAT, b, ROOT);
    t.w.move(D, CHAT, x, c);
    expect(t.at(x, D)?.parent).toBe(c);
    const before = fingerprint(t.w.view(D));
    const landed = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(landed.superseded.map((op) => op.id)).toEqual([loop.id]);
    expect(landed.left).toEqual([]);
    expect(t.at(x)?.parent).toBe(c);
    expect(fingerprint(t.w.view(D))).toBe(before);
    expect(applyDraft(t.w, "work-1", WRITER, cmd()).copies).toEqual([]);
    expect(t.at(x)?.parent).toBe(c);
  });

  it("a drafted rename of a folder that live deleted lands when the same Apply puts something in the folder", () => {
    const t = start();
    const k = t.folder("K");
    const y = t.chapter("Y");
    t.w.rename(D, CHAT, k, "K renamed");
    t.w.move(D, CHAT, y, k);
    t.w.delete(LIVE, WRITER, k);
    const landed = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(landed.left).toEqual([]);
    // The landed rename acts on a node in Trash, which restores it (rule 9).
    expect(t.at(k)).toMatchObject({ displayName: "K renamed", trashed: false, keptByChild: false });
    expect(t.at(y)?.parent).toBe(k);
    t.valid();
  });
});

describe("a purge empties one Trash entry", () => {
  it("takes what the delete took, wherever the purge sits (rule 10)", () => {
    const t = start();
    const arc = t.folder("Arc");
    const ch = t.chapter("Chapter", arc);
    const removal = t.w.delete(LIVE, WRITER, arc);
    // The server purged what it held, both; the restore, placed before the purge, came later.
    t.w.restore(LIVE, WRITER, ch);
    t.w.purge("system", removal, [arc, ch]);
    expect(t.w.view(LIVE).skipped).toEqual([]);
    expect(t.w.view(LIVE).nodes.get(arc)).toMatchObject({ purged: true });
    expect(t.w.view(LIVE).nodes.get(ch)).toMatchObject({ purged: true });

    const gone = start();
    const folder = gone.folder("Old");
    const inside = gone.chapter("Inside", folder);
    purge(gone.w, gone.w.delete(LIVE, WRITER, folder));
    expect(gone.w.view(LIVE).nodes.get(inside)).toMatchObject({ purged: true });
    expect(gone.w.view(LIVE).trash).toEqual([]);
  });
});

describe("a purged node is absent from every view, for placement as for display", () => {
  it("a create into a purged folder is rescued to the top of its source, and a move into it is skipped", () => {
    const t = start();
    const old = t.folder("Old");
    const kept = t.chapter("Kept");
    purge(t.w, t.w.delete(LIVE, "system", old));
    const made = t.w.create(LIVE, WRITER, {
      kind: "document",
      filetype: "markdown",
      name: "New",
      parent: old,
    }).node;
    const moved = t.w.move(LIVE, WRITER, kept, old);
    const live = t.w.view(LIVE);
    expect(t.at(made)).toMatchObject({ parent: ROOT, trashed: false });
    expect(live.rescued).toContain(
      recordsOf(t.doc)
        .toArray()
        .find((r) => r.node === made)?.id,
    );
    expect(live.skipped).toContainEqual({ record: moved.id, reason: "missing-parent" });
    expect(t.at(kept)?.parent).toBe(ROOT);
    expect(treeViolations(live)).toEqual([]);
  });
});

describe("Undo of an Apply, fact by fact", () => {
  /** What a view shows: each standing node with where it is. */
  const shown = (t: ReturnType<typeof start>, view: View = LIVE) =>
    [...t.w.view(view).nodes.values()]
      .filter((node) => !node.trashed)
      .map((node) => [node.displayName, node.parent])
      .sort();

  it("at once: live reads as before, the Work as it was, and it can be applied again", () => {
    const t = reorganisedOnce();
    const [live, draft] = [shown(t), shown(t, D)];
    const { command } = applyDraft(t.w, "work-1", WRITER, cmd());
    const result = undoApply(t.w, command, WRITER, cmd());
    expect(result.left).toEqual([]);
    expect(result.undone.map((record) => record.type)).toEqual(["move", "delete"]);
    expect(shown(t)).toEqual(live);
    expect(shown(t, D)).toEqual(draft);
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(shown(t)).toEqual(draft);
  });

  it("what someone else did since survives: a later rename, and a node put in a created folder", () => {
    const t = start();
    const arc = t.folder("Arc", ROOT, D, CHAT);
    const ch = t.chapter("Chapter 1");
    const other = t.chapter("Elsewhere");
    t.w.move(D, CHAT, ch, arc);
    const { command } = applyDraft(t.w, "work-1", WRITER, cmd());
    t.w.rename(LIVE, WRITER, other, "Renamed since");
    const stray = t.chapter("Stray", arc);
    const result = undoApply(t.w, command, WRITER, cmd());
    expect(result.left).toEqual([]);
    expect(t.at(other)?.displayName).toBe("Renamed since");
    // The created folder is gone, but what was put in it since stands, and keeps it standing.
    expect(t.at(arc)).toMatchObject({ trashed: false, keptByChild: true });
    expect(t.at(stray)).toMatchObject({ trashed: false, parent: arc });
    expect(t.at(ch)).toMatchObject({ trashed: false, parent: ROOT });
  });

  it("a fact someone changed since stays, named; the others go back and are pending again", () => {
    const t = start();
    const a = t.chapter("A");
    const b = t.chapter("B");
    t.w.rename(D, CHAT, a, "A by the Work");
    t.w.rename(D, CHAT, b, "B by the Work");
    const { command } = applyDraft(t.w, "work-1", WRITER, cmd());
    t.w.rename(LIVE, WRITER, a, "A by the writer");
    const result = undoApply(t.w, command, WRITER, cmd());
    expect(result.left.map(({ record, why }) => [record.node, why])).toEqual([
      [a, "changed_since"],
    ]);
    expect(t.at(a)?.displayName).toBe("A by the writer");
    expect(t.at(b)?.displayName).toBe("B");
    expect(pendingRecords(t.doc, "work-1").map((record) => record.node)).toEqual([b]);
  });

  it("a document with text written since stays, and the folder it stands in while it does", () => {
    const t = start();
    const folder = t.folder("Arc", ROOT, D, CHAT);
    const ch = t.chapter("Chapter 50", folder, D, CHAT);
    const { command } = applyDraft(t.w, "work-1", WRITER, cmd());
    const result = undoApply(t.w, command, WRITER, cmd(), { writtenSince: new Set([ch]) });
    expect(result.left.map(({ record, why }) => [record.node, why])).toEqual([[ch, "has_text"]]);
    expect(t.at(ch)).toMatchObject({ trashed: false, parent: folder });
    expect(t.at(folder)).toMatchObject({ trashed: false, keptByChild: true });
  });

  it("a second Undo of the same Apply has nothing to take back", () => {
    const t = reorganisedOnce();
    const { command } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(undoApply(t.w, command, WRITER, cmd()).undone).not.toEqual([]);
    expect(undoApply(t.w, command, WRITER, cmd())).toEqual({ undone: [], left: [] });
  });

  it("an Apply that landed only what the press saw can be undone: after_press stays pending", () => {
    const t = start();
    const a = t.chapter("A");
    t.w.rename(D, CHAT, a, "Seen");
    const saw = Y.encodeStateVector(t.doc);
    const late = t.w.rename(D, CHAT, a, "Typed after the press");
    const result = applyDraft(t.w, "work-1", WRITER, cmd(), undefined, saw);
    expect(result.copies.map((copy) => (copy.type === "rename" ? copy.name : null))).toEqual([
      "Seen",
    ]);
    expect(result.left.map(({ record, why }) => [record.id, why])).toEqual([
      [late.id, "after_press"],
    ]);
    expect(t.at(a)?.displayName).toBe("Seen");
  });
});

function reorganisedOnce() {
  const t = start();
  const ch = t.chapter("Chapter 1");
  const arc = t.folder("Arc", ROOT, D, CHAT);
  t.w.move(D, CHAT, ch, arc);
  return t;
}

describe("an Apply's copy that a later record undid is no longer in force", () => {
  const inLive = (t: ReturnType<typeof start>, command: string) => appliedNodes(t.doc, command, []);

  it("a card's Undo of the drafted rename ends the Apply's copy", () => {
    const t = start();
    const n = t.chapter("Hall");
    const drafted = t.w.rename(D, CHAT, n, "Lobby");
    const { command, copies } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(inLive(t, command)).toEqual([n]);
    undoChange(t.w, D, CHAT, drafted.id);
    expect(t.at(n)?.displayName).toBe("Hall");
    expect(inLive(t, command)).toEqual([]);
    expect(undoChange(t.w, LIVE, WRITER, (copies[0] as TreeRecord).id)).toBe("already");
    expect(undoApply(t.w, command, WRITER, cmd())).toMatchObject({
      undone: [],
      left: [{ why: "already" }],
    });
  });

  it("the same for a move that also set a name", () => {
    const t = start();
    const folder = t.folder("Arc");
    t.chapter("Hall", folder);
    const n = t.chapter("Hall");
    const drafted = t.w.move(D, CHAT, n, folder);
    expect(drafted.name).toBeDefined();
    const { command } = applyDraft(t.w, "work-1", WRITER, cmd());
    const moved = { displayName: drafted.name, parent: folder };
    expect(t.at(n)).toMatchObject(moved);
    undoChange(t.w, D, CHAT, drafted.id);
    expect(t.at(n)).toMatchObject({ displayName: "Hall", parent: ROOT });
    expect(inLive(t, command)).toEqual([]);
    expect(undoApply(t.w, command, WRITER, cmd()).undone).toEqual([]);
  });

  it("an Apply that only restores lists the node until Un-Apply or an Undo of the restore takes it back", () => {
    for (const how of ["unapply", "undo"] as const) {
      const t = start();
      const n = t.chapter("Hall");
      t.w.delete(LIVE, WRITER, n);
      const restore = t.w.restore(LIVE, WRITER, n);
      const { command } = applyDraft(t.w, "work-1", WRITER, cmd());
      const mine = [restore.id];
      expect(appliedNodes(t.doc, command, mine)).toEqual([n]);
      if (how === "unapply") {
        const result = undoApply(t.w, command, WRITER, cmd(), { restoredByApply: mine });
        expect(result.left).toEqual([]);
      } else undoChange(t.w, LIVE, WRITER, restore.id);
      expect(t.at(n)?.trashed).toBe(true);
      expect(appliedNodes(t.doc, command, mine)).toEqual([]);
    }
  });
});

describe("part 5: what a document is", () => {
  it("29. a document's type is its create's until a rename changes it; a provisional name ends at the first rename by a person, even to the same name", () => {
    const t = start();
    const ch = t.w.create(LIVE, WRITER, {
      kind: "document",
      filetype: "markdown",
      name: "Untitled",
      parent: ROOT,
      provisional: true,
    }).node;
    t.w.rename(LIVE, CHAT, ch, "Untitled.toml", "text");
    expect(t.at(ch)).toMatchObject({ filetype: "text", provisional: true });
    expect(projectedRows(t.w.view(LIVE)).get(ch)).toMatchObject({
      filetype: "text",
      extension: "toml",
    });
    t.w.rename(LIVE, WRITER, ch, "Untitled.toml");
    expect(t.at(ch)).toMatchObject({ filetype: "text", provisional: false });
  });

  it("32. undoes a drafted create after Discard then restore: takes back the pending copy", () => {
    const t = start();
    const ch = t.chapter("Chapter 1", ROOT, D, CHAT);
    const created = recordsOf(t.doc).toArray()[0] as TreeRecord;
    const command = cmd();
    discardDraft(t.w, "work-1", WRITER, command);
    expect(undoChange(t.w, D, CHAT, created.id)).toBe("already");
    const restored = restoreDiscard(t.w, command, WRITER, "work-1", cmd());
    if (restored === "already") throw new Error("expected copies");
    const [copy] = restored.copies;
    expect(copy).toMatchObject({ carries: created.id });
    const inverse = undoChange(t.w, D, CHAT, created.id);
    expect(inverse).toMatchObject({ type: "delete", node: ch, undoes: created.id });
    expect(t.at(ch, D)?.trashed).toBe(true);
    expect(t.at(ch)).toBeUndefined();
  });

  it("33. undoes by a drafted record's id after Apply: takes back the live copy", () => {
    const t = start();
    const ch = t.chapter("Chapter 1");
    const renamed = t.w.rename(D, CHAT, ch, "Draft name");
    const { copies } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(copies[0]).toMatchObject({ carries: renamed.id });
    expect(undoChange(t.w, LIVE, WRITER, renamed.id)).toMatchObject({
      type: "rename",
      undoes: renamed.id,
    });
    expect(t.at(ch)?.displayName).toBe("Chapter 1");
    expect(undoChange(t.w, LIVE, WRITER, renamed.id)).toBe("already");
  });

  it("34. restores a Discard into another branch: the copies are pending there", () => {
    const t = start();
    const ch = t.chapter("Chapter 1");
    t.w.rename(D, CHAT, ch, "Draft name");
    const command = cmd();
    discardDraft(t.w, "work-1", WRITER, command);
    const restored = restoreDiscard(t.w, command, WRITER, "work-2", cmd());
    if (restored === "already") throw new Error("expected copies");
    expect(restored.copies.map((copy) => copy.draft)).toEqual(["work-2"]);
    expect(t.at(ch, { draft: "work-2" })?.displayName).toBe("Draft name");
    expect(t.at(ch, D)?.displayName).toBe("Chapter 1");
  });

  it("35. restores a Discard over a newer draft: the newer record is discarded under the restore, and restoring that brings it back", () => {
    const t = start();
    const ch = t.chapter("Chapter 1");
    t.w.rename(D, CHAT, ch, "Old");
    const first = cmd();
    discardDraft(t.w, "work-1", WRITER, first);
    t.w.rename(D, CHAT, ch, "New");
    expect(t.at(ch, D)?.displayName).toBe("New");
    const restore = cmd();
    expect(restoreDiscard(t.w, first, WRITER, "work-1", restore)).not.toBe("already");
    expect(t.at(ch, D)?.displayName).toBe("Old");
    expect(pendingRecords(t.doc, "work-1").map((op) => op.type === "rename" && op.name)).toEqual([
      "Old",
    ]);
    const second = discardedBy(t.doc, restore);
    expect(second.records.map((op) => op.type === "rename" && op.name)).toEqual(["New"]);
    expect(restoreDiscard(t.w, restore, WRITER, "work-1", cmd())).not.toBe("already");
    expect(t.at(ch, D)?.displayName).toBe("New");
  });

  it("36. restores a discarded selective Undo: it lifts the delete it undid, not another actor's pending delete", () => {
    const t = start();
    const ch = t.chapter("Chapter 1");
    const mine = t.w.delete(D, CHAT, ch);
    t.w.author(D, CHAT, { type: "restore", node: ch }, { undoes: mine.id });
    const second = cmd();
    discardDraft(t.w, "work-1", WRITER, second);
    const theirs = t.w.delete(D, CHAT2, ch);
    const restored = restoreDiscard(t.w, second, WRITER, "work-1", cmd());
    expect(restored).not.toBe("already");
    expect(pendingRecords(t.doc, "work-1").map((op) => op.id)).toContain(theirs.id);
    expect(t.at(ch, D)?.trashed).toBe(true);
  });

  it("37. an intermediate copy's id resolves to the record in force: Undo and Trash restore take it", () => {
    const t = start();
    const ch = t.chapter("Chapter 1");
    const gone = t.chapter("Chapter 2");
    t.w.rename(D, CHAT, ch, "Draft name");
    t.w.delete(D, CHAT, gone);
    const ids: string[][] = [];
    for (let round = 0; round < 2; round += 1) {
      const command = cmd();
      discardDraft(t.w, "work-1", WRITER, command);
      const restored = restoreDiscard(t.w, command, WRITER, "work-1", cmd());
      if (restored === "already") throw new Error("expected copies");
      ids.push(restored.copies.map((copy) => copy.id));
    }
    const { copies } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(copies).toHaveLength(2);
    // The first round's copies are in no view now: only the second round's copies were applied.
    expect(undoChange(t.w, LIVE, WRITER, ids[0][0])).toMatchObject({ type: "rename" });
    expect(t.at(ch)?.displayName).toBe("Chapter 1");
    expect(t.w.restoreEntry(LIVE, WRITER, ids[0][1])).toMatchObject({ type: "restore" });
    expect(t.at(gone)?.trashed).toBe(false);
  });

  it("38. a drafted change that was taken back and Applied leaves the earlier one undoable", () => {
    const t = start();
    const ch = t.chapter("Original");
    const first = t.w.rename(D, CHAT, ch, "First");
    const second = t.w.rename(D, CHAT, ch, "Second");
    expect(undoChange(t.w, D, CHAT, second.id)).toMatchObject({ type: "rename" });
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.at(ch)?.displayName).toBe("First");
    expect(undoChange(t.w, LIVE, WRITER, first.id)).toMatchObject({ type: "rename" });
    expect(t.at(ch)?.displayName).toBe("Original");
  });
});

describe("replay rules 9 to 13", () => {
  it("9. a move or rename of a node in Trash restores it; an Undo of it puts the delete back", () => {
    const t = start();
    const arc = t.folder("Arc");
    const ch = t.chapter("Chapter");
    const removed = t.chapter("Removed");
    t.w.delete(LIVE, WRITER, ch);
    t.w.delete(LIVE, WRITER, removed);
    const move = t.w.move(LIVE, CHAT, ch, arc);
    const rename = t.w.rename(LIVE, WRITER, removed, "Back");
    expect(t.at(ch)).toMatchObject({ trashed: false, parent: arc });
    expect(t.at(removed)).toMatchObject({ trashed: false, displayName: "Back" });
    expect(undoChange(t.w, LIVE, WRITER, move.id)).not.toBe("already");
    expect(t.at(ch)?.trashed).toBe(true);
    expect(undoChange(t.w, LIVE, WRITER, rename.id)).not.toBe("already");
    expect(t.at(removed)?.trashed).toBe(true);
    t.valid();
  });

  it("9. a drafted record lifts only the Work's own deletes; a live record lifts live ones", () => {
    const t = start();
    const live = t.chapter("Live deleted");
    const own = t.chapter("Drafted deleted");
    t.w.delete(LIVE, WRITER, live);
    t.w.rename(D, CHAT, live, "Renamed in the Work");
    t.w.delete(D, CHAT, own);
    t.w.rename(D, CHAT, own, "Renamed after its own delete");
    expect(t.at(live)?.trashed).toBe(true);
    // The Work's view keeps the live-deleted node standing while it has a pending change (rule 7).
    expect(t.at(live, D)).toMatchObject({ trashed: false, keptByPending: true });
    expect(t.at(own, D)).toMatchObject({
      trashed: false,
      displayName: "Renamed after its own delete",
    });
  });

  it("10. a purge is final: a restore or move placed before it does not bring the node back", () => {
    const t = start();
    const ch = t.chapter("Chapter");
    const removal = t.w.delete(LIVE, WRITER, ch);
    t.w.restore(LIVE, WRITER, ch);
    t.w.purge("system", removal, [ch]);
    t.w.rename(LIVE, WRITER, ch, "After the purge");
    expect(t.at(ch)).toMatchObject({ purged: true });
    expect(t.w.view(LIVE).skipped.map((skip) => skip.reason)).toEqual(["purged"]);
  });

  it("10b. a purge takes exactly the nodes it names: one moved out is kept, one moved in goes to its source's top", () => {
    const t = start();
    const folder = t.folder("F");
    const child = t.chapter("C", folder);
    const other = t.chapter("D");
    // The move reaches the list before the delete, which was made by someone who still saw C in F.
    t.w.move(LIVE, CHAT, child, ROOT);
    // Placed before the delete, admitted after the server worked out what the purge takes.
    t.w.move(LIVE, CHAT, other, folder);
    const removal = t.w.author(LIVE, WRITER, { type: "delete", node: folder, cascade: [child] });
    t.w.purge("system", removal, [folder]);
    expect(t.at(folder)).toMatchObject({ purged: true });
    expect(t.at(child)).toMatchObject({ purged: false, trashed: false });
    expect(t.at(other)).toMatchObject({ parent: ROOT, purged: false, trashed: false });
    expect(t.names(ROOT).sort()).toEqual(["C", "D"]);
    expect(t.w.view(LIVE).trash).toEqual([]);
    t.valid();
  });

  it("11. a document create or rename to a type that is not tracked is skipped", () => {
    const t = start();
    const pdf = t.w.create(LIVE, WRITER, {
      kind: "document",
      filetype: "pdf",
      name: "Scan",
      parent: ROOT,
    }).node;
    const ch = t.chapter("Chapter");
    t.w.rename(LIVE, WRITER, ch, "Scan.pdf", "pdf");
    expect(t.at(pdf)).toBeUndefined();
    expect(t.at(ch)).toMatchObject({ displayName: "Chapter", filetype: "markdown" });
    expect(t.w.view(LIVE).skipped.map((skip) => skip.reason)).toEqual([
      "type-not-editable",
      "type-not-editable",
    ]);
  });

  it("12. a rename to a type of another schema is skipped whole, name included", () => {
    const t = start();
    const ch = t.chapter("Chapter");
    t.w.rename(LIVE, WRITER, ch, "Chapter.py", "python");
    t.w.rename(LIVE, WRITER, ch, "Chapter.toml", "text");
    expect(t.at(ch)).toMatchObject({ displayName: "Chapter.toml", filetype: "text" });
    expect(t.w.view(LIVE).skipped.map((skip) => skip.reason)).toEqual(["type-across-schemas"]);
  });

  it("13. a record's name is shown as normalEntryName of it, whoever wrote it", () => {
    const t = start();
    const folder = t.folder("Arc");
    const ch = t.chapter("Chapter");
    t.w.author(LIVE, CHAT, { type: "rename", node: folder, name: "1/2", fromName: "Arc" });
    t.w.author(LIVE, CHAT, { type: "rename", node: ch, name: "notes.md", fromName: "Chapter" });
    expect(t.at(folder)?.displayName).toBe("1∕2");
    expect(t.at(ch)?.displayName).toBe("notes");
  });

  it("a clashing name that ends in a number continues it: Notes, Notes (2), Notes (3)", () => {
    const t = start();
    const f = t.folder("F");
    t.chapter("Notes", f);
    t.chapter("Notes", f);
    t.chapter("Notes (2)", f);
    t.chapter("Notes (2)", f);
    expect(t.names(f)).toEqual(["Notes", "Notes (2)", "Notes (3)", "Notes (4)"]);
    t.valid();
  });

  it("only the numbers the numbering writes continue: a huge or zero-led one is part of the name", () => {
    const t = start();
    const f = t.folder("F");
    t.chapter("Notes (9007199254740992)", f);
    t.chapter("Notes (9007199254740992)", f);
    t.chapter("Notes (02)", f);
    t.chapter("Notes (02)", f);
    expect(t.names(f)).toEqual([
      "Notes (9007199254740992)",
      "Notes (9007199254740992) (2)",
      "Notes (02)",
      "Notes (02) (2)",
    ]);
  });

  it("a create the server stamped dropped is in no view and is listed", () => {
    const t = start();
    const made = t.w.create(LIVE, WRITER, { kind: "folder", name: "Raced", parent: ROOT });
    t.w.settle("system", [made.id], "dropped", { reason: "Work was closed" });
    expect(t.at(made.node)).toBeUndefined();
    expect(replayView(t.doc, LIVE).dropped).toEqual([{ record: made, reason: "Work was closed" }]);
  });
});

describe("numbered names after a partial Apply", () => {
  it("a move that puts a deleted folder back brings what is inside it back, as Trash does", () => {
    const t = start();
    const map = t.chapter("Map");
    const ch2 = t.folder("Ch2");
    const arc = t.folder("Arc", ch2);
    t.w.delete(LIVE, WRITER, ch2);
    t.w.author(D, CHAT, { type: "rename", node: map, name: "Ch2", fromName: "Map" });
    // Putting Ch2 back brings Arc back too, and the Work's view shows both standing.
    t.w.author(D, CHAT, {
      type: "move",
      node: ch2,
      parent: ROOT,
      rank: "a1",
      from: { parent: ROOT, rank: "a1" },
    });
    const { left } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(left).toEqual([]);
    expect([t.at(ch2)?.trashed, t.at(arc)?.trashed]).toEqual([false, false]);
    expect(t.at(map)?.displayName).toBe("Ch2 (2)");
  });

  it("an Apply's restore leaves the clash as the Work showed it; a Trash restore does not", () => {
    const clash = () => {
      const t = start();
      const doc = t.chapter("Doc");
      t.w.author(D, CHAT, {
        type: "move",
        node: doc,
        parent: ROOT,
        rank: "Zz",
        from: { parent: ROOT, rank: t.at(doc)?.rank as string },
      });
      t.w.delete(LIVE, WRITER, doc);
      const other = t.chapter("Doc");
      const shown = (view: View = LIVE) => [
        t.at(doc, view)?.displayName,
        t.at(other, view)?.displayName,
      ];
      return { t, doc, shown };
    };
    const a = clash();
    expect(a.shown(D)).toEqual(["Doc", "Doc (2)"]);
    expect(applyDraft(a.t.w, "work-1", WRITER, cmd()).left).toEqual([]);
    expect(a.shown()).toEqual(["Doc", "Doc (2)"]);
    const b = clash();
    b.t.w.restore(LIVE, WRITER, b.doc);
    expect(b.shown()).toEqual(["Doc (2)", "Doc"]);
  });

  it("a rename to the name a node has is not baked into a number", () => {
    const t = start();
    const first = t.chapter("Notes");
    const second = t.chapter("Alpha");
    const third = t.chapter("Beta");
    // Clients that did not number: each literal name is the one the number would take.
    t.w.author(LIVE, CHAT, { type: "rename", node: second, name: "Notes", fromName: "Alpha" });
    t.w.author(LIVE, CHAT, { type: "rename", node: third, name: "Notes (2)", fromName: "Beta" });
    const shown = () => [first, second, third].map((node) => t.at(node)?.displayName);
    expect(shown()).toEqual(["Notes", "Notes (2)", "Notes (3)"]);
    t.w.author(D, CHAT, { type: "rename", node: second, name: "Notes", fromName: "Notes" });
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(shown()).toEqual(["Notes", "Notes (2)", "Notes (3)"]);
  });

  it("a move into another folder keeping its name is numbered against what is there", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B");
    const x = t.chapter("Notes", b);
    const y = t.chapter("Notes", a);
    t.w.author(D, CHAT, {
      type: "move",
      node: y,
      parent: b,
      rank: "a5",
      from: { parent: a, rank: "a1" },
      name: "Notes",
    });
    expect(t.names(b, D)).toEqual(["Notes", "Notes (2)"]);
    applyDraft(t.w, "work-1", WRITER, cmd());
    // x goes and comes back: y must keep the number it was shown.
    t.w.delete(LIVE, WRITER, x);
    t.w.restore(LIVE, WRITER, x);
    expect(t.at(y)?.displayName).toBe("Notes (2)");
    expect(t.at(x)?.displayName).toBe("Notes");
  });
});

/**
 * Two copies of the list out of step: each case is a list two or three writers built offline and
 * merged. A move or rename is in force unless the last record about it is an Undo; a node's name
 * and place are what the last move or rename in force says; an Undo sets nothing itself.
 */
describe("Undo of names and places reads the changes in force", () => {
  const W = WRITER;
  const replica = (client: number, from?: TreeWriter) => {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = client;
    if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from.doc));
    return new TreeWriter(doc);
  };
  const sync = (...writers: TreeWriter[]) => {
    for (const into of writers)
      for (const from of writers)
        if (into !== from) Y.applyUpdate(into.doc, Y.encodeStateAsUpdate(from.doc));
  };
  const folder = (w: TreeWriter, name: string, parent = ROOT) =>
    w.create(LIVE, W, { kind: "folder", name, parent }).node;
  const at = (w: TreeWriter, node: string, view: View = LIVE) => {
    const shown = w.view(view).nodes.get(node);
    return shown && { name: shown.displayName, parent: shown.parent, trashed: shown.trashed };
  };
  const nameOf = (w: TreeWriter, node: string, view: View = LIVE) => at(w, node, view)?.name;
  const parentOf = (w: TreeWriter, node: string, view: View = LIVE) => at(w, node, view)?.parent;
  /** What a press answered: the kind of record it wrote, or why it wrote none. */
  const said = (answer: TreeRecord | string) => (typeof answer === "string" ? answer : answer.type);
  const undo = (w: TreeWriter, id: string, view: View = LIVE) =>
    undoChange(w, view, W, id) as TreeRecord;

  it("a Work's rename and its Undo drafted over a live rename they never saw: Apply and Un-Apply keep the live rename", () => {
    const a = replica(1000);
    const node = folder(a, "Original");
    const b = replica(2000, a);
    const drafted = b.rename(D, W, node, "Target");
    undo(b, drafted.id, D);
    a.rename(LIVE, W, node, "Earlier");
    sync(a, b);
    const applied = applyDraft(a, "work-1", W, cmd());
    expect(nameOf(a, node)).toBe("Earlier");
    expect(undoApply(a, applied.command, W, cmd()).left.map((left) => left.why)).toEqual([]);
    expect([nameOf(a, node), nameOf(a, node, D)]).toEqual(["Earlier", "Earlier"]);
  });

  it("two copies Undo one rename: the rename neither saw stays", () => {
    const a = replica(1000);
    const node = folder(a, "Original");
    const b = replica(2000, a);
    a.rename(LIVE, W, node, "Earlier");
    const target = b.rename(LIVE, W, node, "Target");
    const c = replica(3000, b);
    undo(b, target.id);
    undo(c, target.id);
    sync(a, b, c);
    expect(
      viewRecords(a.doc, LIVE).map((record) =>
        record.type === "rename" ? record.name : record.type,
      ),
    ).toEqual(["create", "Earlier", "Target", "Original", "Original"]);
    expect(nameOf(a, node)).toBe("Earlier");
  });

  it("a stale Undo of a move leaves the move its author never saw", () => {
    const a = replica(1000);
    const node = folder(a, "Node");
    const p = folder(a, "P");
    const q = folder(a, "Q");
    const b = replica(2000, a);
    const toP = a.move(LIVE, W, node, p);
    const toQ = b.move(LIVE, W, node, q);
    undo(b, toQ.id);
    sync(a, b);
    expect(parentOf(a, node)).toBe(p);
    expect(said(undoChange(a, LIVE, W, toP.id))).toBe("move");
    expect(parentOf(a, node)).toBe(ROOT);
  });

  it("one stale Undo of a rename: the unseen rename stays", () => {
    const a = replica(1000);
    const node = folder(a, "Original");
    const b = replica(2000, a);
    a.rename(LIVE, W, node, "Earlier");
    const target = b.rename(LIVE, W, node, "Target");
    undo(b, target.id);
    sync(a, b);
    expect(nameOf(a, node)).toBe("Earlier");
  });

  it("a move that set a name, renamed since: Undo takes the place back and keeps the name", () => {
    const a = replica(1000);
    const into = folder(a, "Into");
    folder(a, "Name", into);
    const node = folder(a, "Name");
    const move = a.move(LIVE, W, node, into);
    a.rename(LIVE, W, node, "Mine");
    const back = undo(a, move.id);
    expect([back.type, nameOf(a, node), parentOf(a, node)]).toEqual(["move", "Mine", ROOT]);
  });

  it("an Undo's record says what its author's copy then shows", () => {
    const a = replica(1000);
    const into = folder(a, "Into");
    const node = folder(a, "Node");
    const move = a.move(LIVE, W, node, into);
    const rename = a.rename(LIVE, W, node, "Renamed");
    expect(undo(a, rename.id)).toMatchObject({ type: "rename", name: "Node" });
    const home = undo(a, move.id);
    expect(home).toMatchObject({ type: "move", parent: ROOT });
  });

  it("a stale Undo whose place would put a folder inside itself is skipped, and the move stands", () => {
    const a = replica(1000);
    const p = folder(a, "P");
    const q = folder(a, "Q");
    const node = folder(a, "Node", p);
    const b = replica(2000, a);
    const toQ = b.move(LIVE, W, node, q);
    a.move(LIVE, W, node, q);
    a.move(LIVE, W, p, node);
    undo(b, toQ.id);
    sync(a, b);
    expect([parentOf(a, node), parentOf(a, p)]).toEqual([q, node]);
    expect(treeViolations(a.view(LIVE))).toEqual([]);
  });

  it("a rename that changed the type is undone with its type", () => {
    const a = replica(1000);
    const node = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "notes.md",
      parent: ROOT,
    }).node;
    const typeOf = () => a.view(LIVE).nodes.get(node)?.filetype;
    const rename = a.rename(LIVE, W, node, "notes.txt", "text");
    undo(a, rename.id);
    expect(typeOf()).toBe("markdown");
  });

  it("an Undo whose change is not in the view sets nothing", () => {
    const a = replica(1000);
    const node = folder(a, "Original");
    a.rename(LIVE, W, node, "Kept");
    a.author(
      LIVE,
      W,
      { type: "rename", node, name: "Original", fromName: "Gone" },
      { undoes: crypto.randomUUID() },
    );
    expect(nameOf(a, node)).toBe("Kept");
  });

  it("an Undo asked in a Work's view of a live rename lands in live; a later live rename and its Undo leave it", () => {
    const a = replica(1000);
    const node = folder(a, "Orig");
    const rename = a.rename(LIVE, W, node, "X");
    expect(undoChange(a, D, W, rename.id)).toMatchObject({ type: "rename", name: "Orig" });
    a.rename(LIVE, W, node, "Y");
    expect(nameOf(a, node, D)).toBe("Y");
    const applied = applyDraft(a, "work-1", W, cmd());
    expect([nameOf(a, node), nameOf(a, node, D)]).toEqual(["Y", "Y"]);
    const later = a.rename(LIVE, W, node, "Z");
    expect(undoChange(a, LIVE, W, later.id)).toMatchObject({ type: "rename", name: "Y" });
    expect(undoApply(a, applied.command, W, cmd()).left.map((left) => left.why)).toEqual([]);
    expect([nameOf(a, node), nameOf(a, node, D)]).toEqual(["Y", "Y"]);
  });

  it("an Undo that brings back an older name gives the node its old arrival", () => {
    const a = replica(1000);
    const p = folder(a, "P");
    const x = folder(a, "Doc", p);
    const y = folder(a, "Other", p);
    a.rename(LIVE, W, y, "Doc");
    const shown = () => [nameOf(a, x), nameOf(a, y)];
    expect(shown()).toEqual(["Doc", "Doc (2)"]);
    undo(a, a.rename(LIVE, W, x, "Tmp").id);
    expect(shown()).toEqual(["Doc", "Doc (2)"]);
  });

  it("Un-Apply of an applied stale Undo, after live undid the move itself: the move stays out", () => {
    const a = replica(1000);
    const f = folder(a, "F");
    const node = folder(a, "X");
    const drafted = a.move(D, W, node, f);
    const b = replica(2000, a);
    const applied = applyDraft(a, "work-1", W, cmd());
    undo(a, (applied.copies[0] as TreeRecord).id);
    undo(b, drafted.id, D);
    sync(a, b);
    expect(parentOf(a, node)).toBe(ROOT);
    const again = applyDraft(a, "work-1", W, cmd());
    expect(parentOf(a, node)).toBe(ROOT);
    expect(undoApply(a, again.command, W, cmd()).left).toEqual([]);
    expect(parentOf(a, node)).toBe(ROOT);
  });

  it("an Undo back into a folder that has since gone inside the node writes nothing until the folder leaves", () => {
    const a = replica(1000);
    const node = folder(a, "N");
    const f = folder(a, "F");
    a.move(LIVE, W, node, f);
    const out = a.move(LIVE, W, node, ROOT);
    const inside = a.move(LIVE, W, f, node);
    const before = viewRecords(a.doc, LIVE).length;
    expect(said(undoChange(a, LIVE, W, out.id))).toBe("changed_since");
    expect(said(undoChange(a, LIVE, W, out.id))).toBe("changed_since");
    expect(viewRecords(a.doc, LIVE)).toHaveLength(before);
    expect(a.view(LIVE).skipped).toEqual([]);
    expect(said(undoChange(a, LIVE, W, inside.id))).toBe("move");
    expect(parentOf(a, f)).toBe(ROOT);
    expect(said(undoChange(a, LIVE, W, out.id))).toBe("move");
    expect(parentOf(a, node)).toBe(f);
  });

  it("Un-Apply of a move that carried the name the node already had takes both facts back and reports none kept", () => {
    const a = replica(1000);
    const from = folder(a, "A");
    const into = folder(a, "B");
    const node = a.create(LIVE, W, { kind: "folder", name: "Notes", parent: from }).node;
    a.author(D, CHAT, {
      type: "move",
      node,
      parent: into,
      rank: "a5",
      from: { parent: from, rank: "a0" },
      name: "Notes",
    });
    const applied = applyDraft(a, "work-1", W, cmd());
    expect(parentOf(a, node)).toBe(into);
    const back = undoApply(a, applied.command, W, cmd());
    expect([back.undone.length, back.left]).toEqual([1, []]);
    expect(at(a, node)).toMatchObject({ name: "Notes", parent: from });
  });

  it("an applied delete undone on two copies: the Apply's tree half has ended", () => {
    const a = replica(1000);
    const node = folder(a, "N");
    a.delete(D, W, node);
    const applied = applyDraft(a, "work-1", W, cmd());
    const copy = viewRecords(a.doc, LIVE).at(-1) as TreeRecord;
    expect(appliedNodes(a.doc, applied.command, [])).toEqual([node]);
    const b = replica(2000, a);
    undo(a, copy.id);
    undo(b, copy.id);
    sync(a, b);
    expect(appliedNodes(a.doc, applied.command, [])).toEqual([]);
  });

  it("who last renamed a node after an Undo is the Undo's author", () => {
    const a = replica(1000);
    const node = folder(a, "Orig");
    undoChange(a, LIVE, "user:bob", a.rename(LIVE, W, node, "X").id);
    expect(a.view(LIVE).history.get(node)?.label).toEqual([]);
    expect(a.view(LIVE).nodes.get(node)?.lastChangedBy).toBe("user:bob");
  });

  it("a rename undone on one copy while the other restores the node: both land", () => {
    const a = replica(1000);
    const node = folder(a, "A");
    const rename = a.rename(LIVE, W, node, "B");
    const removal = a.delete(LIVE, W, node);
    const b = replica(2000, a);
    const restore = undo(a, removal.id);
    const back = undo(b, rename.id);
    expect([restore.type, back.type]).toEqual(["restore", "rename"]);
    sync(a, b);
    expect(at(a, node)).toMatchObject({ name: "A", trashed: false });
  });
  it("skips an Undo aimed at a change on another node", () => {
    const a = replica(1000);
    const x = folder(a, "X");
    const y = folder(a, "Y");
    const change = a.rename(LIVE, W, y, "Changed");
    const crafted = a.author(
      LIVE,
      W,
      { type: "rename", node: x, name: "X", fromName: "X" },
      { undoes: change.id },
    );
    const view = a.view(LIVE);
    expect(view.skipped).toContainEqual({ record: crafted.id, reason: "undo-other-node" });
    expect(view.nodes.get(y)?.name).toBe("Changed");
  });
  it("holds a folder and its selected child in a closed source", () => {
    const t = start();
    const closed = sourceRoot("closed");
    const parent = t.w.create(D, CHAT, { kind: "folder", name: "P", parent: closed });
    const child = t.w.create(D, CHAT, {
      kind: "document",
      filetype: "markdown",
      name: "C",
      parent: parent.node,
    });
    const result = applyDraft(
      t.w,
      "work-1",
      WRITER,
      cmd(),
      [child.id],
      undefined,
      (s) => s === "closed",
    );
    expect(result.copies).toEqual([]);
    expect(result.left.map((r) => [r.record.id, r.why, r.source])).toContainEqual([
      child.id,
      "closed",
      "closed",
    ]);
  });

  it("replans a create inside a folder whose move is held", () => {
    const t = start();
    const folder = t.folder("P");
    const moved = t.w.move(D, CHAT, folder, sourceRoot("closed"));
    const child = t.w.create(D, CHAT, { kind: "folder", name: "C", parent: folder });
    const result = applyDraft(
      t.w,
      "work-1",
      WRITER,
      cmd(),
      undefined,
      undefined,
      (s) => s === "closed",
    );
    expect(result.left.map((r) => r.record.id)).toContain(moved.id);
    expect(result.copies.map((r) => r.carries)).toContain(child.id);
    expect(t.at(child.node)?.source).toBe("manuscript");
  });

  it("holds Un-Apply when an Undo move would enter a closed source", () => {
    const t = start();
    const folder = t.folder("P", sourceRoot("closed"));
    t.w.move(D, CHAT, folder, ROOT);
    const applied = applyDraft(t.w, "work-1", WRITER, cmd());
    const back = undoApply(t.w, applied.command, WRITER, cmd(), { closed: (s) => s === "closed" });
    expect(back.left).toMatchObject([{ why: "closed", source: "closed" }]);
    expect(t.at(folder)?.source).toBe("manuscript");
  });
});

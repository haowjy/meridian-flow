/**
 * Proof code. One test per numbered case of
 * work/release-coordination/findings/tree-cases-and-echoes.md, in that file's order, on one list
 * with one writer (the server appending for the writer, for chats and for live). `D` is a Work's
 * draft; `E` is a second chat writing into the same draft.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  childrenOf,
  fingerprint,
  LIVE,
  materialize,
  opsOf,
  ROOT,
  type TreeOp,
  type TreeProjection,
  TreeWriter,
  treeViolations,
  type View,
  viewOps,
} from "./tree-log.js";

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
    w.create(view, actor, { kind: "document", name, parent }).node;
  const names = (parent: string, view: View = LIVE) =>
    childrenOf(w.view(view), parent).map((node) => node.displayName);
  const at = (node: string, view: View = LIVE) => w.view(view).nodes.get(node);
  const valid = () => {
    expect(treeViolations(w.view(LIVE))).toEqual([]);
    expect(treeViolations(w.view(D))).toEqual([]);
  };
  return { doc, w, folder, chapter, names, at, valid };
}

/** Drafted records review reports as "deleted in live": their node stands in the view only because they are pending. */
function targetGone(doc: Y.Doc, view: View): TreeOp[] {
  const projection: TreeProjection = materialize(doc, view);
  return viewOps(doc, view).filter(
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
    t.w.apply("work-1", WRITER);
    expect(t.at(ch)).toMatchObject({ parent: arc, displayName: "The Fall" });
    t.valid();
  });

  it("2. both renamed it: the draft's name shows and wins on Apply; the record keeps the name it replaced", () => {
    const t = start();
    const ch = t.chapter("Chapter 49");
    t.w.rename(D, CHAT, ch, "Draft name");
    t.w.rename(LIVE, WRITER, ch, "Live name");
    expect(t.at(ch, D)?.displayName).toBe("Draft name");
    const [copy] = t.w.apply("work-1", WRITER);
    expect(t.at(ch)?.displayName).toBe("Draft name");
    // What review can say: the drafted rename was made over "Chapter 49"; live now says "Live name".
    expect(copy).toMatchObject({ type: "rename", fromName: "Live name" });
    const drafted = opsOf(t.doc)
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
    t.w.apply("work-1", WRITER);
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
    t.w.apply("work-1", WRITER);
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
    t.w.apply("work-1", WRITER);
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
    expect(t.w.view(D).skipped).toEqual([{ op: drafted.id, reason: "cycle" }]);
    const { copies, left } = t.w.applyLanding("work-1", WRITER);
    expect(copies.map((op) => op.type)).toEqual(["rename"]);
    expect(left.map((op) => op.id)).toEqual([drafted.id]);
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
    t.w.apply("work-1", WRITER);
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
    t.w.apply("work-1", WRITER);
    expect(t.names(f)).toEqual(order);
    expect([a, b, c].every((n) => t.at(n)?.trashed === false)).toBe(true);
  });

  it("9. draft moved and renamed a chapter, live deleted it: the Work's view still shows it, marked; Apply leaves the change pending until it is restored", () => {
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
    const before = fingerprint(t.w.view(D));
    const { copies, left } = t.w.applyLanding("work-1", WRITER);
    expect(copies.map((op) => op.node)).toEqual([other]);
    expect(left.map((op) => op.type)).toEqual(["move", "rename"]);
    expect(t.at(ch)).toMatchObject({ trashed: true, parent: ROOT, name: "Chapter 49" });
    expect(fingerprint(t.w.view(D))).toBe(before);
    // The writer restores it in live: the mark goes, and the same records now land.
    t.w.restore(LIVE, WRITER, ch);
    expect(t.at(ch, D)).toMatchObject({ parent: arc, displayName: "The Fall", keptByPending: false });
    expect(t.w.applyLanding("work-1", WRITER).left).toEqual([]);
    expect(t.at(ch)).toMatchObject({ parent: arc, displayName: "The Fall", trashed: false });
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
    const view = materialize(t.doc, D, new Set([ch]));
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
    t.w.apply("work-1", WRITER);
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
    const createArc = opsOf(t.doc)
      .toArray()
      .find((op) => op.type === "create" && op.node === arc) as TreeOp;
    const scene = t.chapter("Scene", arc, D, CHAT2);
    // Discard that saw the scene takes it too (case 20).
    const both = start();
    const arc2 = both.folder("Arc", ROOT, D, CHAT);
    both.chapter("Scene", arc2, D, CHAT2);
    const create2 = opsOf(both.doc).toArray()[0] as TreeOp;
    expect(both.w.discard("work-1", [create2.id])).toHaveLength(2);
    // A discard that did not see the scene (two writers, or a scene written after the discard
    // was computed): only the folder's create is settled.
    t.doc.transact(() => t.doc.getMap("settled").set(createArc.id, "discarded"));
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
      viewOps(t.doc, D)
        .filter((op) => op.draft === "work-1")
        .map((op) => op.id);
    const idOf = (type: string, node: string) =>
      opsOf(t.doc)
        .toArray()
        .find((op) => op.type === type && op.node === node && op.draft === "work-1")?.id as string;
    return { ...t, ch1, ch2, arc, scene, moved, renamed1, renamed2, drafted, idOf };
  }

  it("17. applies 'Scene in Arc' only: 'create Arc' comes with it, the rest stays drafted", () => {
    const t = reorganisation();
    const before = fingerprint(t.w.view(D));
    const copies = t.w.apply("work-1", WRITER, [t.idOf("create", t.scene)]);
    expect(copies.map((op) => op.node)).toEqual([t.arc, t.scene]);
    expect(t.at(t.ch1)?.parent).toBe(ROOT);
    expect(fingerprint(t.w.view(D))).toBe(before);
    expect(t.drafted()).toEqual([t.moved.id, t.renamed1.id, t.renamed2.id]);
  });

  it("18. applies the second of two renames: the first comes with it", () => {
    const t = reorganisation();
    const copies = t.w.apply("work-1", WRITER, [t.renamed2.id]);
    expect(copies.map((op) => op.appliedFrom)).toEqual([t.renamed1.id, t.renamed2.id]);
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
    const copies = t.w.apply("work-1", WRITER, [second.id]);
    expect(copies.map((op) => op.appliedFrom)).toEqual([first.id, second.id]);
    expect(fingerprint(t.w.view(D))).toBe(before);
    expect(t.at(a)?.parent).toBe(b);
    t.valid();
  });

  it("20. discards 'create Arc': everything made in or moved into Arc goes with it, the rest stays", () => {
    const t = reorganisation();
    const gone = t.w.discard("work-1", [t.idOf("create", t.arc)]);
    expect(gone).toHaveLength(3);
    expect(t.at(t.ch1, D)?.parent).toBe(ROOT);
    expect(t.at(t.arc, D)).toBeUndefined();
    expect(t.at(t.ch2, D)?.displayName).toBe("Third");
  });

  it("21. applies everything: live equals what the Work's view showed", () => {
    const t = reorganisation();
    const before = fingerprint(t.w.view(D));
    t.w.apply("work-1", WRITER);
    expect(fingerprint(t.w.view(LIVE))).toBe(before);
    expect(t.drafted()).toEqual([]);
  });

  it("22. discards everything: the Work's view equals live", () => {
    const t = reorganisation();
    t.w.discard("work-1");
    expect(fingerprint(t.w.view(D))).toBe(fingerprint(t.w.view(LIVE)));
  });

  it("23. undoes an applied move: the chapter returns to its exact place", () => {
    const t = reorganisation();
    const before = fingerprint(t.w.view(LIVE));
    const copies = t.w.apply("work-1", WRITER, [t.moved.id]);
    const applied = copies.find((op) => op.appliedFrom === t.moved.id) as TreeOp;
    const inverse = t.w.undo(LIVE, WRITER, applied.id);
    expect(inverse).toMatchObject({ type: "move", undoes: applied.id });
    expect(t.at(t.ch1)?.parent).toBe(ROOT);
    // The Arc folder came with the move; undoing the move leaves the folder (undo is per record).
    expect(fingerprint(t.w.view(LIVE))).not.toBe(before);
    expect(t.names(ROOT)).toEqual(["Chapter 1", "Chapter 2", "Arc"]);
  });

  it("24. undoes a move after someone moved the chapter again: refused as superseded", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B");
    const ch = t.chapter("Chapter 1");
    const move = t.w.move(LIVE, CHAT, ch, a);
    t.w.move(LIVE, WRITER, ch, b);
    expect(t.w.undo(LIVE, WRITER, move.id)).toBe("superseded");
  });

  it("25. undoes a move back into a folder deleted since: refused, the folder is not revived", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B");
    const ch = t.chapter("Chapter 1", a);
    const move = t.w.move(LIVE, CHAT, ch, b);
    t.w.delete(LIVE, WRITER, a);
    expect(t.w.undo(LIVE, WRITER, move.id)).toBe("superseded");
    expect(t.at(a)?.trashed).toBe(true);
  });

  it("26. undoes a folder delete: the folder and its contents come back", () => {
    const t = start();
    const f = t.folder("Arc 2");
    const ch = t.chapter("Chapter 1", f);
    const del = t.w.delete(LIVE, WRITER, f);
    expect(t.at(ch)?.trashed).toBe(true);
    t.w.undo(LIVE, WRITER, del.id);
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
    const lost = t.w.rename(D, CHAT, gone, "Never shown");
    t.w.move(LIVE, WRITER, b, a);
    t.w.delete(LIVE, WRITER, gone);
    // Before Apply, the draft's view already says which parts cannot land.
    expect(t.w.view(D).skipped).toEqual([{ op: loop.id, reason: "cycle" }]);
    expect(targetGone(t.doc, D).map((op) => op.node)).toEqual([gone]);
    const before = fingerprint(t.w.view(D));
    const { copies, left, blocked } = t.w.applyLanding("work-1", WRITER);
    expect(blocked).toBe(false);
    expect(copies.map((op) => op.type)).toEqual(["rename"]);
    expect(left.map((op) => op.id)).toEqual([loop.id, lost.id]);
    expect(t.at(ch)?.displayName).toBe("Renamed");
    expect(t.at(a)?.parent).toBe(ROOT);
    expect(t.at(gone)).toMatchObject({ trashed: true, name: "Chapter 2" });
    expect(fingerprint(t.w.view(D))).toBe(before);
    // The writer fixes the cause in live, and the same drafted move now lands.
    t.w.move(LIVE, WRITER, b, ROOT);
    expect(t.w.view(D).skipped).toEqual([]);
    expect(t.w.applyLanding("work-1", WRITER).copies.map((op) => op.appliedFrom)).toEqual([loop.id]);
    expect(t.at(a)?.parent).toBe(b);
    t.valid();
  });

  it("Undo of an Apply, at once: live and the draft both read as before it", () => {
    const t = reorganisation();
    const live = fingerprint(t.w.view(LIVE));
    const draft = fingerprint(t.w.view(D));
    const copies = t.w.apply("work-1", WRITER);
    expect(fingerprint(t.w.view(LIVE))).toBe(draft);
    expect(t.w.undoApply(copies)).toBe("undone");
    expect(fingerprint(t.w.view(LIVE))).toBe(live);
    expect(fingerprint(t.w.view(D))).toBe(draft);
    expect(t.drafted()).toHaveLength(5);
    // And it can be applied again.
    t.w.apply("work-1", WRITER);
    expect(fingerprint(t.w.view(LIVE))).toBe(draft);
    t.valid();
  });

  it("Undo of an Apply after another change landed on top: refused; unrelated changes do not block it", () => {
    const t = reorganisation();
    const other = t.chapter("Elsewhere");
    const copies = t.w.apply("work-1", WRITER);
    // Neither a change elsewhere nor a new document beside what the Apply made blocks the Undo.
    t.w.rename(LIVE, WRITER, other, "Still elsewhere");
    t.chapter("Unrelated, also at the top");
    expect(t.w.undoApply(copies)).toBe("undone");
    const again = t.w.apply("work-1", WRITER);
    t.chapter("New scene", t.arc); // lands inside a folder the Apply created
    expect(t.w.undoApply(again)).toBe("superseded");
    expect(t.at(t.arc)?.trashed).toBe(false);
    t.valid();
  });

  it("Undo of an Apply that only created a folder, after a document was put in it: refused", () => {
    const t = start();
    const arc = t.folder("Arc", ROOT, D, CHAT);
    const copies = t.w.apply("work-1", WRITER);
    const scene = t.chapter("Scene", arc);
    expect(t.w.undoApply(copies)).toBe("superseded");
    expect(t.at(scene)).toMatchObject({ parent: arc, trashed: false });
    const moved = start();
    const arc2 = moved.folder("Arc", ROOT, D, CHAT);
    const ch = moved.chapter("Chapter 1");
    const copies2 = moved.w.apply("work-1", WRITER);
    moved.w.move(LIVE, WRITER, ch, arc2);
    expect(moved.w.undoApply(copies2)).toBe("superseded");
  });

  it("Undo of an Apply that moved a folder, after a change inside that folder: allowed, and the change stands", () => {
    const t = start();
    const f = t.folder("F");
    const g = t.folder("G");
    const ch = t.chapter("Chapter 1", f);
    t.w.move(D, CHAT, f, g);
    const copies = t.w.apply("work-1", WRITER);
    t.w.rename(LIVE, WRITER, ch, "Renamed inside");
    const added = t.chapter("Added inside", f);
    expect(t.w.undoApply(copies)).toBe("undone");
    expect(t.at(f)?.parent).toBe(ROOT);
    expect(t.at(ch)).toMatchObject({ parent: f, displayName: "Renamed inside" });
    expect(t.at(added)).toMatchObject({ parent: f, trashed: false });
    t.valid();
  });
});

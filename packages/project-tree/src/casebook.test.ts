/**
 * Proof code. One test per numbered case of
 * work/release-coordination/findings/tree-cases-and-echoes.md, in that file's order, on one list
 * with one writer (the server appending for the writer, for chats and for live). `D` is a Work's
 * draft; `E` is a second chat writing into the same draft.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDraft,
  childrenOf,
  discardDraft,
  fingerprint,
  LIVE,
  moveBetweenLists,
  recordsOf,
  replayView,
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
    const { copies, left } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(copies.map((op) => op.node)).toEqual([other]);
    expect(left.map((op) => op.type)).toEqual(["move", "rename"]);
    expect(t.at(ch)).toMatchObject({ trashed: true, parent: ROOT, name: "Chapter 49" });
    expect(fingerprint(t.w.view(D))).toBe(before);
    // The writer restores it in live: the mark goes, and the same records now land.
    t.w.restore(LIVE, WRITER, ch);
    expect(t.at(ch, D)).toMatchObject({
      parent: arc,
      displayName: "The Fall",
      keptByPending: false,
    });
    expect(applyDraft(t.w, "work-1", WRITER, cmd()).left).toEqual([]);
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
    const { copies } = applyDraft(t.w, "work-1", WRITER, cmd(), [second.id]);
    expect(copies.map((op) => op.appliedFrom)).toEqual([first.id, second.id]);
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
    const applied = copies.find((op) => op.appliedFrom === t.moved.id) as TreeRecord;
    const inverse = undoChange(t.w, LIVE, WRITER, applied.id);
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
    expect(undoChange(t.w, LIVE, WRITER, move.id)).toBe("superseded");
  });

  it("25. undoes a move back into a folder deleted since: refused, the folder is not revived", () => {
    const t = start();
    const a = t.folder("A");
    const b = t.folder("B");
    const ch = t.chapter("Chapter 1", a);
    const move = t.w.move(LIVE, CHAT, ch, b);
    t.w.delete(LIVE, WRITER, a);
    expect(undoChange(t.w, LIVE, WRITER, move.id)).toBe("superseded");
    expect(t.at(a)?.trashed).toBe(true);
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
    const lost = t.w.rename(D, CHAT, gone, "Never shown");
    t.w.move(LIVE, WRITER, b, a);
    t.w.delete(LIVE, WRITER, gone);
    // Before Apply, the draft's view already says which parts cannot land.
    expect(t.w.view(D).skipped).toEqual([{ record: loop.id, reason: "cycle" }]);
    expect(targetGone(t.doc, D).map((op) => op.node)).toEqual([gone]);
    const before = fingerprint(t.w.view(D));
    const { copies, left, blocked } = applyDraft(t.w, "work-1", WRITER, cmd());
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
    expect(applyDraft(t.w, "work-1", WRITER, cmd()).copies.map((op) => op.appliedFrom)).toEqual([
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
    expect(first.copies.map((op) => op.appliedFrom)).toEqual([out.id]);
    expect(first.left.map((op) => op.id)).toEqual([loop.id]);
    expect(first.blocked).toBe(false);
    expect(t.at(b)?.parent).toBe(ROOT);
    expect(t.at(a)?.parent).toBe(ROOT);
    // Still pending, never marked applied, and now it fits.
    expect(t.w.view(D).skipped).toEqual([]);
    expect(t.at(a, D)?.parent).toBe(b);
    const second = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(second.copies.map((op) => op.appliedFrom)).toEqual([loop.id]);
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
    expect(undoChange(t.w, LIVE, CHAT, byChat.id)).toBe("superseded");
    expect([t.at(f)?.trashed, t.at(y)?.trashed]).toEqual([true, true]);
  });

  it("a Discard and an Undo of an Apply are records with an actor, and the list holds no deletions", () => {
    const t = reorganisedOnce();
    const log = () => t.doc.getArray<{ actor: string; to: string }>("settle").toArray();
    const { command, mark } = applyDraft(t.w, "work-1", WRITER, cmd());
    const vectorAfterApply = Y.encodeStateVector(t.doc);
    undoApply(t.w, command, mark, WRITER, cmd());
    expect(Y.encodeStateVector(t.doc)).not.toEqual(vectorAfterApply);
    discardDraft(t.w, "work-1", CHAT, cmd());
    expect(log().map((record) => [record.actor, record.to])).toEqual([
      [WRITER, "applied"],
      [WRITER, "undone"],
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
    expect(t.at(k)).toMatchObject({ displayName: "K renamed", trashed: false, keptByChild: true });
    expect(t.at(y)?.parent).toBe(k);
    t.valid();
  });
});

describe("a purge empties one Trash entry", () => {
  it("takes what the delete took, and is skipped while a node outside it stands in the folder", () => {
    const t = start();
    const arc = t.folder("Arc");
    const ch = t.chapter("Chapter", arc);
    const removal = t.w.delete(LIVE, WRITER, arc);
    t.w.restore(LIVE, WRITER, ch);
    t.w.purge("system", removal);
    const live = t.w.view(LIVE);
    expect(live.skipped.map((s) => s.reason)).toEqual(["standing"]);
    expect(live.nodes.get(arc)).toMatchObject({ purged: false });
    expect(live.nodes.get(ch)).toMatchObject({ purged: false, trashed: false });
    t.valid();

    const gone = start();
    const folder = gone.folder("Old");
    const inside = gone.chapter("Inside", folder);
    gone.w.purge("system", gone.w.delete(LIVE, WRITER, folder));
    expect(gone.w.view(LIVE).nodes.get(inside)).toMatchObject({ purged: true });
    expect(gone.w.view(LIVE).trash).toEqual([]);
  });
});

describe("a purged node is absent from every view, for placement as for display", () => {
  it("a create into a purged folder is rescued to the top of its source, and a move into it is skipped", () => {
    const t = start();
    const old = t.folder("Old");
    const kept = t.chapter("Kept");
    t.w.purge("system", t.w.delete(LIVE, "system", old));
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

describe("Undo of an Apply by the simple rule: only while nothing has been admitted since", () => {
  const applied = () => {
    const t = reorganisedOnce();
    const other = t.chapter("Elsewhere");
    return { ...t, other, ...applyDraft(t.w, "work-1", WRITER, cmd()) };
  };

  it("at once: live and the draft read as before, and it can be applied again", () => {
    const t = reorganisedOnce();
    const [live, draft] = [fingerprint(t.w.view(LIVE)), fingerprint(t.w.view(D))];
    const { command, mark } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(undoApply(t.w, command, mark, WRITER, cmd())).toBe("undone");
    expect(fingerprint(t.w.view(LIVE))).toBe(live);
    expect(fingerprint(t.w.view(D))).toBe(draft);
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(fingerprint(t.w.view(LIVE))).toBe(draft);
  });

  it("gone after a live change anywhere, however unrelated", () => {
    const t = applied();
    t.w.rename(LIVE, WRITER, t.other, "Still elsewhere");
    expect(undoApply(t.w, t.command, t.mark, WRITER, cmd())).toBe("gone");
  });

  it("gone after any Work drafts anything", () => {
    const t = applied();
    t.w.rename({ draft: "work-2" }, CHAT2, t.other, "Drafted elsewhere");
    expect(undoApply(t.w, t.command, t.mark, WRITER, cmd())).toBe("gone");
  });

  it("gone after a Discard or another Apply, and it cannot run twice", () => {
    const t = applied();
    t.w.rename({ draft: "work-2" }, CHAT2, t.other, "x");
    const afterRename = Y.encodeStateVector(t.doc);
    discardDraft(t.w, "work-2", WRITER, cmd());
    expect(undoApply(t.w, t.command, afterRename, WRITER, cmd())).toBe("gone");
    const again = reorganisedOnce();
    const { command, mark } = applyDraft(again.w, "work-1", WRITER, cmd());
    expect(undoApply(again.w, command, mark, WRITER, cmd())).toBe("undone");
    expect(undoApply(again.w, command, mark, WRITER, cmd())).toBe("gone");
  });

  it("gone after a record from a client that was offline, though it lands earlier in the list", () => {
    const t = reorganisedOnce();
    const other = t.chapter("Elsewhere");
    const offline = new Y.Doc({ gc: false });
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(t.doc));
    offline.clientID = 1; // sorts before the server's records made at the same point
    new TreeWriter(offline).rename(LIVE, "user:other", other, "Renamed offline");
    const { copies, command, mark } = applyDraft(t.w, "work-1", WRITER, cmd());
    Y.applyUpdate(t.doc, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(t.doc)));
    const ids = recordsOf(t.doc)
      .toArray()
      .map((record) => record.id);
    expect(ids.indexOf(copies[0]?.id as string)).toBeGreaterThan(
      ids.indexOf(recordsOf(offline).toArray().at(-1)?.id as string),
    );
    expect(undoApply(t.w, command, mark, WRITER, cmd())).toBe("gone");
  });

  it("gone after text was written in a chapter the Apply created", () => {
    const t = start();
    const ch = t.chapter("Chapter 50", ROOT, D, CHAT);
    const { command, mark } = applyDraft(t.w, "work-1", WRITER, cmd());
    expect(undoApply(t.w, command, mark, WRITER, cmd(), new Set([ch]))).toBe("gone");
    expect(undoApply(t.w, command, mark, WRITER, cmd())).toBe("undone");
  });
});

type TrashItem = { name: string; inside: TrashItem[] };

/**
 * Trash as a tree, for one view: what the tree must give the Trash screen. An entry is the
 * node of a delete still in force that still takes something. Inside it are the nodes in
 * Trash under it, as a tree; a folder inside that stands again (something in it was restored)
 * is shown as the container of what is still in Trash under it.
 */
function trashTree(projection: TreeProjection): TrashItem[] {
  const kids = new Map<string, string[]>();
  for (const node of projection.nodes.values())
    if (node.parent !== null) kids.set(node.parent, [...(kids.get(node.parent) ?? []), node.id]);
  const holdsTrash = (id: string): boolean =>
    projection.nodes.get(id)?.trashed === true || (kids.get(id) ?? []).some(holdsTrash);
  const item = (id: string): TrashItem => ({
    name: projection.nodes.get(id)?.name as string,
    inside: (kids.get(id) ?? [])
      .filter(holdsTrash)
      .map(item)
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  });
  const tops = new Set(projection.trash.map((record) => record.node).filter(holdsTrash));
  const isInside = (id: string) => {
    let at = projection.nodes.get(id)?.parent ?? null;
    while (at !== null) {
      if (tops.has(at)) return true;
      at = projection.nodes.get(at)?.parent ?? null;
    }
    return false;
  };
  return [...tops]
    .filter((id) => !isInside(id))
    .map(item)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}
const leaf = (name: string): TrashItem => ({ name, inside: [] });

describe("Trash is a tree: a deleted folder is one entry that can be opened; a folder that something needs stands again", () => {
  function deletedArc() {
    const t = start();
    const arc = t.folder("Arc 2");
    const part = t.folder("Part 1", arc);
    const chapters = ["Chapter 41", "Chapter 42", "Chapter 49"].map((name) => t.chapter(name, arc));
    const inner = t.chapter("Interlude", part);
    const loose = t.chapter("Loose");
    t.w.delete(LIVE, WRITER, arc);
    t.w.delete(LIVE, WRITER, loose);
    return { ...t, arc, part, chapters, inner, loose };
  }

  it("a deleted folder is one entry holding its documents and its subfolder; a document deleted alone is its own entry", () => {
    const t = deletedArc();
    expect(trashTree(t.w.view(LIVE))).toEqual([
      {
        name: "Arc 2",
        inside: [
          leaf("Chapter 41"),
          leaf("Chapter 42"),
          leaf("Chapter 49"),
          { name: "Part 1", inside: [leaf("Interlude")] },
        ],
      },
      leaf("Loose"),
    ]);
    expect(t.names(ROOT)).toEqual([]);
  });

  it("restoring one document from inside brings the folder back holding only it; the rest stays under the folder's entry", () => {
    const t = deletedArc();
    t.w.restore(LIVE, WRITER, t.chapters[0] as string);
    expect(t.names(ROOT)).toEqual(["Arc 2"]);
    expect(t.names(t.arc)).toEqual(["Chapter 41"]);
    expect(trashTree(t.w.view(LIVE))).toEqual([
      {
        name: "Arc 2",
        inside: [
          leaf("Chapter 42"),
          leaf("Chapter 49"),
          { name: "Part 1", inside: [leaf("Interlude")] },
        ],
      },
      leaf("Loose"),
    ]);
    // A document two folders down brings both folders back; the entry keeps the rest.
    t.w.restore(LIVE, WRITER, t.inner);
    expect(t.names(t.arc)).toEqual(["Part 1", "Chapter 41"]);
    expect(t.names(t.part)).toEqual(["Interlude"]);
    expect(trashTree(t.w.view(LIVE))).toEqual([
      { name: "Arc 2", inside: [leaf("Chapter 42"), leaf("Chapter 49")] },
      leaf("Loose"),
    ]);
    t.valid();
  });

  it("restoring the folder's entry brings back everything still in it, and the entry is gone", () => {
    const t = deletedArc();
    t.w.restore(LIVE, WRITER, t.chapters[0] as string);
    t.w.restore(LIVE, WRITER, t.arc);
    expect(t.names(t.arc)).toEqual(["Part 1", "Chapter 41", "Chapter 42", "Chapter 49"]);
    expect(t.names(t.part)).toEqual(["Interlude"]);
    expect(trashTree(t.w.view(LIVE))).toEqual([leaf("Loose")]);
  });

  it("restoring a subfolder from inside brings it and what is in it, under its folder", () => {
    const t = deletedArc();
    t.w.restore(LIVE, WRITER, t.part);
    expect(t.names(t.arc)).toEqual(["Part 1"]);
    expect(t.names(t.part)).toEqual(["Interlude"]);
    expect(trashTree(t.w.view(LIVE))[0]).toEqual({
      name: "Arc 2",
      inside: [leaf("Chapter 41"), leaf("Chapter 42"), leaf("Chapter 49")],
    });
  });

  it("a folder deleted earlier, inside a folder deleted later, is nested in Trash and keeps its own delete", () => {
    const t = start();
    const arc = t.folder("Arc 2");
    const part = t.folder("Part 1", arc);
    t.chapter("Interlude", part);
    t.chapter("Chapter 41", arc);
    t.w.delete(LIVE, WRITER, part);
    t.w.delete(LIVE, CHAT, arc);
    expect(trashTree(t.w.view(LIVE))).toEqual([
      {
        name: "Arc 2",
        inside: [leaf("Chapter 41"), { name: "Part 1", inside: [leaf("Interlude")] }],
      },
    ]);
    // Restoring the outer folder brings back what its delete took. Part 1 was deleted on its
    // own, before, and stays in Trash, now an entry inside the standing folder.
    t.w.restore(LIVE, WRITER, arc);
    expect(t.names(arc)).toEqual(["Chapter 41"]);
    expect(trashTree(t.w.view(LIVE))).toEqual([{ name: "Part 1", inside: [leaf("Interlude")] }]);
  });

  it("a folder deleted twice has two entries, and restoring one leaves the other's delete standing", () => {
    const t = start();
    const arc = t.folder("Arc");
    const ch41 = t.chapter("Chapter 41", arc);
    t.chapter("Chapter 42", arc);
    const first = t.w.delete(LIVE, CHAT, arc);
    t.w.restore(LIVE, WRITER, ch41); // Arc stands again for it
    const ch50 = t.chapter("Chapter 50", arc);
    t.w.delete(LIVE, CHAT2, arc); // someone else deletes Arc, with 41 and 50
    expect(t.w.restoreEntry(LIVE, WRITER, first.id)).toMatchObject({
      type: "restore",
      undoes: first.id,
    });
    // The first entry's chapter is back; what the second delete took is still in Trash.
    expect(t.names(arc)).toEqual(["Chapter 42"]);
    expect([t.at(ch41)?.trashed, t.at(ch50)?.trashed]).toEqual([true, true]);
    t.valid();
  });

  it("an empty deleted folder is an entry and can be restored; a draft that puts something in it brings it back", () => {
    const t = start();
    const empty = t.folder("Empty");
    t.w.delete(LIVE, WRITER, empty);
    expect(trashTree(t.w.view(LIVE))).toEqual([leaf("Empty")]);
    t.chapter("New", empty, D, CHAT);
    expect(t.names(ROOT, D)).toEqual(["Empty"]);
    expect(trashTree(t.w.view(D))).toEqual([]);
    applyDraft(t.w, "work-1", WRITER, cmd());
    expect(t.names(empty)).toEqual(["New"]);
    const again = start();
    const e2 = again.folder("Empty");
    again.w.delete(LIVE, WRITER, e2);
    again.w.restore(LIVE, WRITER, e2);
    expect(again.names(ROOT)).toEqual(["Empty"]);
  });

  it("Trash is per view: a Work that drafted a delete sees the entry; live does not", () => {
    const t = start();
    const arc = t.folder("Arc 2");
    t.chapter("Chapter 41", arc);
    t.w.delete(D, CHAT, arc);
    expect(trashTree(t.w.view(LIVE))).toEqual([]);
    expect(trashTree(t.w.view(D))).toEqual([{ name: "Arc 2", inside: [leaf("Chapter 41")] }]);
  });

  it("a folder brought back by a restore from inside goes again when the last thing in it leaves, and its entry still holds the rest", () => {
    const t = deletedArc();
    const ch = t.chapters[0] as string;
    t.w.restore(LIVE, WRITER, ch);
    const elsewhere = t.folder("Arc 3");
    t.w.move(LIVE, WRITER, ch, elsewhere);
    expect(t.names(ROOT)).toEqual(["Arc 3"]);
    expect(trashTree(t.w.view(LIVE))[0]?.inside.map((item) => item.name)).toEqual([
      "Chapter 42",
      "Chapter 49",
      "Part 1",
    ]);
  });
});

/** Trash as a writer sees it: documents only, grouped by the delete that took them. */

function reorganisedOnce() {
  const t = start();
  const ch = t.chapter("Chapter 1");
  const arc = t.folder("Arc", ROOT, D, CHAT);
  t.w.move(D, CHAT, ch, arc);
  return t;
}

describe("part 5: what a document is, and a move between two lists", () => {
  const MINE = sourceRoot("user-files");

  it("29. a document's type is its create's until a rename changes it; a provisional name ends at the first rename by a person, even to the same name", () => {
    const t = start();
    const ch = t.w.create(LIVE, WRITER, {
      kind: "document",
      filetype: "markdown",
      name: "Untitled",
      parent: ROOT,
      provisional: true,
    }).node;
    t.w.rename(LIVE, CHAT, ch, "Untitled.txt", "text");
    expect(t.at(ch)).toMatchObject({ filetype: "text", provisional: true });
    expect(projectedRows(t.w.view(LIVE)).get(ch)).toMatchObject({
      filetype: "text",
      extension: "txt",
    });
    t.w.rename(LIVE, WRITER, ch, "Untitled.txt");
    expect(t.at(ch)).toMatchObject({ filetype: "text", provisional: false });
  });

  it("30. a document moved to another list is in no view and no Trash there, and a record arriving for it after is skipped", () => {
    const here = start();
    const there = start();
    const ch = here.chapter("Chapter 1");
    const folder = here.folder("Arc");
    here.w.rename(LIVE, WRITER, ch, "Chapter One", "text");
    const { left, entered } = moveBetweenLists(
      { writer: here.w, list: "project" },
      { writer: there.w, list: "account", parent: MINE },
      WRITER,
      ch,
    );
    expect(left).toMatchObject({ type: "move", parent: "list:account" });
    expect(entered).toMatchObject({
      type: "create",
      node: ch,
      name: "Chapter One",
      filetype: "text",
    });
    expect(here.names(ROOT)).toEqual(["Arc"]);
    expect(here.at(ch)).toBeUndefined();
    expect(there.at(ch)).toMatchObject({ name: "Chapter One", source: "user-files", parent: MINE });
    // A client that had not seen the move renames it in the list it left.
    const late = here.w.rename(LIVE, WRITER, ch, "Late");
    expect(here.w.view(LIVE).skipped).toContainEqual({ record: late.id, reason: "missing-node" });
    expect(there.at(ch)?.name).toBe("Chapter One");
    expect(() =>
      moveBetweenLists(
        { writer: here.w, list: "project" },
        { writer: there.w, list: "account", parent: MINE },
        WRITER,
        folder,
      ),
    ).toThrow();
  });

  it("31. a document moved out and back stands in the list it returned to, with its type, and was never in Trash", () => {
    const here = start();
    const there = start();
    const ch = here.w.create(LIVE, WRITER, {
      kind: "document",
      filetype: "markdown",
      name: "Chapter 1",
      parent: ROOT,
    }).node;
    const out = { writer: here.w, list: "project" };
    const away = { writer: there.w, list: "account" };
    moveBetweenLists(out, { ...away, parent: MINE }, WRITER, ch);
    moveBetweenLists(away, { ...out, parent: ROOT }, WRITER, ch);
    expect(here.at(ch)).toMatchObject({ name: "Chapter 1", filetype: "markdown", trashed: false });
    expect(there.at(ch)).toBeUndefined();
    expect(here.w.view(LIVE).trash).toEqual([]);
    expect(there.w.view(LIVE).trash).toEqual([]);
    here.valid();
  });
});

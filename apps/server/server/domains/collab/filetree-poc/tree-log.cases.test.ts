/** Proof-of-concept cases for the Yjs file-tree log: the conflicts that break trees, by name. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  childrenOf,
  fingerprint,
  LIVE,
  materialize,
  ROOT,
  TreeWriter,
  treeViolations,
} from "./tree-log.js";

const W = "user:writer";
const A = "agent:thread-1/turn-1";

function replica(clientID: number): TreeWriter {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  return new TreeWriter(doc);
}

function sync(...writers: TreeWriter[]) {
  for (const from of writers)
    for (const to of writers)
      if (from !== to)
        Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
}

function names(writer: TreeWriter, parent: string, draft: string | null = null): string[] {
  return childrenOf(materialize(writer.doc, { draft }), parent).map((node) => node.displayName);
}

function pair() {
  const a = replica(1);
  const b = replica(2);
  return { a, b };
}

describe("file tree as a Yjs operation log", () => {
  it("concurrent moves that would form a cycle: one is skipped, both replicas agree", () => {
    const { a, b } = pair();
    const x = a.create(LIVE, W, { kind: "folder", name: "X", parent: ROOT }).node;
    const y = a.create(LIVE, W, { kind: "folder", name: "Y", parent: ROOT }).node;
    sync(a, b);
    a.move(LIVE, W, x, y);
    b.move(LIVE, A, y, x);
    sync(a, b);
    const pa = materialize(a.doc, LIVE);
    const pb = materialize(b.doc, LIVE);
    expect(treeViolations(pa)).toEqual([]);
    expect(pa.skipped.map((s) => s.reason)).toEqual(["cycle"]);
    expect([...pa.nodes.values()].map((n) => [n.id, n.parent])).toEqual(
      [...pb.nodes.values()].map((n) => [n.id, n.parent]),
    );
  });

  it("move against delete: the moved node leaves the deleted folder and survives", () => {
    const { a, b } = pair();
    const f = a.create(LIVE, W, { kind: "folder", name: "Old", parent: ROOT }).node;
    const keep = a.create(LIVE, W, { kind: "folder", name: "Keep", parent: ROOT }).node;
    const doc = a.create(LIVE, W, { kind: "document", name: "Ch1", parent: f }).node;
    sync(a, b);
    a.delete(LIVE, W, f); // the writer saw Ch1 inside and deleted it with the folder
    b.move(LIVE, A, doc, keep); // meanwhile the agent moved Ch1 out
    sync(a, b);
    const live = materialize(a.doc, LIVE);
    expect(treeViolations(live)).toEqual([]);
    expect(live.nodes.get(f)?.trashed).toBe(true);
    expect(live.nodes.get(doc)).toMatchObject({ parent: keep, trashed: false });
  });

  it("create in a folder that was deleted: the folder stays, marked as kept by its child", () => {
    const { a, b } = pair();
    const f = a.create(LIVE, W, { kind: "folder", name: "Arc 2", parent: ROOT }).node;
    sync(a, b);
    a.delete(LIVE, W, f);
    const made = b.create(LIVE, A, { kind: "document", name: "Ch9", parent: f }).node;
    sync(a, b);
    const live = materialize(b.doc, LIVE);
    expect(treeViolations(live)).toEqual([]);
    expect(live.nodes.get(f)).toMatchObject({ trashed: false, keptByChild: true });
    expect(live.nodes.get(made)?.trashed).toBe(false);
    expect(materialize(a.doc, LIVE).nodes.get(f)).toMatchObject({ keptByChild: true });
  });

  it("rename against rename: one name wins, the same one everywhere", () => {
    const { a, b } = pair();
    const n = a.create(LIVE, W, { kind: "document", name: "Draft", parent: ROOT }).node;
    sync(a, b);
    a.rename(LIVE, W, n, "Prologue");
    b.rename(LIVE, A, n, "Opening");
    sync(a, b);
    expect(materialize(a.doc, LIVE).nodes.get(n)?.name).toBe(
      materialize(b.doc, LIVE).nodes.get(n)?.name,
    );
  });

  it("two creates with one name in one folder: both kept, the later one numbered", () => {
    const { a, b } = pair();
    a.create(LIVE, W, { kind: "document", name: "Notes", parent: ROOT });
    b.create(LIVE, A, { kind: "document", name: "Notes", parent: ROOT });
    sync(a, b);
    expect(names(a, ROOT).sort()).toEqual(["Notes", "Notes (2)"]);
    expect(names(a, ROOT)).toEqual(names(b, ROOT));
  });

  it("reorder against reorder: every replica shows one order", () => {
    const { a, b } = pair();
    for (const name of ["1", "2", "3", "4"])
      a.create(LIVE, W, { kind: "document", name, parent: ROOT });
    sync(a, b);
    const [one, , , four] = childrenOf(materialize(a.doc, LIVE), ROOT).map((n) => n.id) as string[];
    a.move(LIVE, W, four as string, ROOT, 0);
    b.move(LIVE, A, one as string, ROOT, 4);
    b.move(LIVE, A, four as string, ROOT, 2);
    sync(a, b);
    expect(names(a, ROOT)).toEqual(names(b, ROOT));
    expect(names(a, ROOT)).toHaveLength(4);
  });

  it("a draft reads as live plus its changes, and sees live changes made after it started", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, { kind: "document", name: "Ch1", parent: ROOT }).node;
    const work = { draft: "work-1" };
    const folder = a.create(work, A, { kind: "folder", name: "Arc 1", parent: ROOT }).node;
    a.move(work, A, ch, folder);
    a.create(LIVE, W, { kind: "document", name: "Ch2", parent: ROOT });
    expect(names(a, ROOT)).toEqual(["Ch1", "Ch2"]);
    // Both were appended after Ch1 and got the same rank; the id breaks the tie the same way
    // everywhere, which is not necessarily the order each author saw.
    expect(names(a, ROOT, "work-1").sort()).toEqual(["Arc 1", "Ch2"]);
    expect(names(a, folder, "work-1")).toEqual(["Ch1"]);
  });

  it("a draft applied after live changed under it: live becomes what the draft showed", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, { kind: "document", name: "Ch1", parent: ROOT }).node;
    const work = { draft: "work-1" };
    a.rename(work, A, ch, "Chapter One");
    const arc = a.create(work, A, { kind: "folder", name: "Arc", parent: ROOT }).node;
    a.move(work, A, ch, arc);
    // Live moves on: the writer renames the same document and adds another.
    a.rename(LIVE, W, ch, "Ch 1 (writer)");
    a.create(LIVE, W, { kind: "document", name: "Ch2", parent: ROOT });
    const before = materialize(a.doc, work);
    a.apply("work-1", W);
    const after = materialize(a.doc, LIVE);
    expect(after.nodes.get(ch)).toMatchObject({
      name: "Chapter One",
      parent: arc,
      createdBy: W,
      lastChangedBy: A,
    });
    expect([...after.nodes.values()].map((n) => [n.id, n.parent, n.name, n.rank])).toEqual(
      [...before.nodes.values()].map((n) => [n.id, n.parent, n.name, n.rank]),
    );
    expect(names(a, ROOT, "work-1")).toEqual(names(a, ROOT));
  });

  it("a drafted move that live made cyclic is skipped in the draft's view and on Apply", () => {
    const a = replica(1);
    const x = a.create(LIVE, W, { kind: "folder", name: "X", parent: ROOT }).node;
    const y = a.create(LIVE, W, { kind: "folder", name: "Y", parent: ROOT }).node;
    const work = { draft: "w" };
    const drafted = a.move(work, A, x, y);
    a.move(LIVE, W, y, x);
    expect(materialize(a.doc, work).skipped).toEqual([{ op: drafted.id, reason: "cycle" }]);
    a.apply("w", W);
    const live = materialize(a.doc, LIVE);
    expect(treeViolations(live)).toEqual([]);
    expect(live.nodes.get(y)?.parent).toBe(x);
  });

  it("discard of part of a draft takes what depends on it, and leaves the rest", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, { kind: "document", name: "Ch1", parent: ROOT }).node;
    const work = { draft: "w" };
    const arc = a.create(work, A, { kind: "folder", name: "Arc", parent: ROOT });
    const inArc = a.create(work, A, { kind: "document", name: "Scene", parent: arc.node });
    const moveIn = a.move(work, A, ch, arc.node);
    const rename = a.rename(work, A, ch, "Chapter 1");
    const discarded = a.discard("w", [arc.id]);
    expect(new Set(discarded)).toEqual(new Set([arc.id, inArc.id, moveIn.id]));
    const view = materialize(a.doc, work);
    expect(treeViolations(view)).toEqual([]);
    expect(view.nodes.get(ch)).toMatchObject({ parent: ROOT, name: "Chapter 1" });
    expect(view.nodes.has(arc.node)).toBe(false);
    a.apply("w", W, [rename.id]);
    expect(materialize(a.doc, LIVE).nodes.get(ch)?.name).toBe("Chapter 1");
  });

  it("partial Apply brings the folders a chosen op stands on", () => {
    const a = replica(1);
    const work = { draft: "w" };
    const arc = a.create(work, A, { kind: "folder", name: "Arc", parent: ROOT });
    const scene = a.create(work, A, { kind: "document", name: "Scene", parent: arc.node });
    a.create(work, A, { kind: "document", name: "Other", parent: ROOT });
    a.apply("w", W, [scene.id]);
    const live = materialize(a.doc, LIVE);
    expect(live.nodes.get(scene.node)?.parent).toBe(arc.node);
    expect(names(a, ROOT)).toEqual(["Arc"]);
    expect(names(a, ROOT, "w")).toEqual(["Arc", "Other"]);
  });

  it("undo of a move returns the node; undo after someone else moved it is refused", () => {
    const a = replica(1);
    const f = a.create(LIVE, W, { kind: "folder", name: "F", parent: ROOT }).node;
    const g = a.create(LIVE, W, { kind: "folder", name: "G", parent: ROOT }).node;
    const ch = a.create(LIVE, W, { kind: "document", name: "Ch", parent: f }).node;
    const before = materialize(a.doc, LIVE);
    const move = a.move(LIVE, A, ch, g);
    const inverse = a.undo(LIVE, W, move.id);
    expect(inverse).toMatchObject({ undoes: move.id, actor: W });
    const after = materialize(a.doc, LIVE);
    expect(after.nodes.get(ch)).toMatchObject({ parent: f, rank: before.nodes.get(ch)?.rank });
    const again = a.move(LIVE, A, ch, g);
    a.move(LIVE, W, ch, ROOT);
    expect(a.undo(LIVE, W, again.id)).toBe("superseded");
  });

  it("undo of a folder delete brings back the folder and what it held", () => {
    const a = replica(1);
    const f = a.create(LIVE, W, { kind: "folder", name: "F", parent: ROOT }).node;
    const ch = a.create(LIVE, W, { kind: "document", name: "Ch", parent: f }).node;
    const del = a.delete(LIVE, A, f);
    expect(materialize(a.doc, LIVE).nodes.get(ch)?.trashed).toBe(true);
    a.undo(LIVE, W, del.id);
    const live = materialize(a.doc, LIVE);
    expect(live.nodes.get(f)?.trashed).toBe(false);
    expect(live.nodes.get(ch)?.trashed).toBe(false);
  });

  it("a binary file is a node with a pointer to its bytes", () => {
    const a = replica(1);
    const blob = { storageKey: "uploads/abc", mime: "image/png", size: 1234 };
    const img = a.create(LIVE, W, { kind: "file", name: "map.png", parent: ROOT, blob }).node;
    expect(materialize(a.doc, LIVE).nodes.get(img)?.blob).toEqual(blob);
    const doc = a.create(LIVE, W, { kind: "document", name: "Doc", parent: ROOT }).node;
    a.move(LIVE, W, doc, img);
    expect(materialize(a.doc, LIVE).nodes.get(doc)?.parent).toBe(ROOT);
  });

  it("merging a draft's raw Yjs updates instead of rebasing lets client ids pick the winner", () => {
    // Why Apply re-authors ops: a fork merged as a CRDT orders its old ops by causality, so a
    // drafted rename concurrent with a live rename wins or loses on client id, not on Apply.
    const outcomes = new Set<string>();
    for (const [liveId, draftId] of [
      [1, 2],
      [2, 1],
    ] as const) {
      const live = replica(liveId);
      const n = live.create(LIVE, W, { kind: "document", name: "Ch", parent: ROOT }).node;
      const fork = replica(draftId);
      sync(live, fork);
      fork.rename(LIVE, A, n, "drafted");
      live.rename(LIVE, W, n, "live");
      sync(fork, live);
      outcomes.add(materialize(live.doc, LIVE).nodes.get(n)?.name as string);
    }
    expect(outcomes).toEqual(new Set(["drafted", "live"]));
  });
});

describe("file tree log: cases found in review", () => {
  it("two deletes of one folder both count, whatever the client ids", () => {
    const outcomes = new Set<string>();
    for (const [ia, ib] of [
      [1, 2],
      [2, 1],
    ] as const) {
      const a = replica(ia);
      const b = replica(ib);
      const f = a.create(LIVE, W, { kind: "folder", name: "F", parent: ROOT }).node;
      a.create(LIVE, W, { kind: "document", name: "x", parent: f });
      sync(a, b);
      a.create(LIVE, W, { kind: "document", name: "y", parent: f });
      a.delete(LIVE, W, f);
      b.delete(LIVE, A, f);
      sync(a, b);
      const live = materialize(a.doc, LIVE);
      expect(treeViolations(live)).toEqual([]);
      outcomes.add([...live.nodes.values()].map((n) => `${n.name}:${n.trashed}`).join(","));
    }
    expect(outcomes.size).toBe(1);
    expect([...outcomes][0]).not.toContain("false,y");
    expect([...outcomes][0]).toContain("y:true");
  });

  it("applying a later rename alone brings the earlier one, so the draft doesn't go backwards", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, { kind: "document", name: "Ch", parent: ROOT }).node;
    const work = { draft: "w" };
    a.rename(work, A, ch, "First");
    const second = a.rename(work, A, ch, "Second");
    a.apply("w", W, [second.id]);
    expect(materialize(a.doc, LIVE).nodes.get(ch)?.name).toBe("Second");
    expect(materialize(a.doc, work).nodes.get(ch)?.name).toBe("Second");
  });

  it("a partial Apply whose move depends on an earlier drafted move takes both", () => {
    const a = replica(1);
    const x = a.create(LIVE, W, { kind: "folder", name: "X", parent: ROOT }).node;
    const y = a.create(LIVE, W, { kind: "folder", name: "Y", parent: x }).node;
    const work = { draft: "w" };
    a.move(work, A, y, ROOT);
    const dependent = a.move(work, A, x, y);
    const before = fingerprint(materialize(a.doc, work));
    a.apply("w", W, [dependent.id]);
    expect(fingerprint(materialize(a.doc, work))).toBe(before);
    expect(materialize(a.doc, LIVE).nodes.get(x)?.parent).toBe(y);
  });

  it("restoring a document doesn't take the name from the one standing there", () => {
    const a = replica(1);
    const old = a.create(LIVE, W, { kind: "document", name: "Ch1", parent: ROOT }).node;
    a.delete(LIVE, W, old);
    const current = a.create(LIVE, W, { kind: "document", name: "Ch1", parent: ROOT }).node;
    a.restore(LIVE, W, old);
    const live = materialize(a.doc, LIVE);
    expect(live.nodes.get(current)?.displayName).toBe("Ch1");
    expect(live.nodes.get(old)?.displayName).toBe("Ch1 (2)");
  });

  it("undo of a move into a folder deleted since is refused, not a revival", () => {
    const a = replica(1);
    const f = a.create(LIVE, W, { kind: "folder", name: "F", parent: ROOT }).node;
    const ch = a.create(LIVE, W, { kind: "document", name: "Ch", parent: f }).node;
    const move = a.move(LIVE, A, ch, ROOT);
    a.delete(LIVE, W, f);
    expect(a.undo(LIVE, W, move.id)).toBe("superseded");
  });

  it("an applied copy names who drafted it and who applied it", () => {
    const a = replica(1);
    a.create({ draft: "w" }, A, { kind: "document", name: "Ch", parent: ROOT });
    const [copy] = a.apply("w", W);
    expect(copy).toMatchObject({ actor: A, appliedBy: W, draft: null });
  });
});

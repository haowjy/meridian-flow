/** Proof-of-concept cases for the Yjs file-tree log: the conflicts that break trees, by name. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDraft,
  childrenOf,
  discardDraft,
  discardedBy,
  fingerprint,
  LIVE,
  recordsOf,
  replayView,
  restoreDiscard,
  sourceRoot,
  TreeWriter,
  treeViolations,
  undoChange,
} from "./index.js";

const ROOT = sourceRoot("manuscript");

const cmd = () => crypto.randomUUID();

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
  return childrenOf(replayView(writer.doc, { draft }), parent).map((node) => node.displayName);
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
    const pa = replayView(a.doc, LIVE);
    const pb = replayView(b.doc, LIVE);
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
    const doc = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch1",
      parent: f,
    }).node;
    sync(a, b);
    a.delete(LIVE, W, f); // the writer saw Ch1 inside and deleted it with the folder
    b.move(LIVE, A, doc, keep); // meanwhile the agent moved Ch1 out
    sync(a, b);
    const live = replayView(a.doc, LIVE);
    expect(treeViolations(live)).toEqual([]);
    expect(live.nodes.get(f)?.trashed).toBe(true);
    expect(live.nodes.get(doc)).toMatchObject({ parent: keep, trashed: false });
  });

  it("create in a folder that was deleted: the folder stays, marked as kept by its child", () => {
    const { a, b } = pair();
    const f = a.create(LIVE, W, { kind: "folder", name: "Arc 2", parent: ROOT }).node;
    sync(a, b);
    a.delete(LIVE, W, f);
    const made = b.create(LIVE, A, {
      kind: "document",
      filetype: "markdown",
      name: "Ch9",
      parent: f,
    }).node;
    sync(a, b);
    const live = replayView(b.doc, LIVE);
    expect(treeViolations(live)).toEqual([]);
    expect(live.nodes.get(f)).toMatchObject({ trashed: false, keptByChild: true });
    expect(live.nodes.get(made)?.trashed).toBe(false);
    expect(replayView(a.doc, LIVE).nodes.get(f)).toMatchObject({ keptByChild: true });
  });

  it("rename against rename: one name wins, the same one everywhere", () => {
    const { a, b } = pair();
    const n = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Draft",
      parent: ROOT,
    }).node;
    sync(a, b);
    a.rename(LIVE, W, n, "Prologue");
    b.rename(LIVE, A, n, "Opening");
    sync(a, b);
    expect(replayView(a.doc, LIVE).nodes.get(n)?.name).toBe(
      replayView(b.doc, LIVE).nodes.get(n)?.name,
    );
  });

  it("two creates with one name in one folder: both kept, the later one numbered", () => {
    const { a, b } = pair();
    a.create(LIVE, W, { kind: "document", filetype: "markdown", name: "Notes", parent: ROOT });
    b.create(LIVE, A, { kind: "document", filetype: "markdown", name: "Notes", parent: ROOT });
    sync(a, b);
    expect(names(a, ROOT).sort()).toEqual(["Notes", "Notes (2)"]);
    expect(names(a, ROOT)).toEqual(names(b, ROOT));
  });

  it("reorder against reorder: every replica shows one order", () => {
    const { a, b } = pair();
    for (const name of ["1", "2", "3", "4"])
      a.create(LIVE, W, { kind: "document", filetype: "markdown", name, parent: ROOT });
    sync(a, b);
    const [one, , , four] = childrenOf(replayView(a.doc, LIVE), ROOT).map((n) => n.id) as string[];
    a.move(LIVE, W, four as string, ROOT, 0);
    b.move(LIVE, A, one as string, ROOT, 4);
    b.move(LIVE, A, four as string, ROOT, 2);
    sync(a, b);
    expect(names(a, ROOT)).toEqual(names(b, ROOT));
    expect(names(a, ROOT)).toHaveLength(4);
  });

  it("a draft reads as live plus its changes, and sees live changes made after it started", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch1",
      parent: ROOT,
    }).node;
    const work = { draft: "work-1" };
    const folder = a.create(work, A, { kind: "folder", name: "Arc 1", parent: ROOT }).node;
    a.move(work, A, ch, folder);
    a.create(LIVE, W, { kind: "document", filetype: "markdown", name: "Ch2", parent: ROOT });
    expect(names(a, ROOT)).toEqual(["Ch1", "Ch2"]);
    // Both were appended after Ch1 and got the same rank; the id breaks the tie the same way
    // everywhere, which is not necessarily the order each author saw.
    expect(names(a, ROOT, "work-1").sort()).toEqual(["Arc 1", "Ch2"]);
    expect(names(a, folder, "work-1")).toEqual(["Ch1"]);
  });

  it("a draft applied after live changed under it: live becomes what the draft showed", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch1",
      parent: ROOT,
    }).node;
    const work = { draft: "work-1" };
    a.rename(work, A, ch, "Chapter One");
    const arc = a.create(work, A, { kind: "folder", name: "Arc", parent: ROOT }).node;
    a.move(work, A, ch, arc);
    // Live moves on: the writer renames the same document and adds another.
    a.rename(LIVE, W, ch, "Ch 1 (writer)");
    a.create(LIVE, W, { kind: "document", filetype: "markdown", name: "Ch2", parent: ROOT });
    const before = replayView(a.doc, work);
    applyDraft(a, "work-1", W, cmd());
    const after = replayView(a.doc, LIVE);
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
    expect(replayView(a.doc, work).skipped).toEqual([{ record: drafted.id, reason: "cycle" }]);
    applyDraft(a, "w", W, cmd());
    const live = replayView(a.doc, LIVE);
    expect(treeViolations(live)).toEqual([]);
    expect(live.nodes.get(y)?.parent).toBe(x);
  });

  it("discard of part of a draft takes what depends on it, and leaves the rest", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch1",
      parent: ROOT,
    }).node;
    const work = { draft: "w" };
    const arc = a.create(work, A, { kind: "folder", name: "Arc", parent: ROOT });
    const inArc = a.create(work, A, {
      kind: "document",
      filetype: "markdown",
      name: "Scene",
      parent: arc.node,
    });
    const moveIn = a.move(work, A, ch, arc.node);
    const rename = a.rename(work, A, ch, "Chapter 1");
    const discarded = discardDraft(a, "w", W, cmd(), [arc.id]);
    expect(new Set(discarded)).toEqual(new Set([arc.id, inArc.id, moveIn.id]));
    const view = replayView(a.doc, work);
    expect(treeViolations(view)).toEqual([]);
    expect(view.nodes.get(ch)).toMatchObject({ parent: ROOT, name: "Chapter 1" });
    expect(view.nodes.has(arc.node)).toBe(false);
    applyDraft(a, "w", W, cmd(), [rename.id]);
    expect(replayView(a.doc, LIVE).nodes.get(ch)?.name).toBe("Chapter 1");
  });

  it("partial Apply brings the folders a chosen op stands on", () => {
    const a = replica(1);
    const work = { draft: "w" };
    const arc = a.create(work, A, { kind: "folder", name: "Arc", parent: ROOT });
    const scene = a.create(work, A, {
      kind: "document",
      filetype: "markdown",
      name: "Scene",
      parent: arc.node,
    });
    a.create(work, A, { kind: "document", filetype: "markdown", name: "Other", parent: ROOT });
    applyDraft(a, "w", W, cmd(), [scene.id]);
    const live = replayView(a.doc, LIVE);
    expect(live.nodes.get(scene.node)?.parent).toBe(arc.node);
    expect(names(a, ROOT)).toEqual(["Arc"]);
    expect(names(a, ROOT, "w")).toEqual(["Arc", "Other"]);
  });

  it("undo of a move returns the node; undo after someone else moved it is refused", () => {
    const a = replica(1);
    const f = a.create(LIVE, W, { kind: "folder", name: "F", parent: ROOT }).node;
    const g = a.create(LIVE, W, { kind: "folder", name: "G", parent: ROOT }).node;
    const ch = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch",
      parent: f,
    }).node;
    const before = replayView(a.doc, LIVE);
    const move = a.move(LIVE, A, ch, g);
    const inverse = undoChange(a, LIVE, W, move.id);
    expect(inverse).toMatchObject({ undoes: move.id, actor: W });
    const after = replayView(a.doc, LIVE);
    expect(after.nodes.get(ch)).toMatchObject({ parent: f, rank: before.nodes.get(ch)?.rank });
    const again = a.move(LIVE, A, ch, g);
    a.move(LIVE, W, ch, ROOT);
    expect(undoChange(a, LIVE, W, again.id)).toBe("superseded");
  });

  it("undo of a folder delete brings back the folder and what it held", () => {
    const a = replica(1);
    const f = a.create(LIVE, W, { kind: "folder", name: "F", parent: ROOT }).node;
    const ch = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch",
      parent: f,
    }).node;
    const del = a.delete(LIVE, A, f);
    expect(replayView(a.doc, LIVE).nodes.get(ch)?.trashed).toBe(true);
    undoChange(a, LIVE, W, del.id);
    const live = replayView(a.doc, LIVE);
    expect(live.nodes.get(f)?.trashed).toBe(false);
    expect(live.nodes.get(ch)?.trashed).toBe(false);
  });

  it("a binary file is a node with a pointer to its bytes", () => {
    const a = replica(1);
    const blob = { storageKey: "uploads/abc", mime: "image/png", size: 1234 };
    const img = a.create(LIVE, W, { kind: "file", name: "map.png", parent: ROOT, blob }).node;
    expect(replayView(a.doc, LIVE).nodes.get(img)?.blob).toEqual(blob);
    const doc = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Doc",
      parent: ROOT,
    }).node;
    a.move(LIVE, W, doc, img);
    expect(replayView(a.doc, LIVE).nodes.get(doc)?.parent).toBe(ROOT);
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
      const n = live.create(LIVE, W, {
        kind: "document",
        filetype: "markdown",
        name: "Ch",
        parent: ROOT,
      }).node;
      const fork = replica(draftId);
      sync(live, fork);
      fork.rename(LIVE, A, n, "drafted");
      live.rename(LIVE, W, n, "live");
      sync(fork, live);
      outcomes.add(replayView(live.doc, LIVE).nodes.get(n)?.name as string);
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
      a.create(LIVE, W, { kind: "document", filetype: "markdown", name: "x", parent: f });
      sync(a, b);
      a.create(LIVE, W, { kind: "document", filetype: "markdown", name: "y", parent: f });
      a.delete(LIVE, W, f);
      b.delete(LIVE, A, f);
      sync(a, b);
      const live = replayView(a.doc, LIVE);
      expect(treeViolations(live)).toEqual([]);
      outcomes.add([...live.nodes.values()].map((n) => `${n.name}:${n.trashed}`).join(","));
    }
    expect(outcomes.size).toBe(1);
    expect([...outcomes][0]).not.toContain("false,y");
    expect([...outcomes][0]).toContain("y:true");
  });

  it("applying a later rename alone brings the earlier one, so the draft doesn't go backwards", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch",
      parent: ROOT,
    }).node;
    const work = { draft: "w" };
    a.rename(work, A, ch, "First");
    const second = a.rename(work, A, ch, "Second");
    applyDraft(a, "w", W, cmd(), [second.id]);
    expect(replayView(a.doc, LIVE).nodes.get(ch)?.name).toBe("Second");
    expect(replayView(a.doc, work).nodes.get(ch)?.name).toBe("Second");
  });

  it("a partial Apply whose move depends on an earlier drafted move takes both", () => {
    const a = replica(1);
    const x = a.create(LIVE, W, { kind: "folder", name: "X", parent: ROOT }).node;
    const y = a.create(LIVE, W, { kind: "folder", name: "Y", parent: x }).node;
    const work = { draft: "w" };
    a.move(work, A, y, ROOT);
    const dependent = a.move(work, A, x, y);
    const before = fingerprint(replayView(a.doc, work));
    applyDraft(a, "w", W, cmd(), [dependent.id]);
    expect(fingerprint(replayView(a.doc, work))).toBe(before);
    expect(replayView(a.doc, LIVE).nodes.get(x)?.parent).toBe(y);
  });

  it("restoring a document doesn't take the name from the one standing there", () => {
    const a = replica(1);
    const old = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch1",
      parent: ROOT,
    }).node;
    a.delete(LIVE, W, old);
    const current = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch1",
      parent: ROOT,
    }).node;
    a.restore(LIVE, W, old);
    const live = replayView(a.doc, LIVE);
    expect(live.nodes.get(current)?.displayName).toBe("Ch1");
    expect(live.nodes.get(old)?.displayName).toBe("Ch1 (2)");
  });

  it("undo of a move into a folder deleted since is refused, not a revival", () => {
    const a = replica(1);
    const f = a.create(LIVE, W, { kind: "folder", name: "F", parent: ROOT }).node;
    const ch = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch",
      parent: f,
    }).node;
    const move = a.move(LIVE, A, ch, ROOT);
    a.delete(LIVE, W, f);
    expect(undoChange(a, LIVE, W, move.id)).toBe("superseded");
  });

  it("an applied copy names who drafted it and who applied it", () => {
    const a = replica(1);
    a.create({ draft: "w" }, A, {
      kind: "document",
      filetype: "markdown",
      name: "Ch",
      parent: ROOT,
    });
    const [copy] = applyDraft(a, "w", W, cmd()).copies;
    expect(copy).toMatchObject({ actor: A, appliedBy: W, draft: null });
  });

  it("a purged node is gone for good: later records on it are skipped and it is in no Trash entry", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Old",
      parent: ROOT,
    }).node;
    a.delete(LIVE, W, ch);
    expect(replayView(a.doc, LIVE).trash.map((entry) => entry.node)).toEqual([ch]);
    a.author(LIVE, "system", { type: "purge", node: ch });
    a.restore(LIVE, W, ch);
    a.rename(LIVE, W, ch, "Back");
    const live = replayView(a.doc, LIVE);
    expect(live.skipped.map((s) => s.reason)).toEqual(["purged", "purged"]);
    expect(live.trash).toEqual([]);
    expect(live.nodes.get(ch)).toMatchObject({ purged: true, trashed: true });
    expect(names(a, ROOT)).toEqual([]);
  });

  it("restoring a Discard appends new pending copies and leaves the discarded records discarded", () => {
    const a = replica(1);
    const ch = a.create(LIVE, W, {
      kind: "document",
      filetype: "markdown",
      name: "Ch",
      parent: ROOT,
    }).node;
    const renamed = a.rename({ draft: "w" }, A, ch, "Draft name");
    discardDraft(a, "w", W, "cmd-1");
    a.rename({ draft: "w" }, A, ch, "Newer name");
    expect(names(a, ROOT, "w")).toEqual(["Newer name"]);
    const result = restoreDiscard(a, "cmd-1", A);
    if (result === "superseded") throw new Error("expected copies");
    expect(result.copies).toHaveLength(1);
    expect(result.copies[0]).toMatchObject({
      type: "rename",
      node: ch,
      name: "Draft name",
      restores: "cmd-1",
      restoredBy: A,
      actor: A,
    });
    expect(result.copies[0]?.id).not.toBe(renamed.id);
    // The restored change lands after the newer one, so it wins; the discarded record stays discarded.
    expect(names(a, ROOT, "w")).toEqual(["Draft name"]);
    expect(discardedBy(a.doc, "cmd-1")).toMatchObject({
      records: [{ id: renamed.id }],
      restored: true,
    });
    expect(restoreDiscard(a, "cmd-1", A)).toBe("superseded");
  });

  it("restoring a Discard leaves out a record whose node was purged, and reports it", () => {
    const a = replica(1);
    const arc = a.create(LIVE, A, { kind: "folder", name: "Arc", parent: ROOT }).node;
    const renamed = a.rename({ draft: "w" }, A, arc, "Act 1");
    discardDraft(a, "w", W, "cmd-1");
    a.author(LIVE, "system", { type: "purge", node: arc });
    const result = restoreDiscard(a, "cmd-1", A);
    expect(result).toEqual({ copies: [], leftOut: [renamed] });
  });

  it("a record id counts once: two copies that appended the same record merge to one act", () => {
    const { a, b } = pair();
    const again = {
      id: "same-record",
      actor: W,
      draft: null,
      type: "create",
      node: "n",
      kind: "document",
      filetype: "markdown",
      name: "Ch",
      parent: ROOT,
      source: "manuscript",
      rank: "a0",
    };
    for (const copy of [a, b]) copy.doc.getArray("ops").push([again]);
    sync(a, b);
    expect(recordsOf(a.doc).length).toBe(2);
    expect(replayView(a.doc, LIVE).skipped).toEqual([]);
    expect(names(a, ROOT)).toEqual(["Ch"]);
  });

  it("two writers on one copy never make the same record id", () => {
    const doc = new Y.Doc({ gc: false });
    const first = new TreeWriter(doc);
    const second = new TreeWriter(doc);
    first.create(LIVE, W, { kind: "folder", name: "A", parent: ROOT });
    second.create(LIVE, W, { kind: "folder", name: "B", parent: ROOT });
    const ids = recordsOf(doc).map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

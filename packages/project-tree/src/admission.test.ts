/**
 * The guard against updates an honest client never sends, and the one verdict the server still
 * writes (a create raced into a closed Work).
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - the guard's fault list (4.2, 4.3 of the never-refuse plan)
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { admit as admitTo, type Connection, CopyFault } from "./admission.js";
import {
  LIVE,
  lastSettlements,
  recordsOf,
  replayView,
  sourceRoot,
  type TreeRecord,
  TreeWriter,
} from "./index.js";
import { undoChange } from "./undo-open.js";

const source = sourceRoot;
const ROOT = source("manuscript");

const ME = "user:me";
const connection: Connection = {
  drafts: new Set(["my-work"]),
  closed: (source) => source === "old-scratch",
};

/** The server's list: two sources the account may write, one it may not, some nodes. */
function server() {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 7;
  const w = new TreeWriter(doc);
  const arc = w.create(LIVE, "system", {
    kind: "folder",
    name: "Arc",
    parent: ROOT,
    node: "arc",
  }).node;
  w.create(LIVE, "system", {
    kind: "document",
    filetype: "markdown",
    name: "Ch1",
    parent: arc,
    node: "ch1",
  });
  w.create(LIVE, "system", {
    kind: "document",
    filetype: "markdown",
    name: "Guide",
    parent: source("skills"),
    node: "guide",
  });
  return doc;
}

function admit(doc: Y.Doc, update: Uint8Array, conn: Connection) {
  return admitTo(new TreeWriter(doc), update, conn);
}

/** A client's copy, and the update it would send after `change`. */
function client(doc: Y.Doc, change: (copy: Y.Doc) => void, clientID = 5000) {
  const copy = new Y.Doc({ gc: false });
  copy.clientID = clientID;
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(copy);
  change(copy);
  return { copy, update: Y.encodeStateAsUpdate(copy, before) };
}

const rid = () => `r${Math.random().toString(36).slice(2)}`;
/** A well-formed record of its kind, with `over` laid on top. */
const record = (over: Record<string, unknown> = {}): TreeRecord =>
  ({
    id: rid(),
    actor: ME,
    draft: null,
    type: "create",
    node: rid(),
    kind: "document",
    filetype: "markdown",
    name: "New",
    parent: "arc",
    source: "manuscript",
    rank: "a5",
    ...over,
  }) as unknown as TreeRecord;
const push =
  (...ops: unknown[]) =>
  (copy: Y.Doc) =>
    copy.getArray("ops").push(ops);

/** The fault an update earns, with the server's copy untouched. */
function faultOf(change: (copy: Y.Doc) => void, clientID?: number) {
  const doc = server();
  const before = Y.encodeStateAsUpdate(doc);
  const { update } = client(doc, change, clientID);
  let why = "";
  try {
    admit(doc, update, connection);
  } catch (cause) {
    if (!(cause instanceof CopyFault)) throw cause;
    why = cause.why;
  }
  expect(why).not.toBe("");
  // Nothing was stored: the server's copy is byte for byte what it was.
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  return why;
}

describe("a copy the guard turns away, storing nothing", () => {
  it("a deletion from the list", () => {
    expect(faultOf((copy) => copy.getArray("ops").delete(2, 1))).toBe("a deletion");
  });
  it("a write to the settlements, which only the server appends", () => {
    expect(
      faultOf((copy) =>
        copy.getArray("settle").push([{ id: "s", actor: ME, targets: ["x"], to: "applied" }]),
      ),
    ).toBe("not the list");
  });
  it("a new shared type, a map entry, a nested type, text in the list", () => {
    expect(faultOf((copy) => copy.getMap("extra").set("k", 1))).toBe("a map entry");
    expect(faultOf((copy) => copy.getArray("other").push([record({})]))).toBe("not the list");
    expect(faultOf((copy) => copy.getArray("ops").push([new Y.Map() as unknown]))).toBe(
      "not plain records",
    );
    expect(faultOf((copy) => copy.getText("ops2").insert(0, "hello"))).toBe("not the list");
  });
  it("a client id the server keeps for itself", () => {
    expect(faultOf(push(record({})), 12)).toBe("a reserved client id");
  });
  it("a kind or field only the server writes, from a client id of 1,000 or more", () => {
    for (const over of [
      { type: "purge", delete: "x", node: "ch1" },
      { kind: "file" },
      { carries: "x" },
      { appliedBy: ME },
      { fromDraft: "my-work" },
      { restores: "x" },
      { restoredBy: ME },
      { blob: { storageKey: "k", mime: "x", size: 1 } },
      { aliases: ["x"] },
      { hasProperties: true },
    ])
      expect(faultOf(push(record(over)))).toBe("a kind or field only the server writes");
  });
  it("a struct anchored on a clock the server has not written: it would sit pending and could land in the settle array", () => {
    const doc = server();
    const ahead = new Y.Doc({ gc: false });
    ahead.clientID = 7;
    Y.applyUpdate(ahead, Y.encodeStateAsUpdate(doc));
    ahead.getArray("settle").push([{ id: "s1", actor: "system", targets: ["x"], to: "applied" }]);
    const { update } = client(ahead, (copy) =>
      copy.getArray("settle").push([{ id: "forged", actor: ME, targets: ["y"], to: "applied" }]),
    );
    expect(() => admit(doc, update, connection)).toThrow(CopyFault);
    // Nor does it wait in the server's copy for the clock to arrive.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(ahead, Y.encodeStateVector(doc)));
    expect(doc.getArray("settle").toArray()).toHaveLength(1);
  });
  it("a gap in the writer's own clock", () => {
    const doc = server();
    const { copy } = client(doc, push(record({})));
    const second = client(copy, push(record({})));
    expect(() => admit(doc, second.update, connection)).toThrow(CopyFault);
  });
  it("more records than one update may hold", () => {
    expect(faultOf(push(...Array.from({ length: 2001 }, () => record({}))))).toBe(
      "too many records",
    );
  });
});

describe("what the guard lets through", () => {
  it("a record nobody can read, a forged actor, a source named as a node, a create into a document", () => {
    const doc = server();
    const before = recordsOf(doc).length;
    const { update } = client(
      doc,
      push(
        { not: "a record" },
        record({ actor: "user:someone-else" }),
        record({ type: "rename", node: "source:manuscript", name: "x", fromName: "" }),
        record({ parent: "ch1" }),
      ),
    );
    const admitted = admit(doc, update, connection);
    expect(admitted.dropped).toEqual([]);
    expect(recordsOf(doc).length).toBe(before + 4);
    expect(replayView(doc, LIVE).skipped.map((skip) => skip.reason)).toContain("unreadable");
  });
});

describe("a create raced into a closed Work is stamped dropped", () => {
  const dropped = (doc: Y.Doc) =>
    [...lastSettlements(doc)].filter(([, settle]) => settle.to === "dropped").map(([id]) => id);

  it("a create whose draft is not open, with its reason; one in an open Work or live stands", () => {
    const doc = server();
    const closed = record({ draft: "gone-work" });
    const open = record({ draft: "my-work" });
    const live = record({});
    const { update } = client(doc, push(closed, open, live));
    const admitted = admit(doc, update, connection);
    expect(admitted.dropped).toEqual([closed.id]);
    expect(dropped(doc)).toEqual([closed.id]);
    expect([...lastSettlements(doc).values()][0]?.reason).toBe("Work was closed");
    expect(replayView(doc, LIVE).nodes.has((live as { node: string }).node)).toBe(true);
  });

  it("drops independent records in the same closed source", () => {
    const doc = server();
    const first = record({ parent: source("old-scratch"), source: "old-scratch" });
    const second = record({ parent: source("old-scratch"), source: "old-scratch" });
    const { update } = client(doc, push(first, second));
    expect(admit(doc, update, connection).dropped).toEqual([first.id, second.id]);
  });

  it("keeps an open folder but drops a move from a closed source into it", () => {
    const doc = server();
    new TreeWriter(doc).create(LIVE, "system", {
      kind: "folder",
      name: "X",
      parent: source("old-scratch"),
      node: "x",
    });
    const folder = record({ kind: "folder", filetype: undefined, node: "f" });
    const move = record({
      type: "move",
      node: "x",
      parent: "f",
      rank: "a5",
      from: { parent: source("old-scratch"), rank: "a0" },
      kind: undefined,
      filetype: undefined,
      name: undefined,
      source: undefined,
    });
    const { update } = client(doc, push(folder, move));
    expect(admit(doc, update, connection).dropped).toEqual([move.id]);
    expect(replayView(doc, LIVE).nodes.get("x")?.source).toBe("old-scratch");
    expect(replayView(doc, LIVE).nodes.has("f")).toBe(true);
  });

  it("drops an inserted folder that enables a held move out of a closed source", () => {
    const doc = server();
    new TreeWriter(doc).create(LIVE, "system", {
      kind: "folder",
      name: "X",
      parent: source("old-scratch"),
      node: "x",
    });
    const folder = record({ kind: "folder", filetype: undefined, node: "f" });
    const offline = client(doc, push(folder), 1000);
    doc.clientID = 2000;
    const move = record({
      type: "move",
      node: "x",
      parent: "f",
      rank: "a5",
      from: { parent: source("old-scratch"), rank: "a0" },
      kind: undefined,
      filetype: undefined,
      name: undefined,
      source: undefined,
    });
    recordsOf(doc).push([move]);
    expect(admit(doc, offline.update, connection).dropped).toEqual([folder.id]);
    expect(
      recordsOf(doc)
        .toArray()
        .findIndex((r) => r.id === folder.id),
    ).toBeLessThan(
      recordsOf(doc)
        .toArray()
        .findIndex((r) => r.id === move.id),
    );
    expect(replayView(doc, LIVE).nodes.get("x")?.source).toBe("old-scratch");
  });

  it("a stale Undo of a move counts where the changes in force put the node, not the place it carries", () => {
    const doc = server();
    new TreeWriter(doc).create(LIVE, "system", {
      kind: "folder",
      name: "Kept",
      parent: source("old-scratch"),
      node: "kept",
    });
    new TreeWriter(doc).create(LIVE, "system", {
      kind: "folder",
      name: "P",
      parent: ROOT,
      node: "p",
    });
    const open: Connection = { drafts: connection.drafts, closed: () => false };
    // Two copies of one list, neither seeing the other's move of Ch1; the server orders a's first.
    const a = client(doc, (copy) => new TreeWriter(copy).move(LIVE, ME, "ch1", "kept"), 5000);
    const offline = new Y.Doc({ gc: false });
    offline.clientID = 6000;
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(doc));
    const b = new TreeWriter(offline);
    let since = Y.encodeStateVector(offline);
    const move = b.move(LIVE, ME, "ch1", "p");
    admit(doc, a.update, open);
    admit(doc, Y.encodeStateAsUpdate(offline, since), open);
    expect(replayView(doc, LIVE).nodes.get("ch1")?.parent).toBe("p");
    // The Work closes. b's Undo carries Arc, where b saw Ch1; the server's list sends it to Kept.
    since = Y.encodeStateVector(offline);
    const back = undoChange(b, LIVE, ME, move.id) as TreeRecord;
    expect(back).toMatchObject({ type: "move", parent: "arc" });
    expect(admit(doc, Y.encodeStateAsUpdate(offline, since), connection).dropped).toEqual([
      back.id,
    ]);
    expect(replayView(doc, LIVE).nodes.get("ch1")?.parent).toBe("p");
  });

  it("a live create into a closed Work's source, and what is made inside a dropped folder", () => {
    const doc = server();
    const folder = record({
      kind: "folder",
      filetype: undefined,
      parent: source("old-scratch"),
      source: "old-scratch",
    });
    const inside = record({ parent: (folder as { node: string }).node, source: "old-scratch" });
    const stray = record({ parent: (folder as { node: string }).node });
    const { update } = client(doc, push(folder, inside, stray));
    expect(admit(doc, update, connection).dropped.sort()).toEqual(
      [folder.id, inside.id, stray.id].sort(),
    );
    const live = replayView(doc, LIVE);
    expect(live.nodes.has((folder as { node: string }).node)).toBe(false);
    expect(live.dropped.map((each) => each.record.id).sort()).toEqual(
      [folder.id, inside.id, stray.id].sort(),
    );
  });
  it.each(["rename", "create"] as const)(
    "drops an offline %s placed before a folder moves into a closed source",
    (kind) => {
      const doc = server();
      const offline = client(
        doc,
        (copy) => {
          const w = new TreeWriter(copy);
          if (kind === "rename") w.rename(LIVE, ME, "arc", "Renamed");
          else w.create(LIVE, ME, { kind: "folder", name: "New", parent: "arc" });
        },
        1000,
      );
      const moving = client(
        doc,
        (copy) => new TreeWriter(copy).move(LIVE, ME, "arc", source("old-scratch")),
        2000,
      );
      Y.applyUpdate(doc, moving.update);
      const result = admit(doc, offline.update, connection);
      expect(result.dropped).toHaveLength(1);
      const ops = recordsOf(doc).toArray();
      const inserted = ops.findIndex((op) => op.id === result.dropped[0]);
      const moved = ops.findIndex((op) => op.type === "move" && op.node === "arc");
      expect(inserted).toBeLessThan(moved);
    },
  );
});

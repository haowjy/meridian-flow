/** What admission takes as sent, and the one verdict the server writes (a create raced into a closed Work). */
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { admit as admitTo, type Connection } from "./admission.js";
import {
  LIVE,
  lastSettlements,
  listRecords,
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
  const doc = new LoroDoc();
  doc.setPeerId(7);
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

function admit(doc: LoroDoc, update: Uint8Array, conn: Connection) {
  return admitTo(new TreeWriter(doc), update, conn);
}

/** A client's copy, and the update it would send after `change`. */
function client(doc: LoroDoc, change: (copy: LoroDoc) => void, peer = 5000) {
  const copy = new LoroDoc();
  copy.setPeerId(peer);
  copy.import(doc.export({ mode: "update" }));
  const before = copy.oplogVersion();
  change(copy);
  copy.commit();
  return { copy, update: copy.export({ mode: "update", from: before }) };
}

/** Appends raw values to a copy's records, as a client's own list would hold them. */
function append(doc: LoroDoc, ...values: unknown[]) {
  const ops = doc.getList("ops");
  for (const value of values) ops.push(JSON.parse(JSON.stringify(value)));
  doc.commit();
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
  (copy: LoroDoc) =>
    append(copy, ...ops);

describe("what admission takes as sent", () => {
  it("a record nobody can read, a forged actor, a source named as a node, a create into a document", () => {
    const doc = server();
    const before = doc.getList("ops").length;
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
    expect(doc.getList("ops").length).toBe(before + 4);
    expect(replayView(doc, LIVE).skipped.map((skip) => skip.reason)).toContain("unreadable");
  });
});

describe("a create raced into a closed Work is stamped dropped", () => {
  const dropped = (doc: LoroDoc) =>
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
    doc.setPeerId(2000);
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
    append(doc, move);
    expect(admit(doc, offline.update, connection).dropped).toEqual([folder.id]);
    expect(listRecords(doc).findIndex((r) => r.id === folder.id)).toBeLessThan(
      listRecords(doc).findIndex((r) => r.id === move.id),
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
    const offline = new LoroDoc();
    offline.setPeerId(6000);
    offline.import(doc.export({ mode: "update" }));
    const b = new TreeWriter(offline);
    let since = offline.oplogVersion();
    const move = b.move(LIVE, ME, "ch1", "p");
    admit(doc, a.update, open);
    admit(doc, offline.export({ mode: "update", from: since }), open);
    expect(replayView(doc, LIVE).nodes.get("ch1")?.parent).toBe("p");
    // The Work closes. b's Undo carries Arc, where b saw Ch1; the server's list sends it to Kept.
    since = offline.oplogVersion();
    const back = undoChange(b, LIVE, ME, move.id) as TreeRecord;
    expect(back).toMatchObject({ type: "move", parent: "arc" });
    expect(admit(doc, offline.export({ mode: "update", from: since }), connection).dropped).toEqual(
      [back.id],
    );
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
      doc.import(moving.update);
      const result = admit(doc, offline.update, connection);
      expect(result.dropped).toHaveLength(1);
      const ops = listRecords(doc);
      const inserted = ops.findIndex((op) => op.id === result.dropped[0]);
      const moved = ops.findIndex((op) => op.type === "move" && op.node === "arc");
      expect(inserted).toBeLessThan(moved);
    },
  );
});

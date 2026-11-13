/** The admission check against updates an honest client never sends. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { admit as admitTo, type Connection } from "./admission.js";
import {
  fingerprint,
  LIVE,
  recordsOf,
  replayView,
  sourceRoot,
  type TreeRecord,
  TreeWriter,
} from "./index.js";

const source = sourceRoot;
const ROOT = source("manuscript");

const ME = "user:me";
const connection: Connection = {
  user: ME,
  drafts: new Set(["my-work"]),
  writableSources: new Set(["manuscript", "kb", "unfiled"]),
  unfiledSource: "unfiled",
  editableTypes: new Set(["markdown", "text", "canvas"]),
  sameSchema: (from, to) => from === to || (from !== "canvas" && to !== "canvas"),
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
  w.create(LIVE, "system", { kind: "document", name: "Ch1", parent: arc, node: "ch1" });
  w.create(LIVE, "system", {
    kind: "document",
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
const record = (over: Record<string, unknown> = {}): TreeRecord => {
  const base = { id: rid(), actor: ME, draft: null };
  const shape: Record<string, Record<string, unknown>> = {
    rename: { type: "rename", node: "ch1", name: "Renamed", fromName: "Ch1" },
    create: {
      type: "create",
      node: rid(),
      kind: "document",
      name: "New",
      parent: "arc",
      source: "manuscript",
      rank: "a5",
    },
    move: {
      type: "move",
      node: "ch1",
      parent: ROOT,
      rank: "a5",
      from: { parent: "arc", rank: "a0" },
    },
    delete: { type: "delete", node: "ch1", cascade: [] },
    restore: { type: "restore", node: "ch1" },
  };
  return {
    ...base,
    ...(shape[(over.type as string) ?? "rename"] ?? { type: over.type, node: "ch1" }),
    ...over,
  } as unknown as TreeRecord;
};
const push =
  (...ops: unknown[]) =>
  (copy: Y.Doc) =>
    copy.getArray("ops").push(ops);

function refusedWhole(change: (copy: Y.Doc) => void, clientID?: number) {
  const doc = server();
  const before = Y.encodeStateAsUpdate(doc);
  const { update } = client(doc, change, clientID);
  const verdict = admit(doc, update, connection);
  expect(verdict.ok, JSON.stringify(verdict)).toBe(false);
  // Nothing was stored: the server's copy is byte for byte what it was.
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  return verdict.ok ? "" : verdict.reason;
}

describe("an update the server refuses whole, storing nothing", () => {
  it("a deletion from the list", () => {
    expect(refusedWhole((copy) => copy.getArray("ops").delete(2, 1))).toBe("a deletion");
  });
  it("a write to the settlements, which only the server appends", () => {
    expect(
      refusedWhole((copy) =>
        copy.getArray("settle").push([{ id: "s", actor: ME, targets: ["x"], to: "applied" }]),
      ),
    ).toBe("not the list");
  });
  it("a new shared type, a map entry, a nested type, text in the list", () => {
    expect(refusedWhole((copy) => copy.getMap("extra").set("k", 1))).toBe("a map entry");
    expect(refusedWhole((copy) => copy.getArray("other").push([record({})]))).toBe("not the list");
    expect(refusedWhole((copy) => copy.getArray("ops").push([new Y.Map() as unknown]))).toBe(
      "not plain records",
    );
    expect(refusedWhole((copy) => copy.getText("ops2").insert(0, "hello"))).toBe("not the list");
  });
  it("a client id the server keeps for itself", () => {
    expect(refusedWhole(push(record({})), 12)).toBe("a reserved client id");
  });
  it("a record under another actor: another person, an agent, the system", () => {
    for (const actor of ["user:someone-else", "agent:c1/t1", "system", undefined])
      expect(refusedWhole(push(record({ actor })))).toBe("a record that is actor");
  });
  it("a record with a field only the server writes", () => {
    for (const extra of [
      { appliedFrom: "x" },
      { appliedBy: ME },
      { fromDraft: "my-work" },
      { replaces: "x" },
      { blob: { storageKey: "k", mime: "x", size: 1 } },
      { at: "2026" },
    ])
      expect(refusedWhole(push(record(extra)))).toBe(
        `a record that is field ${Object.keys(extra)[0]}`,
      );
  });
  it("a malformed record, each for its own reason", () => {
    const bad: Array<[unknown, string]> = [
      ["a string", "not a record"],
      [[record()], "not a record"],
      [record({ type: "purge" }), "unknown type"],
      [record({ type: "settle" }), "unknown type"],
      [record({ type: "create", kind: "file", name: "x.png" }), "kind"],
      [record({ name: "" }), "rename"],
      [record({ name: "x".repeat(300) }), "rename"],
      [record({ type: "create", node: "source:x" }), "id"],
      [record({ node: { evil: true } }), "id"],
      [record({ type: "move", rank: "not a rank!" }), "move"],
      [record({ type: "move", from: { parent: "arc", rank: "a0", extra: 1 } }), "from"],
      [record({ type: "delete", cascade: "ch1" }), "cascade"],
      [record({ type: "delete", cascade: [1, 2] }), "cascade"],
      [record({ draft: 7 }), "draft"],
      [record({ id: "" }), "id"],
      [record({ type: "create", fromName: "x" }), "field fromName"],
      [record({ undoes: { a: 1 } }), "undoes"],
    ];
    for (const [op, why] of bad)
      expect(refusedWhole(push(op)), JSON.stringify(op).slice(0, 70)).toBe(
        `a record that is ${why}`,
      );
  });
  it("one bad record among good ones: none is stored", () => {
    expect(
      refusedWhole(push(record(), record({ actor: "system" }), record({ name: "Also fine" }))),
    ).toBe("a record that is actor");
  });
  it("the same record id twice, and more records than one update may hold", () => {
    const twice = record({});
    expect(refusedWhole(push(twice, { ...twice }))).toBe("a record id twice");
    expect(refusedWhole(push(...Array.from({ length: 2001 }, () => record({}))))).toBe(
      "too many records",
    );
  });
  it("an update that depends on something the server never got", () => {
    const doc = server();
    const before = Y.encodeStateAsUpdate(doc);
    const { copy } = client(doc, push(record({})));
    const after = Y.encodeStateVector(copy);
    copy.getArray("ops").push([record({ name: "Second" })]);
    const second = Y.encodeStateAsUpdate(copy, after);
    expect(admit(doc, second, connection)).toMatchObject({ ok: false });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
  it("bytes that are not an update, and 2,000 valid updates with bytes changed at random: never throws, and what is admitted only ever appends records", () => {
    const doc = server();
    expect(admit(doc, new Uint8Array([1, 2, 3, 250, 9]), connection)).toMatchObject({ ok: false });
    let seed = 99;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let admitted = 0;
    for (let i = 0; i < 2000; i += 1) {
      const { update } = client(doc, push(record({ name: `N${i}` })), 6000 + i);
      const bytes = new Uint8Array(update);
      for (let flips = 0; flips < 1 + Math.floor(random() * 3); flips += 1)
        bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      const length = recordsOf(doc).length;
      const settle = doc.getArray("settle").length;
      const verdict = admit(doc, bytes, connection);
      if (!verdict.ok) {
        expect(recordsOf(doc).length).toBe(length);
        continue;
      }
      admitted += 1;
      expect(recordsOf(doc).length).toBe(length + verdict.records.length);
      expect(doc.getArray("settle").length).toBeGreaterThanOrEqual(settle);
      expect(Y.snapshot(doc).ds.clients.size).toBe(0);
      for (const op of recordsOf(doc).toArray().slice(length)) expect(op.actor).toBe(ME);
    }
    expect(Y.snapshot(doc).ds.clients.size).toBe(0);
    expect(doc.share.size).toBeLessThanOrEqual(2);
    console.info(
      `admission fuzz: 2000 damaged updates, ${admitted} still well formed and admitted, the rest refused whole`,
    );
  });
});

describe("an update the server admits", () => {
  it("records appended at the end, and records from a client that was offline, landing in the middle", () => {
    const doc = server();
    const offline = client(doc, push(record({ name: "From offline" })), 5001);
    const online = client(doc, push(record({ type: "create", node: "ch2", name: "Ch2" })));
    expect(admit(doc, online.update, connection)).toMatchObject({
      ok: true,
      refused: [],
      kept: [],
    });
    expect(admit(doc, offline.update, connection)).toMatchObject({ ok: true, refused: [] });
    const live = replayView(doc, LIVE);
    expect(live.nodes.get("ch1")?.displayName).toBe("From offline");
    expect(live.nodes.get("ch2")?.parent).toBe("arc");
    // The client that was offline, given the server's state, holds the same list and tree.
    Y.applyUpdate(offline.copy, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(offline.copy)));
    expect(fingerprint(replayView(offline.copy, LIVE))).toBe(fingerprint(live));
  });

  it("a record this account may not make now is stored and marked refused, and no view replays it", () => {
    const doc = server();
    const before = fingerprint(replayView(doc, LIVE));
    const { copy, update } = client(
      doc,
      push(
        record({ id: "not-my-work", draft: "someone-elses-work" }),
        record({ id: "read-only", node: "guide", name: "Defaced", fromName: "Guide" }),
        record({ id: "into-read-only", type: "move", parent: source("skills") }),
        record({ id: "takes-read-only", type: "delete", node: "arc", cascade: ["ch1", "guide"] }),
        record({
          id: "new-source",
          type: "create",
          node: "mine",
          kind: "folder",
          name: "mine",
          parent: source("skills"),
          source: "skills",
        }),
        record({ id: "fine", name: "Chapter One" }),
      ),
    );
    // The client's own copy shows all of it until the server answers.
    expect(replayView(copy, LIVE).nodes.get("guide")?.displayName).toBe("Defaced");
    const verdict = admit(doc, update, connection);
    expect(verdict).toMatchObject({ ok: true });
    expect(verdict.ok && verdict.refused.map((r) => r.id)).toEqual([
      "not-my-work",
      "read-only",
      "into-read-only",
      "takes-read-only",
      "new-source",
    ]);
    // A create is never left without a place: it is kept in Unfiled by a create of the server's.
    expect(verdict.ok && verdict.kept.map((r) => r.create)).toEqual(["new-source"]);
    const live = replayView(doc, LIVE);
    expect(live.nodes.get("ch1")).toMatchObject({
      displayName: "Chapter One",
      parent: "arc",
      trashed: false,
    });
    expect(live.nodes.get("guide")?.displayName).toBe("Guide");
    expect(live.nodes.get("mine")).toMatchObject({
      parent: source("unfiled"),
      source: "unfiled",
      kind: "folder",
    });
    expect(replayView(doc, { draft: "someone-elses-work" }).nodes.get("ch1")?.displayName).toBe(
      "Chapter One",
    );
    // Only the allowed record and the kept folder changed anything.
    expect(fingerprint(live).replace(/\nsource:unfiled\n[^\n]*#mine@[^\n]*/, "")).toBe(
      before.replace("d:Ch1#ch1", "d:Chapter One#ch1"),
    );
    // The client takes the server's verdicts and shows what the server shows, with the reason.
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(copy)));
    expect(fingerprint(replayView(copy, LIVE))).toBe(fingerprint(live));
    const reasons = copy
      .getArray<{ to: string; reason?: string; targets: string[] }>("settle")
      .toArray();
    expect(reasons.every((r) => r.to === "refused" && r.reason)).toBe(true);
    expect(reasons.flatMap((r) => r.targets).sort()).toEqual([
      "into-read-only",
      "new-source",
      "not-my-work",
      "read-only",
      "takes-read-only",
    ]);
  });

  it("an update that two tabs of one browser both forward is admitted once, and the second copy changes nothing", () => {
    const doc = server();
    const { update } = client(doc, push(record({ id: "twice", name: "Once" })));
    expect(admit(doc, update, connection)).toMatchObject({ ok: true });
    const stored = Y.encodeStateAsUpdate(doc);
    expect(admit(doc, update, connection)).toMatchObject({ ok: true, records: [] });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(stored);
  });

  it("a rank as long as 400 moves to one spot make it is still a rank", () => {
    const doc = server();
    const { update } = client(doc, push(record({ type: "move", rank: `a${"V".repeat(400)}` })));
    expect(admit(doc, update, connection)).toMatchObject({ ok: true, refused: [] });
  });

  it("a drafted create into a folder drafted in an earlier update is judged in its Work's view and admitted", () => {
    const doc = server();
    const first = client(
      doc,
      push(
        record({
          id: "f",
          type: "create",
          node: "drafted-folder",
          kind: "folder",
          name: "Scenes",
          draft: "my-work",
        }),
      ),
    );
    expect(admit(doc, first.update, connection)).toMatchObject({ ok: true, refused: [], kept: [] });
    const second = client(
      doc,
      push(
        record({
          id: "c",
          type: "create",
          node: "drafted-scene",
          name: "Scene 1",
          parent: "drafted-folder",
          draft: "my-work",
        }),
      ),
      5001,
    );
    expect(admit(doc, second.update, connection)).toMatchObject({
      ok: true,
      refused: [],
      kept: [],
    });
    expect(replayView(doc, { draft: "my-work" }).nodes.get("drafted-scene")).toMatchObject({
      parent: "drafted-folder",
      source: "manuscript",
    });
  });

  it("a new document made where the account can no longer write is kept, live, in its own folder, with what is inside it", () => {
    const doc = server();
    const { copy, update } = client(
      doc,
      push(
        record({
          id: "folder",
          type: "create",
          node: "new-folder",
          kind: "folder",
          name: "Drafted arc",
          draft: "a-closed-work",
        }),
        record({
          id: "chapter",
          type: "create",
          node: "new-chapter",
          name: "Chapter 50",
          parent: "new-folder",
          draft: "a-closed-work",
        }),
        record({
          id: "named",
          node: "new-chapter",
          name: "The Fall",
          fromName: "Chapter 50",
          draft: "a-closed-work",
        }),
        record({
          id: "elsewhere",
          type: "create",
          node: "in-skills",
          name: "Note",
          parent: "skills",
        }),
      ),
    );
    const verdict = admit(doc, update, connection);
    expect(verdict.ok && verdict.kept.map((r) => r.create)).toEqual([
      "folder",
      "chapter",
      "elsewhere",
    ]);
    expect(verdict.ok && verdict.refused.map((r) => r.id)).toEqual([
      "folder",
      "chapter",
      "named",
      "elsewhere",
    ]);
    const live = replayView(doc, LIVE);
    // The folder goes under the folder it was made in, which is live and writable; the chapter
    // under the folder kept before it, and with the name it last had in the update.
    expect(live.nodes.get("new-folder")).toMatchObject({
      parent: "arc",
      displayName: "Drafted arc",
    });
    expect(live.nodes.get("new-chapter")).toMatchObject({
      parent: "new-folder",
      displayName: "The Fall",
      trashed: false,
    });
    expect(live.nodes.get("in-skills")).toMatchObject({ parent: source("unfiled") });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(copy)));
    expect(fingerprint(replayView(copy, LIVE))).toBe(fingerprint(live));
  });
});

describe("a record is judged against the list it joins", () => {
  /** Alice's records, admitted; then a hostile client that has seen them. */
  function withAlice() {
    const doc = server();
    const alice: Connection = { ...connection, user: "user:alice" };
    const aliceRecord = (over: Record<string, unknown>) => ({
      ...record(over),
      actor: "user:alice",
    });
    const del = aliceRecord({ id: "alice-delete", type: "delete", node: "ch1", cascade: [] });
    const ren = aliceRecord({ id: "alice-rename", node: "arc", name: "Arc One", fromName: "Arc" });
    expect(admit(doc, client(doc, push(del, ren), 5100).update, alice)).toMatchObject({ ok: true });
    return doc;
  }
  const state = (doc: Y.Doc) => fingerprint(replayView(doc, LIVE));

  it("a record reusing the id of someone's delete, aimed at a Work that is not theirs, cannot cancel it", () => {
    const doc = withAlice();
    const before = state(doc);
    const { update } = client(
      doc,
      push(record({ id: "alice-delete", draft: "someone-elses-work" })),
    );
    expect(admit(doc, update, connection)).toEqual({
      ok: false,
      reason: "a record id already in the list",
    });
    expect(state(doc)).toBe(before);
    expect(replayView(doc, LIVE).nodes.get("ch1")?.trashed).toBe(true);
  });

  it("a record reusing an id, placed before the original in the list, cannot replace it", () => {
    const doc = withAlice();
    const before = state(doc);
    // A copy from before Alice's records, so the forged item sorts ahead of hers.
    const early = new Y.Doc({ gc: false });
    early.clientID = 1001;
    Y.applyUpdate(early, Y.encodeStateAsUpdate(server()));
    const mark = Y.encodeStateVector(early);
    early
      .getArray("ops")
      .push([record({ id: "alice-rename", node: "guide", name: "Mine now", fromName: "Guide" })]);
    Y.applyUpdate(early, Y.encodeStateAsUpdate(doc));
    const verdict = admit(doc, Y.encodeStateAsUpdate(early, mark), connection);
    expect(verdict.ok).toBe(false);
    expect(state(doc)).toBe(before);
  });

  it("a create naming a node that exists cannot redefine it, in the list or in any other project's rows", () => {
    const doc = withAlice();
    const before = state(doc);
    const again = client(
      doc,
      push(record({ type: "create", node: "ch1", kind: "folder", name: "Hijacked" })),
    );
    expect(admit(doc, again.update, connection)).toEqual({
      ok: false,
      reason: "a node id already in use",
    });
    const foreign = client(
      doc,
      push(record({ type: "create", node: "another-projects-document", name: "Taken" })),
    );
    expect(
      admit(doc, foreign.update, {
        ...connection,
        takenElsewhere: (id) => id === "another-projects-document",
      }),
    ).toEqual({ ok: false, reason: "a node id already in use" });
    expect(state(doc)).toBe(before);
  });

  it("a source cannot be renamed or deleted, and a document is not a place", () => {
    const doc = withAlice();
    const before = state(doc);
    const { update } = client(
      doc,
      push(
        record({ id: "delete-source", type: "delete", node: source("manuscript"), cascade: [] }),
        record({ id: "rename-source", node: source("kb"), name: "mine", fromName: "kb" }),
        record({ id: "into-document", type: "move", node: "arc", parent: "guide" }),
        record({ id: "under-document", type: "create", node: "odd", name: "Odd", parent: "ch1" }),
      ),
    );
    const verdict = admit(doc, update, connection);
    expect(verdict.ok && verdict.refused.map((r) => r.id)).toEqual([
      "delete-source",
      "rename-source",
      "into-document",
      "under-document",
    ]);
    expect(verdict.ok && verdict.kept.map((r) => r.create)).toEqual(["under-document"]);
    const live = replayView(doc, LIVE);
    expect(live.nodes.get("odd")?.parent).toBe(source("unfiled"));
    expect(state(doc).replace(/\nsource:unfiled\n[^\n]*#odd@[^\n]*/, "")).toBe(before);
    expect(live.rescued).toEqual([]);
  });

  it("a client's create or rename may state only an editable type, and a rename may not cross schemas", () => {
    const doc = server();
    refusedWhole(push(record({ type: "create", filetype: "pdf" })));
    refusedWhole(push(record({ filetype: "pdf" })));
    refusedWhole(push(record({ type: "create", aliases: ["x"] })));
    refusedWhole(push(record({ type: "create", kind: "folder", filetype: "markdown" })));
    // Ch1 has no type in this list; a type change on it, or one from a canvas, is marked.
    const bad = record({ id: "to-text", filetype: "text" });
    const ok = record({
      type: "create",
      node: "typed",
      filetype: "markdown",
      provisional: true,
    });
    const drawn = record({ type: "create", node: "drawn", filetype: "canvas" });
    const toText = record({ id: "drawn-to-text", node: "drawn", filetype: "text" });
    const retyped = record({ id: "typed-to-text", node: "typed", filetype: "text" });
    const { update } = client(doc, push(ok, bad, drawn, toText, retyped));
    const verdict = admit(doc, update, connection);
    expect(verdict.ok && verdict.refused).toEqual([
      { id: "to-text", reason: "a type across schemas" },
      { id: "drawn-to-text", reason: "a type across schemas" },
    ]);
    expect(replayView(doc, LIVE).nodes.get("typed")).toMatchObject({
      filetype: "text",
      provisional: false,
    });
  });

  it("a create kept in Unfiled keeps its type, and a later rename by the person ends its provisional name", () => {
    const doc = server();
    const make = record({
      id: "made",
      type: "create",
      node: "late",
      parent: source("skills"),
      source: "skills",
      filetype: "markdown",
      provisional: true,
    });
    const named = record({ id: "named", node: "late", name: "Chapter 9", filetype: "text" });
    const { update } = client(doc, push(make, named));
    const verdict = admit(doc, update, connection);
    expect(verdict.ok && verdict.kept.map((k) => k.create)).toEqual(["made"]);
    expect(replayView(doc, LIVE).nodes.get("late")).toMatchObject({
      name: "Chapter 9",
      filetype: "text",
      provisional: false,
      parent: source("unfiled"),
    });
  });
});

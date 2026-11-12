/** Proof code. The admission check against updates an honest client never sends. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { admit, checkUpdate, type Connection } from "./admission.js";
import { fingerprint, LIVE, materialize, opsOf, ROOT, type TreeOp, TreeWriter } from "./tree-log.js";

const ME = "user:me";
const connection: Connection = {
  user: ME,
  drafts: new Set(["my-work"]),
  writableSources: new Set(["manuscript", "kb"]),
};

/** The server's list: two sources the account may write, one it may not, some nodes. */
function server() {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 7;
  const w = new TreeWriter(doc);
  for (const source of ["manuscript", "kb", "skills"])
    w.author(LIVE, "system", { type: "create", node: source, kind: "folder", name: source, parent: ROOT, rank: "a0" });
  const arc = w.create(LIVE, "system", { kind: "folder", name: "Arc", parent: "manuscript", node: "arc" }).node;
  w.create(LIVE, "system", { kind: "document", name: "Ch1", parent: arc, node: "ch1" });
  w.create(LIVE, "system", { kind: "document", name: "Guide", parent: "skills", node: "guide" });
  return doc;
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
const record = (over: Record<string, unknown> = {}): TreeOp => {
  const base = { id: rid(), actor: ME, draft: null };
  const shape: Record<string, Record<string, unknown>> = {
    rename: { type: "rename", node: "ch1", name: "Renamed", fromName: "Ch1" },
    create: { type: "create", node: rid(), kind: "document", name: "New", parent: "arc", rank: "a5" },
    move: { type: "move", node: "ch1", parent: "manuscript", rank: "a5", from: { parent: "arc", rank: "a0" } },
    delete: { type: "delete", node: "ch1", cascade: [] },
    restore: { type: "restore", node: "ch1" },
  };
  return { ...base, ...(shape[(over.type as string) ?? "rename"] ?? { type: over.type, node: "ch1" }), ...over } as unknown as TreeOp;
};
const push = (...ops: unknown[]) => (copy: Y.Doc) => copy.getArray("ops").push(ops);

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
    expect(refusedWhole((copy) => copy.getArray("ops").delete(4, 1))).toBe("a deletion");
  });
  it("a write to the settlements, which only the server appends", () => {
    expect(
      refusedWhole((copy) => copy.getArray("settle").push([{ id: "s", actor: ME, targets: ["x"], to: "applied" }])),
    ).toBe("not the list");
  });
  it("a new shared type, a map entry, a nested type, text in the list", () => {
    expect(refusedWhole((copy) => copy.getMap("extra").set("k", 1))).toBe("a map entry");
    expect(refusedWhole((copy) => copy.getArray("other").push([record({})]))).toBe("not the list");
    expect(refusedWhole((copy) => copy.getArray("ops").push([new Y.Map() as unknown]))).toBe("not plain records");
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
    for (const extra of [{ appliedFrom: "x" }, { appliedBy: ME }, { fromDraft: "my-work" }, { arrival: 1 }, { blob: { storageKey: "k", mime: "x", size: 1 } }, { at: "2026" }])
      expect(refusedWhole(push(record(extra)))).toBe(`a record that is field ${Object.keys(extra)[0]}`);
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
      [record({ node: ROOT }), "root"],
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
      expect(refusedWhole(push(op)), JSON.stringify(op).slice(0, 70)).toBe(`a record that is ${why}`);
  });
  it("one bad record among good ones: none is stored", () => {
    expect(refusedWhole(push(record(), record({ actor: "system" }), record({ name: "Also fine" })))).toBe("a record that is actor");
  });
  it("the same record id twice, and more records than one update may hold", () => {
    const twice = record({});
    expect(refusedWhole(push(twice, { ...twice }))).toBe("a record id twice");
    expect(refusedWhole(push(...Array.from({ length: 2001 }, () => record({}))))).toBe("too many records");
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
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
    let admitted = 0;
    for (let i = 0; i < 2000; i += 1) {
      const { update } = client(doc, push(record({ name: `N${i}` })), 6000 + i);
      const bytes = new Uint8Array(update);
      for (let flips = 0; flips < 1 + Math.floor(random() * 3); flips += 1)
        bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      const length = opsOf(doc).length;
      const settle = doc.getArray("settle").length;
      const verdict = admit(doc, bytes, connection);
      if (!verdict.ok) {
        expect(opsOf(doc).length).toBe(length);
        continue;
      }
      admitted += 1;
      expect(opsOf(doc).length).toBe(length + verdict.records.length);
      expect(doc.getArray("settle").length).toBeGreaterThanOrEqual(settle);
      expect(Y.snapshot(doc).ds.clients.size).toBe(0);
      for (const op of opsOf(doc).toArray().slice(length)) expect(op.actor).toBe(ME);
    }
    expect(Y.snapshot(doc).ds.clients.size).toBe(0);
    expect(doc.share.size).toBeLessThanOrEqual(2);
    console.info(`admission fuzz: 2000 damaged updates, ${admitted} still well formed and admitted, the rest refused whole`);
  });
});

describe("an update the server admits", () => {
  it("records appended at the end, and records from a client that was offline, landing in the middle", () => {
    const doc = server();
    const offline = client(doc, push(record({ name: "From offline" })), 5001);
    const online = client(doc, push(record({ type: "create", node: "ch2", name: "Ch2" })));
    expect(admit(doc, online.update, connection)).toEqual({ ok: true, refused: [], records: expect.anything() });
    expect(admit(doc, offline.update, connection)).toMatchObject({ ok: true, refused: [] });
    const live = materialize(doc, LIVE);
    expect(live.nodes.get("ch1")?.displayName).toBe("From offline");
    expect(live.nodes.get("ch2")?.parent).toBe("arc");
    // The client that was offline, given the server's state, holds the same list and tree.
    Y.applyUpdate(offline.copy, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(offline.copy)));
    expect(fingerprint(materialize(offline.copy, LIVE))).toBe(fingerprint(live));
  });

  it("a record this account may not make now is stored and marked refused, and no view replays it", () => {
    const doc = server();
    const before = fingerprint(materialize(doc, LIVE));
    const { copy, update } = client(
      doc,
      push(
        record({ id: "not-my-work", draft: "someone-elses-work" }),
        record({ id: "read-only", node: "guide", name: "Defaced", fromName: "Guide" }),
        record({ id: "into-read-only", type: "move", parent: "skills" }),
        record({ id: "takes-read-only", type: "delete", node: "arc", cascade: ["ch1", "guide"] }),
        record({ id: "new-source", type: "create", node: "mine", kind: "folder", name: "mine", parent: ROOT }),
        record({ id: "fine", name: "Chapter One" }),
      ),
    );
    // The client's own copy shows all of it until the server answers.
    expect(materialize(copy, LIVE).nodes.get("guide")?.displayName).toBe("Defaced");
    const verdict = admit(doc, update, connection);
    expect(verdict).toMatchObject({ ok: true });
    expect(verdict.ok && verdict.refused.map((r) => r.id)).toEqual([
      "not-my-work",
      "read-only",
      "into-read-only",
      "takes-read-only",
      "new-source",
    ]);
    const live = materialize(doc, LIVE);
    expect(live.nodes.get("ch1")).toMatchObject({ displayName: "Chapter One", parent: "arc", trashed: false });
    expect(live.nodes.get("guide")?.displayName).toBe("Guide");
    expect(live.nodes.has("mine")).toBe(false);
    expect(materialize(doc, { draft: "someone-elses-work" }).nodes.get("ch1")?.displayName).toBe("Chapter One");
    // Only the allowed record changed anything.
    expect(fingerprint(live)).toBe(before.replace("d:Ch1#ch1", "d:Chapter One#ch1"));
    // The client takes the server's verdicts and shows what the server shows, with the reason.
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(copy)));
    expect(fingerprint(materialize(copy, LIVE))).toBe(fingerprint(live));
    const reasons = copy.getArray<{ to: string; reason?: string; targets: string[] }>("settle").toArray();
    expect(reasons.every((r) => r.to === "refused" && r.reason)).toBe(true);
    expect(reasons.flatMap((r) => r.targets).sort()).toEqual(["into-read-only", "new-source", "not-my-work", "read-only", "takes-read-only"]);
  });

  it("a record sent again under a new client id, after a client rebuilt its copy, counts once", () => {
    const doc = server();
    const move = record({ id: "once", type: "move" });
    expect(admit(doc, client(doc, push(move)).update, connection)).toMatchObject({ ok: true });
    const length = materialize(doc, LIVE).nodes.size;
    admit(doc, client(doc, push(record({ name: "Later" }))).update, connection);
    expect(admit(doc, client(doc, push({ ...move }), 5002).update, connection)).toMatchObject({ ok: true });
    const live = materialize(doc, LIVE);
    expect(live.nodes.size).toBe(length);
    expect(live.nodes.get("ch1")).toMatchObject({ parent: "manuscript", displayName: "Later" });
  });
});

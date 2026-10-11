// Exact-content cold-replica matrix for durable forward inverses (POC 1 and 2 contracts).
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  admitInverseReceipt,
  captureEditFrontier,
  captureEditParts,
  classifyEditParts,
  computeInverse,
  type InversePart,
} from "./forward-inverse.js";

type View = { doc: Y.Doc; history: InversePart[]; nextClient: number };
function paragraph(body: string): Y.XmlElement {
  const p = new Y.XmlElement("paragraph"),
    t = new Y.XmlText();
  t.insert(0, body);
  p.insert(0, [t]);
  return p;
}
function base(lines: string[]): View {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2000;
  doc.getXmlFragment("prosemirror").insert(0, lines.map(paragraph));
  return { doc, history: [], nextClient: 10000 };
}
function cold(v: View): void {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(v.doc));
  v.doc.destroy();
  v.doc = doc;
}
const ps = (v: View) => v.doc.getXmlFragment("prosemirror").toArray() as Y.XmlElement[];
const text = (v: View, i = 0) => ps(v)[i].get(0) as Y.XmlText;
const content = (v: View) =>
  ps(v).map((p) =>
    (p.get(0) as Y.XmlText)
      .toDelta()
      .map((x: { insert: unknown }) => (typeof x.insert === "string" ? x.insert : ""))
      .join(""),
  );
const xml = (v: View) => v.doc.getXmlFragment("prosemirror").toString();
function swap(v: View, from: string, to: string, i = 0): void {
  const t = text(v, i),
    at = content(v)[i].indexOf(from);
  if (at < 0) throw new Error(`Missing ${from}`);
  t.delete(at, from.length);
  t.insert(at, to);
}
function write(v: View, fns: ((v: View) => void)[]): InversePart[] {
  const receipts = fns.map((fn) => {
    const frontier = captureEditFrontier(v.doc),
      updates: Uint8Array[] = [],
      collect = (u: Uint8Array) => updates.push(u);
    v.doc.clientID = v.nextClient++;
    v.doc.on("update", collect);
    try {
      v.doc.transact(() => fn(v));
    } finally {
      v.doc.off("update", collect);
    }
    return { frontier, update: Y.mergeUpdates(updates) };
  });
  const id = (v.history.at(-1)?.id ?? 0) + 1,
    parts = captureEditParts(v.doc, receipts).map((p, ordinal) => ({
      ...p,
      id: id + ordinal,
      editId: `e${id}`,
      ordinal,
      kind: "write" as const,
      targets: [],
    }));
  v.history.push(...parts);
  return parts;
}
function inverse(v: View, parts: InversePart[], direction: "invert" | "reapply"): number {
  cold(v);
  const result = computeInverse(
    v.doc,
    v.history,
    parts.map((part) => ({ part, direction })),
    { actionId: `a${v.history.length}`, allocateClient: () => v.nextClient++ },
  );
  for (const edit of result.edits) {
    const editId = `e${(v.history.at(-1)?.id ?? 0) + 1}`;
    for (const [ordinal, p] of edit.parts.entries()) {
      Y.applyUpdate(v.doc, p.update);
      v.history.push({
        ...p,
        id: (v.history.at(-1)?.id ?? 0) + 1,
        editId,
        ordinal,
        kind: direction === "invert" ? "undo" : "redo",
        actionId: result.actionId,
      });
    }
  }
  return result.edits.reduce((n, edit) => n + edit.parts.length, 0);
}
const states = (v: View, parts: InversePart[]) =>
  classifyEditParts(v.doc, v.history, parts).map((p) => p.state);

describe("forward inverse on cold Yjs replicas", () => {
  it.each([
    ["insert", "", (v: View) => text(v).insert(0, "Added once."), "Added once."],
    ["delete", "Alpha Beta.", (v: View) => text(v).delete(6, 4), "Alpha ."],
    ["replace", "Alpha Beta.", (v: View) => swap(v, "Alpha Beta.", "Alpha Gamma."), "Alpha Gamma."],
  ] as const)("%s cycles, idempotence and Apply replay", (_label, original, fn, edited) => {
    const v = base([original]),
      seed = Y.encodeStateAsUpdate(v.doc),
      parts = write(v, [fn]);
    expect(content(v)).toEqual([edited]);
    for (const direction of ["invert", "reapply", "invert", "reapply"] as const) {
      expect(inverse(v, parts, direction)).toBe(1);
      expect(content(v)).toEqual([direction === "invert" ? original : edited]);
      expect(states(v, parts)).toEqual([direction === "invert" ? "undone" : "active"]);
      expect(inverse(v, parts, direction)).toBe(0);
      expect(content(v)).toEqual([direction === "invert" ? original : edited]);
    }
    const live = new Y.Doc({ gc: false });
    Y.applyUpdate(live, seed);
    for (const part of v.history) Y.applyUpdate(live, part.update);
    expect(content({ doc: live, history: v.history, nextClient: v.nextClient })).toEqual([edited]);
    live.destroy();
    v.doc.destroy();
  });
  it.each([
    ["overlapping single-part edits", 1],
    ["two-part target plus overlap", 2],
    ["count three", 3],
  ] as const)("grouped action: %s retains per-edit ownership", (_label, count) => {
    const v = base(count === 2 ? ["red", "blue"] : [count === 3 ? "black" : "red"]);
    const seed = Y.encodeStateAsUpdate(v.doc);
    const edits: InversePart[][] = [];
    if (count === 3) edits.push(write(v, [(v) => swap(v, "black", "red")]));
    edits.push(
      write(
        v,
        count === 2
          ? [(v) => swap(v, "red", "gold"), (v) => swap(v, "blue", "green", 1)]
          : [(v) => swap(v, "red", "gold")],
      ),
    );
    edits.push(write(v, [(v) => swap(v, "gold", "silver")]));
    const expected = count === 2 ? ["silver", "green"] : ["silver"];
    for (let cycle = 0; cycle < 2; cycle++) {
      const start = v.history.length;
      inverse(v, edits.slice().reverse().flat(), "invert");
      expect(content(v)).toEqual(count === 2 ? ["red", "blue"] : [count === 3 ? "black" : "red"]);
      const generated = v.history.slice(start);
      expect([...new Set(generated.map((p) => p.actionId))]).toEqual([`a${start}`]);
      expect(new Set(generated.map((p) => p.editId)).size).toBe(edits.length);
      for (const id of new Set(generated.map((p) => p.editId))) {
        const group = generated.filter((p) => p.editId === id);
        expect(new Set(group.flatMap((p) => p.targets.map((t) => t.editId))).size).toBe(1);
        const inserted = group.flatMap((p) =>
          p.effect.inserted.flatMap((r) =>
            Array.from({ length: r.len }, (_, n) => `${r.client}:${r.clock + n}`),
          ),
        );
        const deleted = group.flatMap((p) =>
          p.effect.deleted.flatMap((r) =>
            Array.from({ length: r.len }, (_, n) => `${r.client}:${r.clock + n}`),
          ),
        );
        expect(inserted.filter((k) => deleted.includes(k))).toEqual([]);
      }
      inverse(v, edits.flat(), "reapply");
      expect(content(v)).toEqual(expected);
    }
    inverse(v, edits.slice().reverse().flat(), "invert");
    for (const [i, edit] of edits.entries()) {
      inverse(v, edit, "reapply");
      expect(content(v)[0]).toBe(
        i === edits.length - 1 ? "silver" : count === 3 && i === 0 ? "red" : "gold",
      );
    }
    const applied = new Y.Doc({ gc: false });
    Y.applyUpdate(applied, seed);
    for (const p of v.history) Y.applyUpdate(applied, p.update);
    expect(content({ ...v, doc: applied })).toEqual(expected);
    applied.destroy();
    v.doc.destroy();
  });
  it("overlapping replacements and insert-then-edit re-evaluate in stack order", () => {
    for (const inserted of [false, true]) {
      const v = base([inserted ? "Start. " : "red"]);
      const e1 = write(v, [
        (v) => (inserted ? text(v).insert(7, "A red bird.") : swap(v, "red", "gold")),
      ]);
      const e2 = write(v, [
        (v) => swap(v, inserted ? "red" : "gold", inserted ? "gold" : "silver"),
      ]);
      for (const [parts, direction, expected] of [
        [e2, "invert", inserted ? "Start. A red bird." : "gold"],
        [e1, "invert", inserted ? "Start. " : "red"],
        [e1, "reapply", inserted ? "Start. A red bird." : "gold"],
        [e2, "reapply", inserted ? "Start. A gold bird." : "silver"],
      ] as const) {
        expect(inverse(v, [...parts], direction)).toBe(1);
        expect(content(v)).toEqual([expected]);
      }
      v.doc.destroy();
    }
  });
  it.each([
    false,
    true,
  ])("inverse entries themselves invert, preserving deletion ownership (replacement=%s)", (replacement) => {
    const initial = replacement ? "red" : "abcdef",
      edited = replacement ? "gold" : "af";
    const v = base([initial]),
      original = write(v, [(v) => (replacement ? swap(v, "red", "gold") : text(v).delete(1, 4))]);
    inverse(v, original, "invert");
    expect(content(v)).toEqual([initial]);
    const revert = [v.history[v.history.length - 1]];
    revert[0].kind = "revert";
    inverse(v, revert, "invert");
    expect(content(v)).toEqual([edited]);
    expect(states(v, original)).toEqual(["active"]);
    inverse(v, original, "invert");
    expect(content(v)).toEqual([initial]);
    v.history[v.history.length - 1].kind = "rollback";
    expect(states(v, original)).toEqual(["rolled_back"]);
    expect(inverse(v, original, "reapply")).toBe(0);
    expect(content(v)).toEqual([initial]);
    v.doc.destroy();
  });
  it("a restoration in a cold draft does not restore its live replica twice", () => {
    const live = base(["abcdef"]),
      e = write(live, [(v) => text(v).delete(1, 4)]);
    const draft: View = {
      doc: new Y.Doc({ gc: false }),
      history: [...live.history],
      nextClient: live.nextClient,
    };
    Y.applyUpdate(draft.doc, Y.encodeStateAsUpdate(live.doc));
    inverse(draft, e, "invert");
    cold(live);
    cold(draft);
    expect(content(live)).toEqual(["af"]);
    expect(content(draft)).toEqual(["abcdef"]);
    expect(states(live, e)).toEqual(["active"]);
    expect(states(draft, e)).toEqual(["undone"]);
    Y.applyUpdate(draft.doc, Y.encodeStateAsUpdate(live.doc));
    expect(inverse(draft, e, "invert")).toBe(0);
    expect(content(live)).toEqual(["af"]);
    expect(content(draft)).toEqual(["abcdef"]);
    live.doc.destroy();
    draft.doc.destroy();
  });
  it("mixed authored history inverses in one draft, then Apply and live Redo replay exactly", () => {
    const live = base(["red"]),
      e1 = write(live, [(v) => swap(v, "red", "gold")]);
    const draft: View = {
      doc: new Y.Doc({ gc: false }),
      history: [...live.history],
      nextClient: live.nextClient,
    };
    Y.applyUpdate(draft.doc, Y.encodeStateAsUpdate(live.doc));
    const e2 = write(draft, [(v) => swap(v, "gold", "silver")]);
    inverse(draft, [...e2, ...e1], "invert");
    expect(content(live)).toEqual(["gold"]);
    expect(content(draft)).toEqual(["red"]);
    for (const p of draft.history) Y.applyUpdate(live.doc, p.update);
    live.history = [...draft.history];
    live.nextClient = draft.nextClient;
    cold(live);
    expect(content(live)).toEqual(["red"]);
    inverse(live, [...e1, ...e2], "reapply");
    expect(content(live)).toEqual(["silver"]);
    for (const p of live.history) Y.applyUpdate(draft.doc, p.update);
    expect(content(draft)).toEqual(["silver"]);
    live.doc.destroy();
    draft.doc.destroy();
  });
  it("writer deletes original or restored text: neither direction revives it", () => {
    for (const restored of [false, true]) {
      const v = base(["abcdef"]),
        parts = write(v, [(v) => (restored ? text(v).delete(1, 4) : text(v).insert(1, "AI"))]);
      if (restored) inverse(v, parts, "invert");
      write(v, [(v) => text(v).delete(1, restored ? 4 : 2)]);
      const expected = restored ? "af" : "abcdef";
      expect(states(v, parts)).toEqual(["changed"]);
      expect(inverse(v, parts, "invert")).toBe(0);
      expect(inverse(v, parts, "reapply")).toBe(0);
      expect(content(v)).toEqual([expected]);
      v.doc.destroy();
    }
  });
  it("typing into restored content protects the undone direction", () => {
    const v = base(["abcdef"]),
      e = write(v, [(v) => text(v).delete(1, 4)]);
    inverse(v, e, "invert");
    write(v, [(v) => text(v).insert(3, "WRITER")]);
    cold(v);
    expect(states(v, e)).toEqual(["changed"]);
    expect(inverse(v, e, "reapply")).toBe(0);
    expect(content(v)).toEqual(["abcWRITERdef"]);
    v.doc.destroy();
  });
  it("partial parts preserve writer edits and root provenance", () => {
    const v = base(["red", "blue"]),
      parts = write(v, [
        (v) => {
          swap(v, "red", "gold");
          v.doc.getArray("provenance").push([{ edit: 1 }]);
        },
        (v) => swap(v, "blue", "silver", 1),
      ]);
    write(v, [(v) => text(v, 1).insert(2, "X")]);
    expect(states(v, parts)).toEqual(["active", "changed"]);
    expect(inverse(v, parts, "invert")).toBe(1);
    expect(content(v)).toEqual(["red", "siXlver"]);
    expect(v.doc.getArray("provenance").toArray()).toEqual([{ edit: 1 }]);
    inverse(v, parts, "reapply");
    expect(content(v)).toEqual(["gold", "siXlver"]);
    v.doc.destroy();
  });
  it("transients normalize across parts, not just transactions", () => {
    const v = base(["abcdef"]),
      parts = write(v, [
        (v) => text(v).insert(2, "X"),
        (v) => {
          text(v).delete(2, 1);
          text(v).insert(2, "Y");
        },
      ]);
    expect(parts.map((p) => p.effect)).toEqual([
      { inserted: [], deleted: [] },
      { inserted: [{ client: v.nextClient - 1, clock: 0, len: 1 }], deleted: [] },
    ]);
    inverse(v, parts, "invert");
    expect(content(v)).toEqual(["abcdef"]);
    v.doc.destroy();
  });
  it("attributes and rich containers retain complete aliases", () => {
    const v = base(["abcdef"]);
    write(v, [
      (v) => {
        ps(v)[0].setAttribute("align", "left");
        text(v).format(2, 2, { bold: true, link: { href: "old", ref: "identity" } });
      },
    ]);
    const original = xml(v),
      attr = write(v, [(v) => ps(v)[0].setAttribute("align", "right")]);
    inverse(v, attr, "invert");
    expect(xml(v)).toBe(original);
    inverse(v, attr, "reapply");
    expect(ps(v)[0].getAttribute("align")).toBe("right");
    const rich = xml(v),
      remove = write(v, [(v) => v.doc.getXmlFragment("prosemirror").delete(0, 1)]);
    for (const direction of ["invert", "reapply", "invert", "reapply"] as const) {
      expect(inverse(v, remove, direction)).toBe(1);
      expect(xml(v)).toBe(direction === "invert" ? rich : "");
    }
    v.doc.destroy();
  });
  it.each([
    "interior",
    "adjacent",
    "deletion gap",
    "inserted paragraph",
    "full-span",
    "format extension",
  ])("POC 1 protects writer dependency: %s", (scenario) => {
    const v = base(["The red bird sings."]);
    const e = write(v, [
      (v) => {
        if (scenario === "deletion gap") text(v).delete(4, 3);
        else if (scenario === "inserted paragraph")
          v.doc.getXmlFragment("prosemirror").insert(1, [paragraph("gold")]);
        else if (scenario === "full-span") swap(v, "The red bird sings.", "The gold bird sings.");
        else if (scenario === "format extension") text(v).format(4, 3, { bold: true });
        else swap(v, "red", "gold");
      },
    ]);
    write(v, [
      (v) => {
        if (scenario === "inserted paragraph") text(v, 1).insert(2, "WRITER");
        else if (scenario === "format extension") text(v).format(4, 8, { bold: true });
        else
          text(v).insert(
            scenario === "adjacent" ? 8 : scenario === "deletion gap" ? 4 : 6,
            "WRITER",
          );
      },
    ]);
    const expected = {
      interior: "<paragraph>The goWRITERld bird sings.</paragraph>",
      adjacent: "<paragraph>The goldWRITER bird sings.</paragraph>",
      "deletion gap": "<paragraph>The WRITER bird sings.</paragraph>",
      "inserted paragraph":
        "<paragraph>The red bird sings.</paragraph><paragraph>goWRITERld</paragraph>",
      "full-span": "<paragraph>The goWRITERld bird sings.</paragraph>",
      "format extension": "<paragraph>The <bold>red bird</bold> sings.</paragraph>",
    }[scenario];
    cold(v);
    expect(states(v, e)).toEqual(["changed"]);
    expect(inverse(v, e, "invert")).toBe(0);
    expect(xml(v)).toBe(expected);
    expect(inverse(v, e, "reapply")).toBe(0);
    expect(xml(v)).toBe(expected);
    v.doc.destroy();
  });
  it("a word restores inside its independently restored paragraph", () => {
    const v = base(["abcdef"]),
      word = write(v, [(v) => text(v).delete(1, 4)]),
      parent = write(v, [(v) => v.doc.getXmlFragment("prosemirror").delete(0, 1)]);
    expect(states(v, word)).toEqual(["changed"]);
    inverse(v, parent, "invert");
    expect(content(v)).toEqual(["af"]);
    inverse(v, word, "invert");
    expect(content(v)).toEqual(["abcdef"]);
    inverse(v, word, "reapply");
    inverse(v, parent, "reapply");
    expect(xml(v)).toBe("");
    v.doc.destroy();
  });
  it("lists, atoms, hard breaks, links, move and copy use new identities", () => {
    const v = base(["abc", "def"]);
    write(v, [
      (v) => {
        const list = new Y.XmlElement("bullet_list"),
          item = new Y.XmlElement("list_item");
        item.insert(0, [paragraph("linked")]);
        list.insert(0, [item]);
        v.doc.getXmlFragment("prosemirror").insert(2, [list]);
        const nested = item.get(0) as Y.XmlElement,
          tx = nested.get(0) as Y.XmlText;
        tx.format(0, 6, { link: { href: "doc:path", ref: "keep" } });
        const atom = new Y.XmlElement("image");
        atom.setAttribute("src", "asset:image");
        atom.setAttribute("ref", "image-ref");
        ps(v)[0].insert(1, [new Y.XmlElement("hard_break"), atom]);
      },
    ]);
    const original = xml(v);
    const atomParagraph = write(v, [(v) => v.doc.getXmlFragment("prosemirror").delete(0, 1)]);
    inverse(v, atomParagraph, "invert");
    expect(xml(v)).toBe(original);
    inverse(v, atomParagraph, "reapply");
    expect(xml(v)).toBe(
      '<paragraph>def</paragraph><bullet_list><list_item><paragraph><link href="doc:path" ref="keep">linked</link></paragraph></list_item></bullet_list>',
    );
    inverse(v, atomParagraph, "invert");
    expect(xml(v)).toBe(original);
    const root = v.doc.getXmlFragment("prosemirror");
    const remove = write(v, [() => root.delete(2, 1)]);
    inverse(v, remove, "invert");
    expect(xml(v)).toBe(original);
    inverse(v, remove, "reapply");
    expect(xml(v)).toBe(
      '<paragraph>abc<hard_break></hard_break><image ref="image-ref" src="asset:image"></image></paragraph><paragraph>def</paragraph>',
    );
    inverse(v, remove, "invert");
    expect(xml(v)).toBe(original);
    const moved = write(v, [
      (v) => {
        const root = v.doc.getXmlFragment("prosemirror"),
          copy = ps(v)[2].clone();
        root.delete(2, 1);
        root.insert(0, [copy]);
      },
    ]);
    const movedXml = xml(v);
    inverse(v, moved, "invert");
    expect(xml(v)).toBe(original);
    inverse(v, moved, "reapply");
    expect(xml(v)).toBe(movedXml);
    const copied = write(v, [
      (v) => v.doc.getXmlFragment("prosemirror").insert(3, [ps(v)[0].clone()]),
    ]);
    inverse(v, copied, "invert");
    expect(xml(v)).toBe(movedXml);
    inverse(v, copied, "reapply");
    expect(xml(v)).toBe(movedXml + ps(v)[0].toString());
    v.doc.destroy();
  });
  it("frontiers distinguish byte-identical histories, including adjacent typing", () => {
    const a = base(["abc"]),
      b = base(["ab"]);
    const ea = write(a, [(v) => text(v).delete(1, 1)]),
      eb = write(b, [(v) => text(v).delete(1, 1)]);
    const updates: Uint8Array[] = [],
      collect = (u: Uint8Array) => updates.push(u);
    b.doc.on("update", collect);
    b.doc.clientID = 2000;
    text(b).insert(1, "c");
    b.doc.off("update", collect);
    const later = captureEditParts(b.doc, [
      { update: Y.mergeUpdates(updates), frontier: captureEditFrontier(b.doc) },
    ])[0];
    b.history.push({ ...later, id: 2, editId: "writer", ordinal: 0, kind: "write", targets: [] });
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(Y.encodeStateAsUpdate(b.doc));
    expect(ea[0].update).toEqual(eb[0].update);
    expect(states(a, ea)).toEqual(["active"]);
    expect(states(b, eb)).toEqual(["changed"]);
    inverse(a, ea, "invert");
    inverse(b, eb, "invert");
    expect(content(a)).toEqual(["abc"]);
    expect(content(b)).toEqual(["ac"]);
    a.doc.destroy();
    b.doc.destroy();
  });
  it("admission rejects outside deletions, unaliased restorations and state diffs", () => {
    const v = base(["abcdef", "red"]);
    write(v, [(v) => text(v, 1).delete(0, 1)]);
    const target = write(v, [(v) => text(v).delete(1, 4)]),
      pre = Y.encodeStateAsUpdate(v.doc),
      sv = Y.encodeStateVector(v.doc);
    const result = computeInverse(
      v.doc,
      v.history,
      target.map((part) => ({ part, direction: "invert" })),
      { actionId: `a${v.history.length}`, allocateClient: () => v.nextClient++ },
    ).edits[0].parts[0];
    expect(() =>
      captureEditParts(v.doc, [{ update: target[0].update, frontier: undefined as never }]),
    ).toThrow("Missing edit frontier");
    expect(states(v, [{ ...target[0], frontier: undefined as never }])).toEqual(["changed"]);
    expect(() =>
      admitInverseReceipt(v.doc, v.history, target, {
        ...result,
        aliases: [],
        effect: { inserted: [], deleted: [] },
      }),
    ).toThrow("Restored item has no alias");
    expect(() => admitInverseReceipt(v.doc, v.history, target, { ...result, aliases: [] })).toThrow(
      "Restored item has no alias",
    );
    const after = new Y.Doc({ gc: false });
    Y.applyUpdate(after, pre);
    Y.applyUpdate(after, result.update);
    expect(() =>
      admitInverseReceipt(v.doc, v.history, target, {
        ...result,
        update: Y.encodeStateAsUpdate(after, sv),
      }),
    ).toThrow("Inverse deletes outside accepted parts");
    const outside = write(v, [(v) => text(v, 1).delete(0, 1)])[0];
    expect(() => admitInverseReceipt(v.doc, v.history, target, outside)).toThrow(
      "Inverse deletes outside accepted parts",
    );
    after.destroy();
    v.doc.destroy();
  });
  it("two visible restorations of a root fail closed rather than choose a copy", () => {
    const v = base(["abcdef"]),
      target = write(v, [(v) => text(v).delete(1, 4)]);
    const a = computeInverse(
        v.doc,
        v.history,
        target.map((part) => ({ part, direction: "invert" })),
        { actionId: `a${v.history.length}`, allocateClient: () => v.nextClient++ },
      ),
      b = computeInverse(
        v.doc,
        v.history,
        target.map((part) => ({ part, direction: "invert" })),
        { actionId: `a${v.history.length}`, allocateClient: () => v.nextClient++ },
      );
    for (const [i, out] of [...a.edits[0].parts, ...b.edits[0].parts].entries()) {
      if (i === 1)
        expect(() => admitInverseReceipt(v.doc, v.history, target, out)).toThrow(
          "Multiple visible restorations of one root",
        );
      Y.applyUpdate(v.doc, out.update);
      const id = (v.history.at(-1)?.id ?? 0) + 1;
      v.history.push({ ...out, id, editId: `e${id}`, ordinal: 0, kind: "undo" });
    }
    expect(content(v)).toEqual(["abcdebcdef"]);
    expect(states(v, target)).toEqual(["changed"]);
    expect(inverse(v, target, "invert")).toBe(0);
    expect(inverse(v, target, "reapply")).toBe(0);
    expect(content(v)).toEqual(["abcdebcdef"]);
    v.doc.destroy();
  });
  it("long retained history classifies and inverts a 4,000-word chapter", () => {
    const chapter = Array.from({ length: 20 }, (_, p) =>
        Array.from({ length: 200 }, (_, n) => `w${p}_${n}`).join(" "),
      ),
      v = base(chapter);
    for (let n = 0; n < 200; n++) write(v, [(v) => text(v, n % 20).insert(0, "x")]);
    const historical = write(v, [(v) => swap(v, "w1_150", "past", 1)]);
    inverse(v, historical, "invert");
    inverse(v, historical, "reapply");
    expect(v.history.flatMap((p) => p.aliases).reduce((n, a) => n + a.len, 0)).toBe(10);
    expect(content(v)).toEqual(
      chapter.map((p, i) => "x".repeat(10) + (i === 1 ? p.replace("w1_150", "past") : p)),
    );
    const before = content(v),
      parts = write(v, [(v) => swap(v, "w0_150", "AI_150")]);
    const samples: Record<string, number[]> = {
      warmClassification: [],
      coldClassification: [],
      warmInverse: [],
      coldInverse: [],
    };
    for (let n = 0; n < 15; n++) {
      let t = performance.now();
      classifyEditParts(v.doc, v.history, parts);
      samples.warmClassification.push(performance.now() - t);
      t = performance.now();
      computeInverse(
        v.doc,
        v.history,
        parts.map((part) => ({ part, direction: "invert" })),
        { actionId: `a${v.history.length}`, allocateClient: () => v.nextClient++ },
      );
      samples.warmInverse.push(performance.now() - t);
      cold(v);
      t = performance.now();
      classifyEditParts(v.doc, v.history, parts);
      samples.coldClassification.push(performance.now() - t);
      t = performance.now();
      computeInverse(
        v.doc,
        v.history,
        parts.map((part) => ({ part, direction: "invert" })),
        { actionId: `a${v.history.length}`, allocateClient: () => v.nextClient++ },
      );
      samples.coldInverse.push(performance.now() - t);
    }
    console.log(
      "UNDO_PERF_MS",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(samples).map(([label, xs]) => [
            label,
            { min: Math.min(...xs), median: xs.sort((a, b) => a - b)[7], max: Math.max(...xs) },
          ]),
        ),
      ),
    );
    expect(states(v, parts)).toEqual(["active"]);
    expect(inverse(v, parts, "invert")).toBe(1);
    expect(content(v)).toEqual(before);
    inverse(v, parts, "reapply");
    expect(content(v)).toEqual(
      before.map((line, i) => (i === 0 ? line.replace("w0_150", "AI_150") : line)),
    );
    v.doc.destroy();
  });
});

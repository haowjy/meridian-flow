import { writeFileSync } from "node:fs";
import { it } from "vitest";
import * as Y from "yjs";
import * as baseImpl from "../__base/undo/forward-inverse.js";
import * as protoImpl from "./forward-inverse.js";

type Impl = typeof protoImpl;
type Part = protoImpl.InversePart;
type Ch = { ch: string; a: string };
const ROWS = Number(process.env.ROWS ?? 4000);

function harness(impl: Impl) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2000;
  const p = new Y.XmlElement("paragraph"),
    t = new Y.XmlText();
  p.insert(0, [t]);
  doc.getXmlFragment("prosemirror").insert(0, [p]);
  const v = { doc, history: [] as Part[], next: 10000 };
  const text = () =>
    (v.doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const chars = (): Ch[] =>
    (text().toDelta() as { insert: string; attributes?: Record<string, unknown> }[]).flatMap((d) =>
      typeof d.insert === "string"
        ? [...d.insert].map((ch) => ({
            ch,
            a: JSON.stringify(Object.entries(d.attributes ?? {}).sort()),
          }))
        : [],
    );
  const str = () =>
    chars()
      .map((c) => c.ch)
      .join("");
  const raw = (client: number, fn: (t: Y.XmlText) => void) => {
    v.doc.clientID = client;
    v.doc.transact(() => fn(text()));
  };
  const write = (fn: (t: Y.XmlText) => void): Part[] => {
    const frontier = impl.captureEditFrontier(v.doc),
      updates: Uint8Array[] = [],
      collect = (u: Uint8Array) => updates.push(u);
    v.doc.clientID = v.next++;
    v.doc.on("update", collect);
    try {
      v.doc.transact(() => fn(text()));
    } finally {
      v.doc.off("update", collect);
    }
    const id = (v.history.at(-1)?.id ?? 0) + 1;
    const parts = impl
      .captureEditParts(v.doc, [{ frontier, update: Y.mergeUpdates(updates) }])
      .map((part, ordinal) => ({
        ...part,
        id: id + ordinal,
        editId: `e${id}`,
        ordinal,
        kind: "write" as const,
        targets: [],
      }));
    v.history.push(...parts);
    return parts;
  };
  const inverse = (parts: Part[], direction: "invert" | "reapply", keep = false) => {
    const cold = new Y.Doc({ gc: false });
    Y.applyUpdate(cold, Y.encodeStateAsUpdate(v.doc));
    v.doc.destroy();
    v.doc = cold;
    const result = impl.computeInverse(
      v.doc,
      v.history,
      parts.map((part) => ({ part, direction })),
      { actionId: `a${v.history.length}`, allocateClient: () => v.next++, keepLaterWords: keep },
    );
    for (const edit of result.edits) {
      const editId = `e${(v.history.at(-1)?.id ?? 0) + 1}`;
      for (const [ordinal, part] of edit.parts.entries()) {
        Y.applyUpdate(v.doc, part.update);
        v.history.push({
          ...part,
          id: (v.history.at(-1)?.id ?? 0) + 1,
          editId,
          ordinal,
          kind: direction === "invert" ? "undo" : "redo",
          actionId: result.actionId,
        });
      }
    }
    return result.edits.length;
  };
  return { v, text, chars, str, raw, write, inverse };
}

const MARKS = ["none", "bold", "italic", "link", "mixed", "boldspan", "boldall"] as const;
const PAST = ["none", "toggle", "typo-inside", "typo-after", "typo-before"] as const;
const OPS = ["replace", "replace", "replace", "insert", "delete"] as const;
const AI = ["plain", "bold", "inherit"] as const;
const WHERE = ["before", "after", "both", "none"] as const;
const WMARK = ["inherit", "plain", "italic"] as const;
const WRANGE = ["none", "none", "none", "typed", "typed+word"] as const;
const BETWEEN = ["none", "so-before", "x-after"] as const;
const MODE = ["single", "single", "chain"] as const;

interface Row {
  n: number;
  old: string;
  neu: string;
  marks: (typeof MARKS)[number];
  past: (typeof PAST)[number];
  op: (typeof OPS)[number];
  ai: (typeof AI)[number];
  where: (typeof WHERE)[number];
  wmark: (typeof WMARK)[number];
  wrange: (typeof WRANGE)[number];
  between: (typeof BETWEEN)[number];
  mode: (typeof MODE)[number];
}
function rows(): Row[] {
  let seed = 17524;
  const pick = <T>(xs: readonly T[]): T => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return xs[Math.floor((seed / 4294967296) * xs.length)];
  };
  return Array.from({ length: ROWS }, (_, n) => ({
    n,
    old: pick(["small", "tiny", "grey", "ab"]),
    neu: pick(["big", "huge", "x", "enormous"]),
    marks: pick(MARKS),
    past: pick(PAST),
    op: pick(OPS),
    ai: pick(AI),
    where: pick(WHERE),
    wmark: pick(WMARK),
    wrange: pick(WRANGE),
    between: pick(BETWEEN),
    mode: pick(MODE),
  }));
}

interface Outcome {
  error?: string;
  /** label -> pass */
  checks: Record<string, boolean>;
  trace: string[];
}
function run(impl: Impl, r: Row): Outcome {
  const h = harness(impl),
    checks: Record<string, boolean> = {},
    trace: string[] = [];
  const BEFORE = "very ",
    AFTER = "quite";
  try {
    h.raw(2000, (t) => t.insert(0, `One ${r.old} cat.`));
    const at = 4,
      len = r.old.length;
    if (r.marks === "bold") h.raw(2000, (t) => t.format(at, len, { bold: true }));
    if (r.marks === "italic") h.raw(2000, (t) => t.format(at, len, { italic: true }));
    if (r.marks === "link") h.raw(2000, (t) => t.format(at, len, { link: { href: "u" } }));
    if (r.marks === "mixed") {
      h.raw(2000, (t) => t.format(at, 1, { bold: true }));
      h.raw(2000, (t) => t.format(at + 1, len - 1, { italic: true }));
    }
    if (r.marks === "boldspan") h.raw(2000, (t) => t.format(0, at + len, { bold: true }));
    if (r.marks === "boldall") h.raw(2000, (t) => t.format(0, at + len + 5, { bold: true }));
    if (r.past === "toggle") {
      h.raw(2001, (t) => t.format(at + 1, 1, { italic: true }));
      h.raw(2001, (t) => t.format(at + 1, 1, { italic: null }));
    }
    if (r.past === "typo-inside") {
      h.raw(2001, (t) => t.insert(at + 1, "k"));
      h.raw(2001, (t) => t.delete(at + 1, 1));
    }
    if (r.past === "typo-after") {
      h.raw(2001, (t) => t.insert(at + len, "s"));
      h.raw(2001, (t) => t.delete(at + len, 1));
    }
    if (r.past === "typo-before") {
      h.raw(2001, (t) => t.insert(at, "q"));
      h.raw(2001, (t) => t.delete(at, 1));
    }
    const original = h.chars();
    const aiAttrs = (t: Y.XmlText) =>
      r.ai === "plain"
        ? {}
        : r.ai === "bold"
          ? { bold: true }
          : ((t.toDelta() as { insert: string; attributes?: object }[]).reduce<{
              seen: number;
              a?: object;
            }>(
              (acc, d) =>
                acc.a !== undefined
                  ? acc
                  : acc.seen + d.insert.length > at
                    ? { seen: 0, a: d.attributes ?? {} }
                    : { seen: acc.seen + d.insert.length },
              { seen: 0 },
            ).a ?? {});
    const edit = (from: string, to: string) =>
      h.write((t) => {
        const attrs = aiAttrs(t);
        if (r.op !== "insert") t.delete(at, from.length);
        if (r.op !== "delete") t.insert(at, to, attrs);
      });
    const mid = "medium";
    const e1 = edit(r.old, r.mode === "chain" ? mid : r.neu);
    const live = r.op === "delete" ? "" : r.mode === "chain" ? mid : r.neu;
    let e2: Part[] | null = null;
    if (r.mode === "chain" && r.op === "replace") {
      e2 = h.write((t) => {
        const attrs = aiAttrs(t);
        t.delete(at, mid.length);
        t.insert(at, r.neu, attrs);
      });
      h.inverse(e2, "invert");
      trace.push(`undo e2: ${h.str()}`);
    }
    const kept = r.op === "insert" ? r.old : "";
    const wattrs = r.wmark === "inherit" ? undefined : r.wmark === "plain" ? {} : { italic: true };
    const typed = { before: "", after: "" };
    if (r.where === "before" || r.where === "both") {
      h.raw(2002, (t) => t.insert(at, BEFORE, wattrs));
      typed.before = BEFORE;
    }
    if (r.where === "after" || r.where === "both") {
      h.raw(2003, (t) => t.insert(at + typed.before.length + live.length, AFTER, wattrs));
      typed.after = AFTER;
    }
    if (r.wrange === "typed" && typed.before)
      h.raw(2002, (t) => t.format(at, BEFORE.length, { bold: true }));
    if (r.wrange === "typed+word" && typed.before)
      h.raw(2002, (t) => t.format(at, BEFORE.length + live.length, { bold: true }));
    const ranged = r.wrange !== "none" && !!typed.before;
    const applied = h.chars();
    trace.push(`applied: ${h.str()}`);
    const writerMarks = (cs: Ch[], token: string) => {
      const s = cs.map((c) => c.ch).join(""),
        i = s.indexOf(token);
      return i < 0 ? null : JSON.stringify(cs.slice(i, i + token.length).map((c) => c.a));
    };
    const judge = (label: string, extra: string) => {
      const now = h.chars(),
        s = now.map((c) => c.ch).join("");
      const restored = r.op === "insert" ? "" : r.old;
      const want =
        r.op === "delete"
          ? `One ${restored}${typed.before}${extra}${typed.after}${kept} cat.`
          : `One ${typed.before}${extra}${restored}${typed.after}${kept} cat.`;
      trace.push(`${label}: ${s} (want ${want})`);
      checks[`${label}:position`] = s === want;
      checks[`${label}:whole`] = !restored || s.includes(restored);
      checks[`${label}:kept`] = [...s].sort().join("") === [...want].sort().join("");
      let marksOk = true;
      for (const token of [typed.before, typed.after].filter(Boolean))
        if (writerMarks(now, token) !== writerMarks(applied, token)) marksOk = false;
      checks[`${label}:writer-marks`] = marksOk;
      if (restored && !ranged && s.includes(restored)) {
        const i = s.indexOf(restored);
        checks[`${label}:original-marks`] =
          JSON.stringify(now.slice(i, i + restored.length).map((c) => c.a)) ===
          JSON.stringify(original.slice(at, at + restored.length).map((c) => c.a));
      }
    };
    const KEEP = !!process.env.KEEP;
    const did = h.inverse(e1, "invert", KEEP);
    judge("undo", "");
    if (KEEP) {
      checks["undo:safe"] = did
        ? checks["undo:position"]
        : h.str() === applied.map((c) => c.ch).join("");
      checks["undo:reversed"] = did > 0;
      return { checks, trace };
    }
    h.inverse(e1, "reapply");
    checks["redo:exact"] = JSON.stringify(h.chars()) === JSON.stringify(applied);
    trace.push(`redo: ${h.str()}`);
    if (!checks["redo:exact"])
      trace.push(
        `applied ${JSON.stringify(applied.map((c) => c.ch + c.a))} now ${JSON.stringify(h.chars().map((c) => c.ch + c.a))}`,
      );
    checks["redo:text"] = h.str() === applied.map((c) => c.ch).join("");
    let extra = "";
    if (r.between === "so-before" && live) {
      h.raw(2004, (t) => t.insert(at + typed.before.length, "so ", wattrs));
      extra = "so ";
    }
    if (r.between !== "x-after" || !live) {
      h.inverse(e1, "invert");
      judge("undo2", extra);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), checks, trace };
  }
  return { checks, trace };
}

it("differential", () => {
  const totals: Record<string, { proto: number; base: number; worse: number; rows: number }> = {};
  const worse: unknown[] = [],
    protoFails: Record<string, number> = {},
    samples: unknown[] = [];
  let errors = 0;
  for (const r of rows()) {
    const base = run(baseImpl as unknown as Impl, r),
      proto = run(protoImpl, r);
    if (proto.error) {
      errors++;
      if (samples.length < 12) samples.push({ r, error: proto.error, trace: proto.trace });
      continue;
    }
    for (const [label, ok] of Object.entries(proto.checks)) {
      const kind = label.split(":")[1];
      totals[kind] ??= { proto: 0, base: 0, worse: 0, rows: 0 };
      const t = totals[kind];
      t.rows++;
      const baseOk = base.checks[label];
      if (!ok) t.proto++;
      if (baseOk === false) t.base++;
      if (!ok && baseOk !== false) {
        t.worse++;
        if (worse.length < 12 || label.endsWith("reversed"))
          worse.push({ label, r, proto: proto.trace, base: base.trace });
      }
      if (!ok) {
        const why = `${kind}|marks=${r.marks}|past=${r.past}|ai=${r.ai}|wrange=${r.wrange}|op=${r.op}`;
        protoFails[why] = (protoFails[why] ?? 0) + 1;
        if (
          samples.length < 40 &&
          (kind !== "position" ||
            (r.wrange !== "typed+word" && r.marks !== "boldspan" && r.marks !== "boldall"))
        )
          samples.push({ label, r, proto: proto.trace });
      }
    }
  }
  writeFileSync(
    "/tmp/p17524-differential.json",
    JSON.stringify({ rows: ROWS, errors, totals, protoFails, worse, samples }, null, 1),
  );
}, 600000);

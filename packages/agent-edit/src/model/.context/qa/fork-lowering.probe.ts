/**
 * Probe (gate B-G): can one change of a draft that lives in its own fork of Live be applied into
 * Live by a struct-level lowering named by the Yjs ids both documents share, on the real schema?
 * Random scripts build a fork through y-tiptap, suggest in it with `rewrite`, apply one change,
 * forward, withdraw and take the press back, checking state after each. Run it by hand: see
 * fork-lowering.md beside this file. It is not shipped code and not part of `pnpm check`.
 */
import { buildDocumentSchema, withBlockIds } from "@meridian/prosemirror-schema";
import {
  type Author,
  list,
  liveView,
  recordStarted,
  rewrite,
  type View,
  viewDoc,
} from "@meridian/suggestions";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  type IdRanges,
  type PressRecord,
  resolveScope,
  resolveStored,
  suggestionAuthors,
  undoPressStored,
} from "../../stored-suggestions.js";
import { fragmentOf } from "../../y-prosemirror.js";

const seed0 = Number(process.env.FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));
const scripts = Number(process.env.FUZZ_SCRIPTS ?? 300);
const only = process.env.FUZZ_ONLY ? Number(process.env.FUZZ_ONLY) : null;
const verbose = process.env.FUZZ_VERBOSE === "1";

let rng = 0;
/** A deterministic integer in [0, n) (mulberry32, as the other probes), so a seed replays a script. */
const rnd = (n: number) => {
  rng = (rng + 0x6d2b79f5) >>> 0;
  let t = rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
};
const freshClient = () => 1 + rnd(2 ** 31 - 2);

const schema = buildDocumentSchema();
const n = schema.nodes;
const m = schema.marks;
const DRAFT = "draftaaaaaaa";
const OTHER = "draftbbbbbbb";
const blank = () => ({ mapping: new Map(), isOMark: new Map() }) as never;

const p = (text: string, attrs: Record<string, unknown> | null = null, marks: string[] = []) =>
  n.paragraph.create(
    attrs,
    text
      ? schema.text(
          text,
          marks.map((name) =>
            name === "comment" ? m.comment.create({ id: `cm${rnd(1000)}` }) : m[name]!.create(),
          ),
        )
      : null,
  );
const item = (text: string) => p(text, { path: "-", kind: "bullet", marker: "item" });

function startDoc(): PMNode {
  const cell = (...blocks: PMNode[]) => n.table_cell.create(null, blocks);
  return withBlockIds(
    schema.topNodeType.create(null, [
      p("Chapter one", { level: 1 }),
      p("alpha beta gamma delta"),
      n.paragraph.create(null, [
        schema.text("bold "),
        schema.text("words here", [m.strong.create()]),
        schema.text(" and "),
        schema.text("noted", [m.comment.create({ id: "cm-live" })]),
        n.hard_break.create(),
        schema.text("after break"),
      ]),
      item("first item"),
      item("second item"),
      n.code_block.create(null, schema.text("const x = 1;")),
      n.horizontal_rule.create(),
      n.table.create(null, [
        n.table_row.create(null, [cell(p("cell a1"), p("cell a2")), cell(p("cell b"))]),
      ]),
      n.jsx_container.create({ name: "Aside" }, [
        p("aside one"),
        n.jsx_container.create({ name: "Note" }, [p("note one"), p("note two")]),
      ]),
      n.paragraph.create(null, [
        schema.text("see "),
        n.image.create({ src: "a.png", alt: "a" }),
        schema.text(" here"),
      ]),
      n.figure.create({ src: "f.png", caption: "fig" }),
      p("last para of the chapter"),
    ]),
  );
}

/** A block a draft might add: plain, formatted, a list item, a container with blocks in it. */
function newBlock(): PMNode {
  switch (rnd(6)) {
    case 0:
      return withBlockIds(p("added para"));
    case 1:
      return withBlockIds(p("added noted", null, ["comment"]));
    case 2:
      return withBlockIds(item("added item"));
    case 3:
      return withBlockIds(
        n.jsx_container.create({ name: "Box" }, [p("box one"), p("box two", null, ["strong"])]),
      );
    case 4:
      return withBlockIds(n.code_block.create(null, schema.text("let y = 2;")));
    default:
      return withBlockIds(n.horizontal_rule.create());
  }
}

/** One random edit, named for the report; one that doesn't fit the picked position inserts text. */
function edit(tr: Transaction, structural = false): string {
  const size = tr.doc.content.size;
  const a = 1 + rnd(size - 2);
  const b = Math.min(size - 1, a + rnd(12));
  const $a = tr.doc.resolve(a);
  const $b = tr.doc.resolve(b);
  const inText = $a.parent.isTextblock && $a.sameParent($b);
  const top = $a.depth > 0 ? $a.before(1) : a;
  const pick = structural ? [3, 4, 5, 9][rnd(4)]! : rnd(16);
  switch (pick) {
    case 0:
      tr.insertText(rnd(2) ? "xy" : " new words ", a);
      return `insert at ${a}`;
    case 1:
      if (!inText) break;
      tr.delete(a, b);
      return `delete ${a}..${b}`;
    case 2:
      if (!inText) break;
      tr.replaceWith(a, b, schema.text("zz"));
      return `replace ${a}..${b}`;
    case 3:
      if (!$a.parent.isTextblock) break;
      tr.split(a);
      return `split at ${a}`;
    case 4: {
      const at = $a.depth > 0 ? $a.before($a.depth) : a;
      tr.join(at);
      return `join at ${at}`;
    }
    case 5:
      tr.insert(top, newBlock());
      return `insert block at ${top}`;
    case 6:
      if (!$a.parent.isTextblock || $a.parent.type !== n.paragraph) break;
      tr.setNodeAttribute($a.before(), "level", rnd(3) || null);
      return `level at ${a}`;
    case 7:
      if (!$a.parent.isTextblock || $a.parent.type !== n.paragraph) break;
      if ($a.parent.attrs.kind) {
        tr.setNodeAttribute($a.before(), "path", null);
        tr.setNodeAttribute($a.before(), "kind", null);
        tr.setNodeAttribute($a.before(), "marker", null);
        return `unlist at ${a}`;
      }
      tr.setNodeAttribute($a.before(), "path", "-");
      tr.setNodeAttribute($a.before(), "kind", "bullet");
      tr.setNodeAttribute($a.before(), "marker", "item");
      return `list at ${a}`;
    case 8:
      if (!inText || a === b) break;
      tr.addMark(a, b, m.strong.create());
      return `bold ${a}..${b}`;
    case 9: {
      const node = tr.doc.nodeAt(top);
      if (!node) break;
      tr.delete(top, top + node.nodeSize);
      return `delete block at ${top}`;
    }
    case 10:
      if (!inText || a === b) break;
      tr.addMark(a, b, m.comment.create({ id: `cm${rnd(1000)}` }));
      return `comment ${a}..${b}`;
    case 11:
      if (!$a.parent.inlineContent || $a.parent.type.spec.code) break;
      tr.insert(a, n.hard_break.create());
      return `hard break at ${a}`;
    case 12:
      if (!$a.parent.inlineContent || $a.parent.type.spec.code) break;
      tr.insert(a, n.image.create({ src: `i${rnd(9)}.png` }));
      return `image at ${a}`;
    case 13: {
      // Rewrite a word: what the model does most.
      if (!$a.parent.isTextblock) break;
      const text = $a.parent.textContent;
      const words = [...text.matchAll(/\S+/g)];
      if (words.length === 0) break;
      const w = words[rnd(words.length)]!;
      const start = $a.start();
      // Text offsets equal positions only in a block of text alone.
      if ($a.parent.childCount !== 1 || !$a.parent.firstChild?.isText) break;
      tr.replaceWith(start + w.index!, start + w.index! + w[0].length, schema.text(`W${rnd(99)}`));
      return `reword ${w[0]} at ${start + w.index!}`;
    }
    case 14:
      if (!inText) break;
      tr.removeMark(a, b, m.strong);
      return `unbold ${a}..${b}`;
  }
  tr.insertText("q", a);
  return `insert q at ${a}`;
}

const pmOf = (doc: Y.Doc) => yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), schema);
/** A document as JSON with object keys sorted: a block's layer record has no key order. */
const json = (node: PMNode) => stable(node.toJSON());
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** A document as short lines: one per textblock or leaf, with its marks and suggestion attributes. */
function outline(doc: PMNode): string[] {
  const lines: string[] = [];
  const attrsOf = (node: PMNode) => {
    const a = Object.entries(node.attrs).filter(
      ([k, v]) => v !== null && k !== "id" && !(k === "props" && JSON.stringify(v) === "{}"),
    );
    return a.length
      ? `{${a.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(",")}}`
      : "";
  };
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const parts: string[] = [];
      node.forEach((child) => {
        const marks = child.marks.map((mk) =>
          mk.type.name === "suggest_ins" || mk.type.name === "suggest_del"
            ? `${mk.type.name.slice(8)}:${mk.attrs.id}`
            : mk.type.name,
        );
        const body = child.isText ? child.text : `<${child.type.name}>`;
        parts.push(marks.length ? `[${body}|${marks.join(",")}]` : body!);
      });
      lines.push(`${pos} ${node.type.name}${attrsOf(node)}: ${parts.join("")}`);
      return false;
    }
    if (node.isLeaf || node.childCount === 0)
      lines.push(`${pos} ${node.type.name}${attrsOf(node)}`);
    else lines.push(`${pos} ${node.type.name}${attrsOf(node)} >`);
    return true;
  });
  return lines;
}

/** The lines where two documents differ, for a failure message. */
function diff(want: PMNode, got: PMNode): string {
  const a = outline(want);
  const b = outline(got);
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < 8; i++)
    if (a[i] !== b[i]) out.push(`    want ${a[i] ?? "-"}\n    got  ${b[i] ?? "-"}`);
  return out.join("\n");
}

/** Writes `next` into the document as the editor's binding does. */
function writePM(doc: Y.Doc, next: PMNode): void {
  updateYFragment(doc, fragmentOf(doc), next, blank());
}

/** One edit made in a view, rewritten and written through y-tiptap. Null when it did nothing. */
function viewEdit(
  doc: Y.Doc,
  view: View,
  author: Author | null,
  structural = false,
): string | null {
  const state = EditorState.create({ schema, doc: pmOf(doc) });
  const tr = state.tr;
  let name: string;
  try {
    name = edit(tr, structural);
  } catch {
    return null;
  }
  const authors = suggestionAuthors(doc);
  const out = view.draft === null ? tr : rewrite(tr, state, view, author, authors);
  if (!out.docChanged) return null;
  const write = (target: Y.Doc) =>
    target.transact(() => {
      recordStarted(out, suggestionAuthors(target));
      writePM(target, out.doc);
    });
  if (view.draft !== null) {
    // A draft's edit must leave the fork's Live view, and every Live item in it, as they were. One
    // that doesn't is counted by kind and not made: the lowering is judged on what marks express.
    const kind = name.split(" ")[0]!;
    const trial = copy(doc);
    const was = visibleUnits(trial);
    const shownBefore = json(viewDoc(pmOf(trial), liveView));
    write(trial);
    const now = visibleUnits(trial);
    const lost = [...was.keys()].some((k) => !now.has(k) && isLiveId(liveSvOf(doc), was.get(k)!));
    const leaked = json(viewDoc(pmOf(trial), liveView)) !== shownBefore;
    const swapped = liveInsertion(trial, liveSvOf(doc));
    trial.destroy();
    if (leaked || lost || swapped) {
      const t = skipped.get(kind) ?? { leaked: 0, lostLiveItem: 0, swapped: 0, in: {} };
      if (leaked) t.leaked++;
      else if (lost) t.lostLiveItem++;
      else t.swapped++;
      const block = blockOf(state.doc, name);
      t.in[block] = (t.in[block] ?? 0) + 1;
      skipped.set(kind, t);
      return null;
    }
    made.set(kind, (made.get(kind) ?? 0) + 1);
  }
  write(doc);
  return name;
}

/** Draft edits not made, by kind: their Live view changed (leaked), or a Live item went (lost). */
const skipped = new Map<
  string,
  { leaked: number; lostLiveItem: number; swapped: number; in: Record<string, number> }
>();

/** The innermost block at the edit's first position, from its name ("insert at 12"). */
function blockOf(doc: PMNode, name: string): string {
  const at = Number(name.match(/\d+/)?.[0] ?? 1);
  const $at = doc.resolve(Math.min(at, doc.content.size));
  return $at.parent.type.name === "doc"
    ? ($at.nodeAfter?.type.name ?? "doc")
    : $at.parent.type.name;
}

/**
 * Whether a Live item in the fork reads as the draft's: the binding's diff put the typed text's
 * mark on Live's equal character, or `sug` on Live's equal block, and made a fork item stand in for
 * it.
 */
function liveInsertion(fork: Y.Doc, sv: Map<number, number>): boolean {
  let found = false;
  const walk = (parent: Y.AbstractType<unknown>) => {
    for (let item = parent._start; item && !found; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const type = item.content.type;
      if (type instanceof Y.XmlText) {
        for (const u of textUnits(type))
          if (
            !u.deleted &&
            isLiveId(sv, Y.createID(u.client, u.clock)) &&
            Object.keys(u.attrs).some((k) => k.startsWith("suggest_ins"))
          )
            found = true;
      } else if ((type as Y.XmlElement).getAttribute("sug")) {
        if (isLiveId(sv, item.id)) found = true;
      } else walk(type);
    }
  };
  walk(fragmentOf(fork));
  return found;
}
const made = new Map<string, number>();
/** The fork's Live clients' clocks: a fork never writes with a Live client. */
const liveSvs = new WeakMap<Y.Doc, Map<number, number>>();
const liveSvOf = (fork: Y.Doc) => liveSvs.get(fork) ?? new Map<number, number>();

// ---------- Yjs id helpers ----------

const isLiveId = (sv: Map<number, number>, id: Y.ID) => id.clock < (sv.get(id.client) ?? 0);
const key = (client: number, clock: number) => `${client}:${clock}`;

/** Whether the unit (`client`, `clock`) is deleted in `doc` (throws when `doc` lacks it). */
function deletedIn(doc: Y.Doc, client: number, clock: number): boolean {
  return Y.getItem(doc.store, Y.createID(client, clock)).deleted;
}

type Unit = { client: number; clock: number; kind: "char" | "element" | "text" };

/** Every visible unit of a document, at every depth: characters, elements and text runs. */
function visibleUnits(doc: Y.Doc): Map<string, Unit> {
  const out = new Map<string, Unit>();
  const walk = (parent: Y.AbstractType<unknown>) => {
    for (let item = parent._start; item; item = item.right) {
      if (item.deleted) continue;
      if (item.content instanceof Y.ContentType) {
        const type = item.content.type;
        const kind = type instanceof Y.XmlText ? "text" : "element";
        out.set(key(item.id.client, item.id.clock), {
          client: item.id.client,
          clock: item.id.clock,
          kind,
        });
        walk(type);
      } else if (item.countable)
        for (let i = 0; i < item.length; i++)
          out.set(key(item.id.client, item.id.clock + i), {
            client: item.id.client,
            clock: item.id.clock + i,
            kind: "char",
          });
    }
  };
  walk(fragmentOf(doc));
  return out;
}

type Attrs = Record<string, unknown>;
const isSuggestionKey = (k: string) => k.startsWith("suggest_ins") || k.startsWith("suggest_del");
const plainAttrs = (attrs: Attrs) =>
  Object.fromEntries(Object.entries(attrs).filter(([k]) => !isSuggestionKey(k)));
const elementAttrs = (el: Y.XmlElement): Attrs =>
  Object.fromEntries(
    Object.entries(el.getAttributes()).filter(([k]) => k !== "sug" && !k.startsWith("sugAttrs")),
  );

/** Per countable unit of a text, in order: id, whether deleted, and the attributes it reads with. */
function textUnits(text: Y.XmlText) {
  const units: Array<{
    client: number;
    clock: number;
    deleted: boolean;
    ch: string;
    attrs: Attrs;
  }> = [];
  const current: Attrs = {};
  for (let item = text._start; item; item = item.right) {
    const c = item.content;
    if (c instanceof Y.ContentFormat) {
      if (!item.deleted) {
        if (c.value === null) delete current[c.key];
        else current[c.key] = c.value;
      }
      continue;
    }
    if (!item.countable) continue;
    const str = c instanceof Y.ContentString ? c.str : null;
    for (let i = 0; i < item.length; i++)
      units.push({
        client: item.id.client,
        clock: item.id.clock + i,
        deleted: item.deleted,
        ch: str ? str[i]! : "",
        attrs: { ...current },
      });
  }
  return units;
}

/** The ids a change's insertions carry in the fork: inline text under its `suggest_ins`, and its blocks. */
function changeItems(fork: Y.Doc, change: string) {
  const chars = new Set<string>();
  const blocks = new Set<string>();
  const markId = (v: unknown) => (v as { id?: unknown } | null)?.id;
  const walk = (parent: Y.AbstractType<unknown>) => {
    for (let item = parent._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const type = item.content.type;
      if (type instanceof Y.XmlText) {
        for (const u of textUnits(type))
          if (
            !u.deleted &&
            Object.entries(u.attrs).some(
              ([k, v]) => k.startsWith("suggest_ins") && markId(v) === change,
            )
          )
            chars.add(key(u.client, u.clock));
      } else if (type instanceof Y.XmlElement) {
        if (markId(type.getAttribute("sug")) === change)
          blocks.add(key(item.id.client, item.id.clock));
        walk(type);
      }
    }
  };
  walk(fragmentOf(fork));
  return { chars, blocks };
}

/** A fork-only element as Live reads it: no suggestion attributes, no other change's text or blocks. */
function liveCopy(el: Y.XmlElement): Y.XmlElement {
  const out = new Y.XmlElement(el.nodeName);
  for (const [k, v] of Object.entries(elementAttrs(el))) out.setAttribute(k, v as string);
  const children: Array<Y.XmlElement | Y.XmlText> = [];
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      const delta = (child.toDelta() as Array<{ insert: unknown; attributes?: Attrs }>)
        .filter((d) => !Object.keys(d.attributes ?? {}).some((k) => k.startsWith("suggest_ins")))
        .map((d) => ({ insert: d.insert, attributes: plainAttrs(d.attributes ?? {}) }));
      if (delta.length === 0) continue;
      const text = new Y.XmlText();
      text.applyDelta(delta);
      children.push(text);
    } else if (child instanceof Y.XmlElement && !child.getAttribute("sug"))
      children.push(liveCopy(child));
  }
  if (children.length) out.insert(0, children);
  return out;
}

/** Index of the visible child after `anchor` (an item id in `parent`), or 0 for none. */
function indexAfter(parent: Y.AbstractType<unknown>, anchor: Y.ID | null): number {
  if (!anchor) return 0;
  let index = 0;
  for (let item = parent._start; item; item = item.right) {
    const inside =
      item.id.client === anchor.client &&
      item.id.clock <= anchor.clock &&
      anchor.clock < item.id.clock + item.length;
    if (inside)
      return item.deleted || !item.countable ? index : index + (anchor.clock - item.id.clock) + 1;
    if (!item.deleted && item.countable) index += item.length;
  }
  throw new Error("anchor not in parent");
}

type Anomalies = { forkDeletedLive: number; unownedForkContent: number; where?: string };

/**
 * One Live gap (between a Live item and the next, in one parent) where the applied change put
 * content beside other changes' fork-only content: in fork order, the change's pieces (with the
 * ids Live gave their copies, filled as the copies are made) and the others' (by fork id).
 */
type Gap = {
  parent: Y.ID | null;
  text: boolean;
  anchor: Y.ID | null;
  entries: Array<
    | { mine: true; copies: Y.ID[] }
    | { mine: false; ids: Y.ID[]; runs: Array<{ text: string; attrs: Attrs }> }
  >;
};

/** The ids of `len` visible units of `parent` from index `from`. */
function idsAt(parent: Y.AbstractType<unknown>, from: number, len: number): Y.ID[] {
  const out: Y.ID[] = [];
  let index = 0;
  for (let item = parent._start; item && out.length < len; item = item.right) {
    if (item.deleted || !item.countable) continue;
    for (let i = 0; i < item.length; i++, index++)
      if (index >= from && out.length < len)
        out.push(Y.createID(item.id.client, item.id.clock + i));
  }
  return out;
}

/**
 * The cross-document lowering: write into `live` what accepting change `c` makes of the fork,
 * read from `accepted` (a copy of the fork with `c` accepted) against `fork` (before), naming every
 * place by a Yjs id the two documents share. Live's items the accept keeps are never touched.
 */
function lowerIntoLive(
  live: Y.Doc,
  fork: Y.Doc,
  accepted: Y.Doc,
  c: string,
): { anomalies: Anomalies; gaps: Gap[]; dress: Dress; mine: ReturnType<typeof changeItems> } {
  const sv = Y.decodeStateVector(Y.encodeStateVector(live)) as Map<number, number>;
  const mine = changeItems(fork, c);
  const anomalies: Anomalies = { forkDeletedLive: 0, unownedForkContent: 0 };
  const getLive = (id: Y.ID) => Y.getItem(live.store, id);
  const ops: Array<() => void> = [];
  const deletes: Array<() => void> = [];
  const gaps: Gap[] = [];
  const dress: Dress = { chars: [], blocks: [] };
  /** What the lowering copied into Live: the withdraw deletes exactly these from the fork. */
  const copied: ReturnType<typeof changeItems> = { chars: new Set(), blocks: new Set() };
  const parentId = (type: Y.AbstractType<unknown>) => type._item?.id ?? null;

  const lowerText = (lT: Y.XmlText, fT: Y.XmlText) => {
    let anchor: Y.ID | null = null;
    type Group = {
      anchor: Y.ID | null;
      runs: Array<{ text: string; attrs: Attrs; copies: Y.ID[]; marks: Attrs[] }>;
      gap: Gap;
    };
    const groups: Group[] = [];
    let gap: Gap = { parent: parentId(lT), text: true, anchor: null, entries: [] };
    let open: Group | null = null;
    const closeGap = () => {
      if (gap.entries.some((e) => e.mine) && gap.entries.some((e) => !e.mine)) gaps.push(gap);
    };
    for (const u of textUnits(fT)) {
      const id = Y.createID(u.client, u.clock);
      if (isLiveId(sv, id)) {
        const inLive = !deletedIn(live, u.client, u.clock);
        // Only a Live item that stays visible can be named: Yjs puts an insert after a deleted
        // run, so content beside deleted Live items shares the gap of the visible one before them.
        if (inLive && !u.deleted) {
          closeGap();
          anchor = id;
          gap = { parent: parentId(lT), text: true, anchor, entries: [] };
          open = null;
        }
        const inFork = !deletedIn(fork, u.client, u.clock);
        if (u.deleted && inLive) {
          if (inFork) deletes.push(() => deleteChar(lT, id));
          else anomalies.forkDeletedLive++;
        }
        continue;
      }
      if (u.deleted) continue;
      const last = gap.entries[gap.entries.length - 1];
      // The change's text that is still another change's insertion stays in the fork, with it.
      const stillInserted = Object.keys(u.attrs).some((k) => k.startsWith("suggest_ins"));
      if (!mine.chars.has(key(u.client, u.clock)) || stillInserted) {
        if (!Object.keys(u.attrs).some((k) => k.startsWith("suggest_ins"))) {
          anomalies.unownedForkContent++;
          anomalies.where ??= `char ${JSON.stringify(u.ch)} in ${JSON.stringify(fT.toString())}`;
        }
        if (last && !last.mine) {
          last.ids.push(id);
          const run = last.runs[last.runs.length - 1]!;
          if (JSON.stringify(run.attrs) === JSON.stringify(u.attrs)) run.text += u.ch;
          else last.runs.push({ text: u.ch, attrs: u.attrs });
        } else gap.entries.push({ mine: false, ids: [id], runs: [{ text: u.ch, attrs: u.attrs }] });
        continue;
      }
      if (!open || open.anchor !== anchor) {
        open = { anchor, runs: [], gap };
        groups.push(open);
      }
      copied.chars.add(key(u.client, u.clock));
      const attrs = plainAttrs(u.attrs);
      const run = open.runs[open.runs.length - 1];
      // A piece of the change after another change's text starts a new run, so its copy's ids are its own.
      const marks = Object.fromEntries(Object.entries(u.attrs).filter(([k]) => isSuggestionKey(k)));
      if (run && last?.mine && JSON.stringify(run.attrs) === JSON.stringify(attrs)) {
        run.text += u.ch;
        run.marks.push(marks);
      } else {
        const piece = { text: u.ch, attrs, copies: [] as Y.ID[], marks: [marks] };
        open.runs.push(piece);
        if (!last?.mine) gap.entries.push({ mine: true, copies: piece.copies });
        else {
          // Same entry, new run: its copies join the entry's.
          const entry = last;
          piece.copies = entry.copies;
        }
      }
    }
    closeGap();
    for (const group of groups)
      ops.push(() => {
        let at = indexAfter(lT, group.anchor);
        for (const run of group.runs) {
          lT.insert(at, run.text, { ...run.attrs });
          const ids = idsAt(lT, at, run.text.length);
          run.copies.push(...ids);
          ids.forEach((id, i) => {
            dress.chars.push({ id, marks: run.marks[i]! });
          });
          at += run.text.length;
        }
      });
  };

  const deleteChar = (lT: Y.XmlText, id: Y.ID) => {
    let index = 0;
    for (let item = lT._start; item; item = item.right) {
      const inside =
        item.id.client === id.client &&
        item.id.clock <= id.clock &&
        id.clock < item.id.clock + item.length;
      if (inside) {
        if (!item.deleted) lT.delete(index + (id.clock - item.id.clock), 1);
        return;
      }
      if (!item.deleted && item.countable) index += item.length;
    }
  };

  const lowerChildren = (lP: Y.XmlFragment | Y.XmlElement, fP: Y.XmlFragment | Y.XmlElement) => {
    let anchor: Y.ID | null = null;
    // Fork-only children after one Live anchor go in as one insert, in the fork's order.
    let group: {
      anchor: Y.ID | null;
      make: Array<() => Y.XmlElement | Y.XmlText>;
      copies: Y.ID[][];
    } | null = null;
    let gap: Gap = { parent: parentId(lP), text: false, anchor: null, entries: [] };
    const closeGap = () => {
      if (gap.entries.some((e) => e.mine) && gap.entries.some((e) => !e.mine)) gaps.push(gap);
    };
    const add = (make: () => Y.XmlElement | Y.XmlText) => {
      if (!group || group.anchor !== anchor) {
        const g: NonNullable<typeof group> = { anchor, make: [], copies: [] };
        group = g;
        ops.push(() => {
          const made = g.make.map((f) => f());
          lP.insert(indexAfter(lP, g.anchor), made);
          made.forEach((el, i) => g.copies[i]!.push(el._item!.id));
        });
      }
      const copies: Y.ID[] = [];
      group.make.push(make);
      group.copies.push(copies);
      gap.entries.push({ mine: true, copies });
    };
    const other = (id: Y.ID) => gap.entries.push({ mine: false, ids: [id], runs: [] });
    for (let item = fP._start; item; item = item.right) {
      if (!(item.content instanceof Y.ContentType)) continue;
      const fType = item.content.type;
      if (isLiveId(sv, item.id)) {
        const lItem = getLive(item.id);
        if (!item.deleted && !lItem.deleted) {
          closeGap();
          anchor = item.id;
          gap = { parent: parentId(lP), text: false, anchor, entries: [] };
        }
        const lType = (lItem.content as Y.ContentType).type;
        if (item.deleted) {
          if (!lItem.deleted) {
            if (!deletedIn(fork, item.id.client, item.id.clock)) {
              const id = item.id;
              deletes.push(() => {
                const at = indexAfter(lP, id) - 1;
                lP.delete(at, 1);
              });
            } else anomalies.forkDeletedLive++;
          }
          continue;
        }
        if (lItem.deleted) continue;
        if (fType instanceof Y.XmlText) lowerText(lType as Y.XmlText, fType);
        else {
          const lEl = lType as Y.XmlElement;
          const fEl = fType as Y.XmlElement;
          const want = elementAttrs(fEl);
          const have = elementAttrs(lEl);
          for (const [k, v] of Object.entries(want))
            if (JSON.stringify(have[k]) !== JSON.stringify(v))
              ops.push(() => lEl.setAttribute(k, v as string));
          for (const k of Object.keys(have))
            if (!(k in want)) ops.push(() => lEl.removeAttribute(k));
          lowerChildren(lEl, fEl);
        }
        continue;
      }
      if (item.deleted) continue;
      // A fork-only child: copy it if it is this change's block, or holds this change's text.
      if (fType instanceof Y.XmlElement) {
        if (mine.blocks.has(key(item.id.client, item.id.clock))) {
          copied.blocks.add(key(item.id.client, item.id.clock));
          const source = item.id;
          add(() => {
            const made = liveCopy(fType);
            dress.blocks.push({ copy: () => made._item!.id, source });
            return made;
          });
        } else {
          if (!fType.getAttribute("sug")) anomalies.unownedForkContent++;
          other(item.id);
        }
      } else if (fType instanceof Y.XmlText) {
        const runs: Array<{ insert: string; attributes: Attrs }> = [];
        for (const u of textUnits(fType)) {
          if (u.deleted) continue;
          if (
            !mine.chars.has(key(u.client, u.clock)) ||
            Object.keys(u.attrs).some((k) => k.startsWith("suggest_ins"))
          ) {
            if (!Object.keys(u.attrs).some((k) => k.startsWith("suggest_ins")))
              anomalies.unownedForkContent++;
            continue;
          }
          copied.chars.add(key(u.client, u.clock));
          copied.chars.add(key(u.client, u.clock));
          const attrs = plainAttrs(u.attrs);
          const last = runs[runs.length - 1];
          if (last && JSON.stringify(last.attributes) === JSON.stringify(attrs))
            last.insert += u.ch;
          else runs.push({ insert: u.ch, attributes: attrs });
        }
        if (!runs.length) other(item.id);
        else
          add(() => {
            const text = new Y.XmlText();
            text.applyDelta(runs);
            return text;
          });
      }
    }
    closeGap();
  };

  lowerChildren(fragmentOf(live), fragmentOf(accepted));
  // Inserts first, while every anchor is still where the fork saw it; then the deletions, by id.
  for (const op of ops) op();
  for (const op of deletes) op();
  return { anomalies, gaps, dress, mine: copied };
}

/** Deletes the change's own inserted text and blocks from the fork, by id: Live's copies stand for them. */
function deleteOwn(fork: Y.Doc, mine: ReturnType<typeof changeItems>): void {
  const walk = (parent: Y.AbstractType<unknown>) => {
    let index = 0;
    for (let item = parent._start; item; item = item.right) {
      if (item.deleted || !item.countable) continue;
      if (item.content instanceof Y.ContentType) {
        const type = item.content.type;
        if (mine.blocks.has(key(item.id.client, item.id.clock))) {
          (parent as Y.XmlElement).delete(index, 1);
          continue;
        }
        if (type instanceof Y.XmlText) {
          const units = textUnits(type).filter((u) => !u.deleted);
          for (let i = units.length - 1; i >= 0; i--)
            if (mine.chars.has(key(units[i]!.client, units[i]!.clock))) type.delete(i, 1);
        } else walk(type);
      }
      index++;
    }
  };
  walk(fragmentOf(fork));
}

/**
 * What the withdraw lays back over Live's copies in the fork: the suggestion marks other changes
 * have on the applied change's text, and, inside its blocks, their text, blocks and layers.
 */
type Dress = {
  chars: Array<{ id: Y.ID; marks: Attrs }>;
  blocks: Array<{ copy: () => Y.ID; source: Y.ID }>;
};

/** Gives unit `index` of `text` exactly the suggestion marks `marks`, clearing any it reads with besides. */
function setMarks(text: Y.XmlText, index: number, marks: Attrs): void {
  const unit = textUnits(text).filter((u) => !u.deleted)[index];
  const exact: Attrs = { ...marks };
  for (const k of Object.keys(unit?.attrs ?? {}))
    if (isSuggestionKey(k) && !(k in marks)) exact[k] = null;
  if (Object.keys(exact).length) text.format(index, 1, exact);
}

/** Whether a fork child is absent from Live's view: another change's block, or text all inserted. */
function hiddenChild(child: Y.XmlElement | Y.XmlText): boolean {
  if (child instanceof Y.XmlElement) return !!child.getAttribute("sug");
  const units = textUnits(child).filter((u) => !u.deleted);
  return (
    units.length > 0 &&
    units.every((u) => Object.keys(u.attrs).some((k) => k.startsWith("suggest_ins")))
  );
}

/**
 * Lays a fork's overlay from `source` (a fork element) onto `target`, Live items holding the same
 * Live content, in the fork: its layers, its hidden children and inserted text (made again, as fork
 * items) and its suggestion marks on Live text. Returns false when the two do not pair.
 */
function dressOver(target: Y.XmlElement | Y.XmlText, source: Y.XmlElement | Y.XmlText): boolean {
  if (target instanceof Y.XmlText && source instanceof Y.XmlText) {
    let at = 0;
    const formats: Array<[number, Attrs]> = [];
    const inserts: Array<[number, string, Attrs]> = [];
    const targetLength = textUnits(target).filter((u) => !u.deleted).length;
    for (const u of textUnits(source)) {
      if (u.deleted) continue;
      if (Object.keys(u.attrs).some((k) => k.startsWith("suggest_ins"))) {
        const last = inserts[inserts.length - 1];
        if (last && last[0] === at && JSON.stringify(last[2]) === JSON.stringify(u.attrs))
          last[1] += u.ch;
        else inserts.push([at, u.ch, u.attrs]);
        continue;
      }
      formats.push([
        at,
        Object.fromEntries(Object.entries(u.attrs).filter(([k]) => isSuggestionKey(k))),
      ]);
      at++;
    }
    if (at !== targetLength) return false;
    for (const [i, m] of formats) setMarks(target, i, m);
    for (const [i, text, attrs] of [...inserts].reverse()) target.insert(i, text, { ...attrs });
    return true;
  }
  if (!(target instanceof Y.XmlElement && source instanceof Y.XmlElement)) return false;
  for (const [k, v] of Object.entries(source.getAttributes()))
    if (k.startsWith("sugAttrs--") && target.getAttribute(k) === undefined)
      target.setAttribute(k, v as string);
  const targets = target.toArray() as Array<Y.XmlElement | Y.XmlText>;
  let ti = 0;
  const pending: Array<[number, Y.XmlElement | Y.XmlText]> = [];
  for (const child of source.toArray() as Array<Y.XmlElement | Y.XmlText>) {
    if (child instanceof Y.XmlText && textUnits(child).every((u) => u.deleted)) continue;
    if (hiddenChild(child)) {
      pending.push([ti, child.clone()]);
      continue;
    }
    const t = targets[ti++];
    if (!t || !dressOver(t, child)) return false;
  }
  if (ti !== targets.length) return false;
  for (const [i, clone] of pending.reverse()) target.insert(i, [clone]);
  return true;
}

/**
 * After the withdraw: other changes' fork-only content that shared a Live gap with the applied
 * change goes back where the fork had it, beside Live's copies. Live's copy is one run anchored on
 * Live items (Live can name no fork item), so Yjs orders it among the fork's items by client id.
 * The others' content is made again (new fork ids) at its place.
 */
function replaceAround(fork: Y.Doc, gaps: readonly Gap[]): number {
  let moved = 0;
  for (const gap of gaps) {
    const parent = gap.parent
      ? ((Y.getItem(fork.store, gap.parent).content as Y.ContentType).type as
          | Y.XmlText
          | Y.XmlElement)
      : fragmentOf(fork);
    let prev = gap.anchor;
    for (const entry of gap.entries) {
      if (entry.mine) {
        if (entry.copies.length) prev = entry.copies[entry.copies.length - 1]!;
        continue;
      }
      moved++;
      if (gap.text) {
        const text = parent as Y.XmlText;
        for (const id of [...entry.ids].reverse()) {
          const at = indexAfter(text, id) - 1;
          if (!Y.getItem(fork.store, id).deleted) text.delete(at, 1);
        }
        let at = indexAfter(text, prev);
        for (const run of entry.runs) {
          text.insert(at, run.text, { ...run.attrs });
          at += run.text.length;
        }
        prev = idsAt(text, at - 1, 1)[0] ?? prev;
      } else {
        const list = parent as Y.XmlElement;
        const original = (Y.getItem(fork.store, entry.ids[0]!).content as Y.ContentType).type as
          | Y.XmlElement
          | Y.XmlText;
        const clone = original.clone();
        list.delete(indexAfter(list, entry.ids[0]!) - 1, 1);
        list.insert(indexAfter(list, prev), [clone]);
        prev = clone._item!.id;
      }
    }
  }
  return moved;
}

/**
 * Forward Live into a fork, then make Live's new items there read as they read in Live: a fork's
 * format items around them (a deletion mark, another change's insertion, a comment) do not cover
 * them. The fix-up is the fork's own transaction.
 */
function forward(live: Y.Doc, fork: Y.Doc, update?: Uint8Array): void {
  const u = update ?? Y.encodeStateAsUpdate(live, Y.encodeStateVector(fork));
  const fresh = new Map<number, Array<[number, number]>>();
  const decoded = Y.decodeUpdate(u);
  for (const s of decoded.structs)
    if (s instanceof Y.Item) {
      const list = fresh.get(s.id.client) ?? [];
      list.push([s.id.clock, s.id.clock + s.length]);
      fresh.set(s.id.client, list);
    }
  // A deletion touches a text too: deleting Live's format item can uncover a fork one.
  const removed = new Map<number, Array<[number, number]>>();
  for (const [client, runs] of decoded.ds.clients)
    removed.set(
      client,
      runs.map((r): [number, number] => [r.clock, r.clock + r.len]),
    );
  fork.transact(() => {
    const own = forkOnlyAttrs(fork, liveSvOf(fork));
    Y.applyUpdate(fork, u);
    fixup(live, fork, fresh, removed);
    keepForkAttrs(fork, own);
  });
  liveSvs.set(fork, Y.decodeStateVector(Y.encodeStateVector(live)) as Map<number, number>);
}

/** The fork's own visible text, by id, with the attributes it reads with. */
function forkOnlyAttrs(fork: Y.Doc, sv: Map<number, number>): Map<string, Attrs> {
  const out = new Map<string, Attrs>();
  const walk = (parent: Y.AbstractType<unknown>) => {
    for (let item = parent._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const type = item.content.type;
      if (type instanceof Y.XmlText) {
        for (const u of textUnits(type))
          if (!u.deleted && !isLiveId(sv, Y.createID(u.client, u.clock)))
            out.set(key(u.client, u.clock), u.attrs);
      } else walk(type);
    }
  };
  walk(fragmentOf(fork));
  return out;
}

/** Live's format items cover the fork's own text too: it reads as it did before the forward. */
function keepForkAttrs(fork: Y.Doc, own: Map<string, Attrs>): void {
  const walk = (parent: Y.AbstractType<unknown>) => {
    for (let item = parent._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const type = item.content.type;
      if (type instanceof Y.XmlText) {
        const fixes: Array<[number, Attrs]> = [];
        let pos = 0;
        for (const u of textUnits(type)) {
          if (u.deleted) continue;
          const was = own.get(key(u.client, u.clock));
          if (was) {
            const fix: Attrs = {};
            for (const k of Object.keys(u.attrs)) if (!(k in was)) fix[k] = null;
            for (const [k, v] of Object.entries(was))
              if (JSON.stringify(u.attrs[k]) !== JSON.stringify(v)) fix[k] = v;
            if (Object.keys(fix).length) fixes.push([pos, fix]);
          }
          pos++;
        }
        for (const [at, attrs] of fixes.reverse()) type.format(at, 1, attrs);
      } else walk(type);
    }
  };
  walk(fragmentOf(fork));
}

/**
 * `fresh`: the forwarded update's items. Only texts holding one are checked; `null` checks every
 * text, as the end of a withdraw or an Undo does after its own fork writes.
 */
function fixup(
  live: Y.Doc,
  fork: Y.Doc,
  fresh: Map<number, Array<[number, number]>> | null,
  removed: Map<number, Array<[number, number]>> = new Map(),
): void {
  const isFresh = (client: number, clock: number) =>
    !!fresh && (fresh.get(client) ?? []).some(([a, b]) => a <= clock && clock < b);
  const isRemoved = (client: number, clock: number) =>
    (removed.get(client) ?? []).some(([a, b]) => a <= clock && clock < b);
  const walk = (parent: Y.AbstractType<unknown>) => {
    for (let item = parent._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const type = item.content.type;
      if (type instanceof Y.XmlText) {
        let liveText: Y.XmlText | null = null;
        try {
          const li = Y.getItem(live.store, item.id);
          if (!li.deleted) liveText = (li.content as Y.ContentType).type as Y.XmlText;
        } catch {
          liveText = null;
        }
        if (!liveText) continue;
        let touched = fresh === null;
        for (let it = type._start; it && !touched; it = it.right)
          touched = isFresh(it.id.client, it.id.clock) || isRemoved(it.id.client, it.id.clock);
        if (!touched) continue;
        const inLive = new Map(
          textUnits(liveText).map((lu) => [key(lu.client, lu.clock), lu.attrs]),
        );
        const fixes: Array<[number, Attrs]> = [];
        let pos = 0;
        for (const u of textUnits(type)) {
          if (u.deleted) continue;
          const want = inLive.get(key(u.client, u.clock));
          // Live text reads with Live's formatting; of the fork's marks it keeps only its
          // suggestions, and none on Live's new text.
          if (want) {
            const fresh = isFresh(u.client, u.clock);
            const fix: Attrs = {};
            for (const k of Object.keys(u.attrs))
              if (!(k in want) && (fresh || !isSuggestionKey(k))) fix[k] = null;
            for (const [k, v] of Object.entries(want))
              if (JSON.stringify(u.attrs[k]) !== JSON.stringify(v)) fix[k] = v;
            if (Object.keys(fix).length) fixes.push([pos, fix]);
          }
          pos++;
        }
        for (const [at, attrs] of fixes.reverse()) type.format(at, 1, attrs);
      } else walk(type);
    }
  };
  walk(fragmentOf(fork));
}

function rangesOf(set: ReturnType<typeof Y.createDeleteSet>): IdRanges {
  const out: IdRanges = {};
  for (const [client, items] of set.clients)
    out[client] = items.map((i): [number, number] => [i.clock, i.len]);
  return out;
}

/** Runs `write` as one transaction under a recorder over `scope`; its id ranges and its update. */
function recorded(doc: Y.Doc, scope: Y.AbstractType<unknown>[], write: () => void) {
  const origin = Symbol("press");
  const recorder = new Y.UndoManager(scope, {
    trackedOrigins: new Set([origin]),
    captureTimeout: Number.POSITIVE_INFINITY,
  });
  const updates: Uint8Array[] = [];
  const onUpdate = (u: Uint8Array) => updates.push(u);
  doc.on("update", onUpdate);
  try {
    doc.transact(write, origin);
  } finally {
    doc.off("update", onUpdate);
  }
  const step = recorder.undoStack[0];
  recorder.destroy();
  const record: PressRecord = step
    ? { insertions: rangesOf(step.insertions), deletions: rangesOf(step.deletions) }
    : { insertions: {}, deletions: {} };
  return { record, update: Y.mergeUpdates(updates) };
}

/** A read-only copy of a document's encoded state; draws nothing from the script's random stream. */
const peek = (doc: Y.Doc) => {
  const out = new Y.Doc({ gc: false });
  Y.applyUpdate(out, Y.encodeStateAsUpdate(doc));
  return out;
};

const copy = (doc: Y.Doc) => {
  const out = new Y.Doc({ gc: false });
  out.clientID = freshClient();
  Y.applyUpdate(out, Y.encodeStateAsUpdate(doc));
  return out;
};

/** Counts the structs a document gained since `sv`, by kind. */
function grown(doc: Y.Doc, sv: Map<number, number>) {
  const out = {
    chars: 0,
    elements: 0,
    texts: 0,
    formats: 0,
    attrs: 0,
    other: 0,
    clients: new Set<number>(),
  };
  for (const [client, structs] of doc.store.clients)
    for (const s of structs) {
      if (!(s instanceof Y.Item)) continue;
      const from = sv.get(client) ?? 0;
      if (s.id.clock + s.length <= from) continue;
      out.clients.add(client);
      const len = s.id.clock + s.length - Math.max(from, s.id.clock);
      const c = s.content;
      if (c instanceof Y.ContentString) out.chars += len;
      else if (c instanceof Y.ContentFormat) out.formats++;
      else if (c instanceof Y.ContentType)
        c.type instanceof Y.XmlText ? out.texts++ : out.elements++;
      else if (s.parentSub) out.attrs++;
      else out.other++;
    }
  return out;
}

/** Text characters and non-text nodes of a ProseMirror document. */
function sizes(doc: PMNode) {
  let chars = 0;
  let nodes = 0;
  doc.descendants((node) => {
    if (node.isText) chars += node.text!.length;
    else nodes++;
  });
  return { chars, nodes };
}

/** What Live must never hold: a fork's client, a suggestion mark or block attribute, a suggestion map entry. */
function liveLeaks(live: Y.Doc, forkClients: Set<number>): string[] {
  const out: string[] = [];
  for (const [client, structs] of live.store.clients) {
    if (forkClients.has(client)) out.push(`fork client ${client}`);
    for (const s of structs) {
      if (!(s instanceof Y.Item)) continue;
      if (s.content instanceof Y.ContentFormat && isSuggestionKey(s.content.key))
        out.push(`mark ${s.content.key}`);
      if (s.parentSub === "sug" || s.parentSub?.startsWith("sugAttrs"))
        out.push(`block attribute ${s.parentSub}`);
    }
  }
  if (live.getMap("suggestion_authors").size) out.push("authors entry");
  if (live.getMap("suggestion_verdicts").size) out.push("verdict entry");
  if (live.store.pendingStructs || live.store.pendingDs) out.push("pending structs");
  return out;
}

// ---------- the press ----------

type Press = {
  /** What the fork's marks held on the Live items the Apply deleted: the Undo marks their return. */
  struck: Map<string, Attrs>;
  /** The fork's state of each Live block the Apply removed, to lay back over the block Undo restores. */
  removedBlocks: Array<{ k: string; source: Y.XmlElement }>;
  /** The fork before the press (a read-only copy) and Live's clocks then: the order Undo restores. */
  before: Y.Doc;
  liveSv: Map<number, number>;
  liveRecord: PressRecord;
  forkRecord: PressRecord;
  forkUpdate: Uint8Array;
  liveBefore: string;
  forkBefore: string;
  liveBeforeNode: PMNode;
  forkBeforeNode: PMNode;
  verdictsBefore: string;
};

const tally = new Map<string, { pass: number; fail: number; cases: string[] }>();
function check(name: string, ok: boolean, detail: () => string): boolean {
  const t = tally.get(name) ?? { pass: 0, fail: 0, cases: [] };
  if (ok) t.pass++;
  else {
    t.fail++;
    if (t.cases.length < 4) t.cases.push(detail());
  }
  tally.set(name, t);
  return ok;
}

/**
 * Apply one change of `fork` into `live` and withdraw it from the fork, checking every state
 * assertion of the gate on the way. `tag` names the script for a failure.
 */
function press(
  live: Y.Doc,
  fork: Y.Doc,
  draft: string,
  c: string,
  tag: string,
  forkClients: Set<number>,
): Press {
  const liveBefore = pmOf(live);
  const liveSv = Y.decodeStateVector(Y.encodeStateVector(live)) as Map<number, number>;
  const liveVisible = visibleUnits(live);
  const forkBefore = pmOf(fork);
  const forkCopyBefore = peek(fork);
  const verdictsBefore = stable(fork.getMap("suggestion_verdicts").toJSON());
  const accepted = copy(fork);
  accepted.transact(() => resolveStored(accepted, schema, "accept", { id: c }));
  const want = viewDoc(pmOf(accepted), liveView);
  const wantDraft = viewDoc(pmOf(accepted), { draft });

  if (only !== null && verbose)
    process.stdout.write(
      `\n== press ${c} (${tag})\nfork:\n  ${outline(forkBefore).join("\n  ")}\nlive:\n  ${outline(liveBefore).join("\n  ")}\n`,
    );
  const dumping = only !== null && process.env.FUZZ_DUMP;
  if (dumping) {
    dumpText(fork, "fork before", dumping, liveSv);
    dumpText(accepted, "accepted", dumping, liveSv);
  }
  let anomalies: Anomalies = { forkDeletedLive: 0, unownedForkContent: 0 };
  let gaps: Gap[] = [];
  let dress: Dress = { chars: [], blocks: [] };
  let own: ReturnType<typeof changeItems> = { chars: new Set(), blocks: new Set() };
  const lowered = recorded(live, [fragmentOf(live)], () => {
    const result = lowerIntoLive(live, fork, accepted, c);
    anomalies = result.anomalies;
    gaps = result.gaps;
    dress = result.dress;
    own = result.mine;
  });
  check(
    "no fork-side identity loss (fork deleted no Live item, holds no unowned text)",
    anomalies.forkDeletedLive + anomalies.unownedForkContent === 0,
    () => `${tag} ${c}: ${JSON.stringify(anomalies)}`,
  );

  // 1. Live equals the fork's accepted view of that change.
  const got = pmOf(live);
  check(
    "Live == fork's accepted view of the change",
    json(got) === json(want),
    () => `${tag} ${c}:\n${diff(want, got)}`,
  );

  // 2. Every untouched Live item keeps its id: Live loses exactly the items the accept deletes.
  const after = visibleUnits(live);
  const removed = [...liveVisible.keys()].filter((k) => !after.has(k));
  const acceptedVisible = visibleUnits(accepted);
  const forkVisible = visibleUnits(fork);
  const expected = [...liveVisible.keys()].filter(
    (k) => forkVisible.has(k) && !acceptedVisible.has(k),
  );
  check(
    "Live loses exactly the items the accept deletes (untouched items keep their ids)",
    JSON.stringify(removed.sort()) === JSON.stringify(expected.sort()),
    () =>
      `${tag} ${c}: removed ${removed.length} [${removed.slice(0, 6)}], expected ${expected.length} [${expected.slice(0, 6)}]`,
  );

  const struck = new Map<string, Attrs>();
  const removedBlocks: Press["removedBlocks"] = [];
  const gone = new Set(removed);
  const collect = (parent: Y.AbstractType<unknown>) => {
    for (let item = parent._start; item; item = item.right) {
      if (!(item.content instanceof Y.ContentType)) continue;
      const type = item.content.type;
      const k = key(item.id.client, item.id.clock);
      if (type instanceof Y.XmlElement) {
        const parentGone =
          !!type.parent?._item &&
          gone.has(key(type.parent._item.id.client, type.parent._item.id.clock));
        if (gone.has(k) && !parentGone) {
          const scratch = new Y.Doc();
          scratch.getXmlFragment("held").insert(0, [type.clone()]);
          removedBlocks.push({ k, source: scratch.getXmlFragment("held").get(0) as Y.XmlElement });
        }
        if (gone.has(k)) {
          const layers = Object.fromEntries(
            Object.entries(type.getAttributes()).filter(([a]) => a.startsWith("sugAttrs--")),
          );
          if (Object.keys(layers).length) struck.set(k, layers);
        }
        collect(type);
      } else if (type instanceof Y.XmlText)
        for (const u of textUnits(type)) {
          const uk = key(u.client, u.clock);
          if (!gone.has(uk)) continue;
          struck.set(
            uk,
            Object.fromEntries(Object.entries(u.attrs).filter(([a]) => isSuggestionKey(a))),
          );
        }
    }
  };
  collect(fragmentOf(fork));

  // 3. Live holds no fork struct, mark, block attribute or map entry.
  const leaks = liveLeaks(live, forkClients);
  check(
    "Live holds nothing of the fork",
    leaks.length === 0,
    () => `${tag} ${c}: ${leaks.slice(0, 5).join(", ")}`,
  );

  // 4. Live grows by the accepted edit only.
  const g = grown(live, liveSv);
  const removedChars = removed.filter((k) => liveVisible.get(k)!.kind === "char").length;
  const removedNodes = removed.filter((k) => liveVisible.get(k)!.kind === "element").length;
  const sw = sizes(want);
  const sb = sizes(liveBefore);
  const wantChars = sw.chars - sb.chars + removedChars;
  const wantNodes = sw.nodes - sb.nodes + removedNodes;
  check(
    "Live's new structs are the accepted edit's (chars, nodes, one client, no other content)",
    g.chars === wantChars && g.elements === wantNodes && g.other === 0 && g.clients.size <= 1,
    () =>
      `${tag} ${c}: grew ${JSON.stringify({ ...g, clients: g.clients.size })}, want chars ${wantChars} nodes ${wantNodes}; update ${lowered.update.byteLength} B`,
  );
  bytes.push({
    update: lowered.update.byteLength,
    chars: g.chars,
    formats: g.formats,
    texts: g.texts,
    attrs: g.attrs,
  });

  // 5. One fork update: Live's edit forwarded, then the withdraw (reject's writes, verdict accept).
  const tab = copy(fork);
  const fwdUpdates: Uint8Array[] = [];
  const onFwd = (u: Uint8Array) => fwdUpdates.push(u);
  fork.on("update", onFwd);
  forward(live, fork, lowered.update);
  fork.off("update", onFwd);
  const withdrawn = recorded(fork, resolveScope(fork), () => {
    deleteOwn(fork, own);
    resolveStored(fork, schema, "accept", { id: c });
    counts.replaced += replaceAround(fork, gaps);
    for (const { id, marks } of dress.chars) {
      const item = Y.getItem(fork.store, id);
      const text = item.parent as Y.XmlText;
      setMarks(text, indexAfter(text, id) - 1, marks);
    }
    for (const { copy, source } of dress.blocks) {
      const target = (Y.getItem(fork.store, copy()).content as Y.ContentType).type as Y.XmlElement;
      const from = (Y.getItem(accepted.store, source).content as Y.ContentType)
        .type as Y.XmlElement;
      if (!dressOver(target, from)) dressFailures++;
      else counts.dressed++;
    }
    fixup(live, fork, null);
  });
  const forkUpdate = Y.mergeUpdates([...fwdUpdates, withdrawn.update]);
  Y.applyUpdate(tab, forkUpdate);
  if (dumping) dumpText(fork, "fork after", dumping, liveSv);
  const forkNow = pmOf(fork);
  check(
    "fork's Live view == Live after the withdraw",
    json(viewDoc(forkNow, liveView)) === json(pmOf(live)),
    () => `${tag} ${c}:\n${diff(pmOf(live), viewDoc(forkNow, liveView))}`,
  );
  check(
    "fork's draft view == its view before, with the change applied",
    json(viewDoc(forkNow, { draft })) === json(wantDraft),
    () => `${tag} ${c}:\n${diff(wantDraft, viewDoc(forkNow, { draft }))}`,
  );
  const still = list(forkNow, { draft }, suggestionAuthors(fork)).some((ch) => ch.id === c);
  check("the change has nothing pending in the fork", !still, () => `${tag} ${c}`);
  check(
    "a Draft tab given the one fork update matches the fork",
    json(pmOf(tab)) === json(forkNow) && !tab.store.pendingStructs,
    () => `${tag} ${c}: pending ${!!tab.store.pendingStructs}\n${diff(forkNow, pmOf(tab))}`,
  );
  check(
    "no pending structs in the fork",
    !fork.store.pendingStructs && !fork.store.pendingDs,
    () => `${tag} ${c}`,
  );
  accepted.destroy();
  tab.destroy();
  return {
    struck,
    removedBlocks,
    before: forkCopyBefore,
    liveSv,
    liveRecord: lowered.record,
    forkRecord: withdrawn.record,
    forkUpdate,
    liveBefore: json(liveBefore),
    forkBefore: json(forkBefore),
    liveBeforeNode: liveBefore,
    forkBeforeNode: forkBefore,
    verdictsBefore,
  };
}

/**
 * The press's Undo: Live's half from its ranges, forwarded; the fork's half from its own; then the
 * Live text Live's half brought back is struck again in the fork as it was. A Yjs undo of a
 * deletion makes new items, which the fork's old marks do not cover.
 */
function undoPress(live: Y.Doc, fork: Y.Doc, pressed: Press): void {
  const updates: Uint8Array[] = [];
  const onUpdate = (u: Uint8Array) => updates.push(u);
  live.on("update", onUpdate);
  undoPressStored(live, pressed.liveRecord);
  live.off("update", onUpdate);
  /** Where Live's Undo put back unit `k`: the redone copy of the item that held it. */
  const restored = (k: string): Y.ID | null => {
    const [client, clock] = k.split(":").map(Number) as [number, number];
    const id = redone(live.store, Y.createID(client, clock));
    return id && !Y.getItem(live.store, id).deleted ? id : null;
  };
  fork.transact(() => {
    forward(live, fork, Y.mergeUpdates(updates));
    undoPressStored(fork, pressed.forkRecord);
    for (const [k, attrs] of pressed.struck) {
      const id = restored(k);
      if (!id) continue;
      const item = Y.getItem(fork.store, id);
      if (item.content instanceof Y.ContentType) {
        const el = item.content.type as Y.XmlElement;
        for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, v as string);
        continue;
      }
      const text = item.parent as Y.XmlText;
      let index = 0;
      for (let it = text._start; it && it !== item; it = it.right)
        if (!it.deleted && it.countable) index += it.length;
      setMarks(text, index + (id.clock - item.id.clock), attrs);
    }
    for (const { k, source } of pressed.removedBlocks) {
      const id = restored(k);
      if (!id) continue;
      const target = (Y.getItem(fork.store, id).content as Y.ContentType).type as Y.XmlElement;
      if (!dressOver(target, source)) dressFailures++;
      else counts.dressed++;
    }
    counts.reordered += restoreOrder(live, fork, pressed);
    fixup(live, fork, null);
    // Restored fork text reads with its attributes from before the press, whatever format items
    // around it say now.
    const own = new Map<string, Attrs>();
    for (const [k, attrs] of forkOnlyAttrs(pressed.before, pressed.liveSv)) {
      const [client, clock] = k.split(":").map(Number) as [number, number];
      const id = redone(fork.store, Y.createID(client, clock));
      if (id) own.set(key(id.client, id.clock), attrs);
    }
    keepForkAttrs(fork, own);
  });
}

/** Where an Undo put an item's unit back: the end of its `redone` chain, or null if absent. */
function redone(store: Y.Doc["store"], id: Y.ID): Y.ID | null {
  let item: Y.Item;
  try {
    item = Y.getItem(store, id);
  } catch {
    return null;
  }
  let offset = id.clock - item.id.clock;
  while (item.redone) {
    const next = Y.getItem(store, item.redone);
    offset += item.redone.clock - next.id.clock;
    item = next;
  }
  return Y.createID(item.id.client, item.id.clock + offset);
}

/**
 * After an Undo: where a text or a child list of the fork reads in another order than before the
 * press (Live's restored items and the fork's restored insertions are ordered by client id), the
 * fork-only content there is made again in the order it had, around the Live items, which stay.
 */
function restoreOrder(live: Y.Doc, fork: Y.Doc, pressed: Press): number {
  const now = (id: Y.ID) => redone(isLiveId(pressed.liveSv, id) ? live.store : fork.store, id);
  const forkItem = (id: Y.ID | null) => {
    if (!id) return null;
    try {
      const item = Y.getItem(fork.store, id);
      return item.deleted ? null : item;
    } catch {
      return null;
    }
  };
  const isLiveNow = (id: Y.ID) => {
    try {
      Y.getItem(live.store, id);
      return true;
    } catch {
      return false;
    }
  };
  let fixed = 0;
  const walk = (parent: Y.AbstractType<unknown>) => {
    // Children of `parent` (in the pre-press fork), as ids now, in their order then.
    const children: Array<{ id: Y.ID; type: Y.AbstractType<unknown> }> = [];
    for (let item = parent._start; item; item = item.right)
      if (!item.deleted && item.content instanceof Y.ContentType) {
        const id = now(item.id);
        if (id && forkItem(id)) children.push({ id, type: item.content.type });
      }
    const here = parent._item ? forkItem(now(parent._item.id)) : null;
    const target = parent._item
      ? here && ((here.content as Y.ContentType).type as Y.XmlElement)
      : fragmentOf(fork);
    if (target)
      fixed += reorder(
        target,
        children.map((c) => c.id),
        (id) => (forkItem(id)!.content as Y.ContentType).type as Y.XmlElement | Y.XmlText,
      );
    for (const child of children) {
      if (child.type instanceof Y.XmlText) {
        const ids = textUnits(child.type)
          .filter((u) => !u.deleted)
          .map((u) => now(Y.createID(u.client, u.clock)))
          .filter((id): id is Y.ID => !!id && !!forkItem(id));
        const text = (forkItem(child.id)!.content as Y.ContentType).type as Y.XmlText;
        fixed += reorderText(text, ids);
      } else walk(child.type);
    }
  };
  const sameOrder = (actual: Y.ID[], want: Y.ID[]) => {
    const wanted = new Set(want.map((id) => key(id.client, id.clock)));
    const a = actual.filter((id) => wanted.has(key(id.client, id.clock)));
    return a.length === want.length && a.every((id, i) => Y.compareIDs(id, want[i]!));
  };
  const reorder = (
    list: Y.XmlFragment | Y.XmlElement,
    want: Y.ID[],
    typeOf: (id: Y.ID) => Y.XmlElement | Y.XmlText,
  ): number => {
    const actual: Y.ID[] = [];
    for (let item = list._start; item; item = item.right)
      if (!item.deleted && item.countable) actual.push(item.id);
    if (sameOrder(actual, want)) return 0;
    let prev: Y.ID | null = null;
    for (const id of want) {
      if (isLiveNow(id)) {
        prev = id;
        continue;
      }
      const clone = typeOf(id).clone();
      list.delete(indexAfter(list, id) - 1, 1);
      list.insert(indexAfter(list, prev), [clone]);
      prev = clone._item!.id;
    }
    return 1;
  };
  const reorderText = (text: Y.XmlText, want: Y.ID[]): number => {
    const actual = textUnits(text)
      .filter((u) => !u.deleted)
      .map((u) => Y.createID(u.client, u.clock));
    if (sameOrder(actual, want)) return 0;
    const attrsOf = new Map(
      textUnits(text)
        .filter((u) => !u.deleted)
        .map((u) => [key(u.client, u.clock), u]),
    );
    let prev: Y.ID | null = null;
    for (const id of want) {
      if (isLiveNow(id)) {
        prev = id;
        continue;
      }
      const u = attrsOf.get(key(id.client, id.clock))!;
      text.delete(indexAfter(text, id) - 1, 1);
      const at = indexAfter(text, prev);
      text.insert(at, u.ch, { ...u.attrs });
      prev = idsAt(text, at, 1)[0]!;
    }
    return 1;
  };
  walk(fragmentOf(pressed.before));
  return fixed;
}

const bytes: Array<{
  update: number;
  chars: number;
  formats: number;
  texts: number;
  attrs: number;
}> = [];
let dressFailures = 0;
const counts = {
  reordered: 0,
  dressed: 0,
  replaced: 0,
  scripts: 0,
  presses: 0,
  undos: 0,
  noChange: 0,
  twoDraft: 0,
  concurrent: 0,
};

function author(turn: number): Author {
  return { chat: "chat-1", turn: `t${turn}`, by: "agent" };
}

function newFork(live: Y.Doc, clients: Set<number>): Y.Doc {
  const fork = copy(live);
  clients.add(fork.clientID);
  liveSvs.set(fork, Y.decodeStateVector(Y.encodeStateVector(live)) as Map<number, number>);
  return fork;
}

/** A draft's edits in its fork, Live's typing between them, forwarded as B forwards it. */
function dumpText(doc: Y.Doc, label: string, needle: string, sv: Map<number, number>): void {
  const walk = (parent: Y.AbstractType<unknown>) => {
    for (let item = parent._start; item; item = item.right) {
      if (!(item.content instanceof Y.ContentType)) continue;
      const t = item.content.type;
      if (t instanceof Y.XmlText) {
        if (!t.toString().includes(needle)) continue;
        const parts: string[] = [];
        for (let it = t._start; it; it = it.right) {
          const ct = it.content;
          const body =
            ct instanceof Y.ContentString
              ? JSON.stringify(ct.str)
              : ct instanceof Y.ContentFormat
                ? `fmt(${ct.key.slice(0, 12)}=${ct.value === null ? "null" : "v"})`
                : ct.constructor.name;
          parts.push(
            `${it.deleted ? "~" : ""}${isLiveId(sv, it.id) ? "L" : "F"}${it.id.client % 1000}:${it.id.clock} ${body}`,
          );
        }
        process.stdout.write(`${label}: ${parts.join(" | ")}\n`);
      } else walk(t);
    }
  };
  walk(fragmentOf(doc));
}

function suggestIn(live: Y.Doc, fork: Y.Doc, draft: string, edits: number, forks: Y.Doc[]) {
  for (let i = 0; i < edits; i++) {
    let step: string | null;
    if (rnd(4) === 0) {
      step = viewEdit(live, liveView, null);
      if (step) for (const f of forks) forward(live, f);
      step = step && `Live ${step}`;
    } else step = viewEdit(fork, { draft }, author(rnd(3)));
    if (process.env.FUZZ_TRACE && step)
      for (const f of forks) {
        const d = diff(pmOf(live), viewDoc(pmOf(f), liveView));
        if (d) {
          process.stdout.write(`diverged after ${draft} step ${i} (${step}):\n${d}\n`);
          if (process.env.FUZZ_DUMP) {
            dumpText(live, "live", process.env.FUZZ_DUMP, liveSvOf(f));
            dumpText(f, "fork", process.env.FUZZ_DUMP, liveSvOf(f));
          }
        }
      }
  }
}

function pending(fork: Y.Doc, draft: string): string[] {
  return list(pmOf(fork), { draft }, suggestionAuthors(fork)).map((ch) => ch.id);
}

/** A draft replaces the first `word` of the document's text, through `rewrite` and the binding. */
function reword(fork: Y.Doc, draft: string, word: string, replacement: string): void {
  const state = EditorState.create({ schema, doc: pmOf(fork) });
  let at = -1;
  state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(word)) at = pos + node.text!.indexOf(word);
    return at < 0;
  });
  const tr = state.tr.replaceWith(at, at + word.length, schema.text(replacement));
  const authors = suggestionAuthors(fork);
  const out = rewrite(tr, state, { draft }, author(0), authors);
  fork.transact(() => {
    recordStarted(out, authors);
    writePM(fork, out.doc);
  });
}

function script(index: number): void {
  rng = (seed0 + index * 7919) >>> 0;
  const tag = `script ${index} (FUZZ_SEED=${seed0} FUZZ_ONLY=${index})`;
  const live = new Y.Doc({ gc: false });
  live.clientID = freshClient();
  live.transact(() => writePM(live, startDoc()));
  const forkClients = new Set<number>();
  const fork = newFork(live, forkClients);
  const twoDrafts = rnd(4) === 0;
  const other = twoDrafts ? newFork(live, forkClients) : null;
  const forks = other ? [fork, other] : [fork];
  if (other) {
    // Both drafts rewrite the same Live word first (s4's case), then make edits of their own.
    reword(fork, DRAFT, "beta", "ALPHA");
    reword(other, OTHER, "beta", "BETA");
  }
  suggestIn(live, fork, DRAFT, 4 + rnd(10), forks);
  if (other) suggestIn(live, other, OTHER, 4 + rnd(6), forks);
  for (const f of forks) {
    const draft = f === fork ? DRAFT : OTHER;
    check(
      "before the press: fork's Live view == Live",
      json(viewDoc(pmOf(f), liveView)) === json(pmOf(live)),
      () => `${tag} ${draft}:\n${diff(pmOf(live), viewDoc(pmOf(f), liveView))}`,
    );
  }
  for (let round = 0; round < 2; round++) {
    const ids = pending(fork, DRAFT);
    if (ids.length === 0) {
      counts.noChange++;
      break;
    }
    const c = ids[rnd(ids.length)]!;
    // A Live peer's structural edit made before it saw the press, merged after it.
    const peer = rnd(4) === 0 ? copy(live) : null;
    let peerEdit: Uint8Array | null = null;
    if (peer) {
      const before = Y.encodeStateVector(peer);
      if (viewEdit(peer, liveView, null, true)) peerEdit = Y.encodeStateAsUpdate(peer, before);
    }
    const otherBefore = other ? pending(other, OTHER) : [];
    const pressed = press(live, fork, DRAFT, c, `${tag} round ${round}`, forkClients);
    counts.presses++;
    if (other) {
      forward(live, other);
      const otherNow = pending(other, OTHER);
      check(
        "two drafts: the other fork's Live view == Live after the Apply",
        json(viewDoc(pmOf(other), liveView)) === json(pmOf(live)),
        () => `${tag}`,
      );
      check(
        "two drafts: the other draft loses no pending insertion",
        otherNow.every((id) => otherBefore.includes(id)),
        () => `${tag}: before ${otherBefore} now ${otherNow}`,
      );
      counts.twoDraft++;
    }
    if (peer && peerEdit) {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(live, Y.encodeStateVector(peer)));
      const u = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live));
      Y.applyUpdate(live, u);
      for (const f of forks) forward(live, f);
      check(
        "concurrent Live edit: Live and the peer converge",
        json(pmOf(peer)) === json(pmOf(live)),
        () => `${tag}`,
      );
      check(
        "concurrent Live edit: fork's Live view == Live",
        json(viewDoc(pmOf(fork), liveView)) === json(pmOf(live)),
        () => `${tag}:\n${diff(pmOf(live), viewDoc(pmOf(fork), liveView))}`,
      );
      const leaks = liveLeaks(live, forkClients);
      check(
        "concurrent Live edit: Live holds nothing of the fork",
        leaks.length === 0,
        () => `${tag}: ${leaks.slice(0, 4)}`,
      );
      counts.concurrent++;
      peer.destroy();
      continue;
    }
    peer?.destroy();
    if (rnd(2) === 0) {
      undoPress(live, fork, pressed);
      if (other) forward(live, other);
      counts.undos++;
      const liveNow = json(pmOf(live));
      const forkNow = pmOf(fork);
      check(
        "Undo: Live == Live before the press",
        liveNow === pressed.liveBefore,
        () => `${tag} ${c}:\n${diff(pressed.liveBeforeNode, pmOf(live))}`,
      );
      check(
        "Undo: the fork's stored document (marks and all) == before the press",
        json(forkNow) === pressed.forkBefore,
        () => `${tag} ${c}:\n${diff(pressed.forkBeforeNode, forkNow)}`,
      );
      check(
        "Undo: the fork's verdicts == before the press",
        stable(fork.getMap("suggestion_verdicts").toJSON()) === pressed.verdictsBefore,
        () => `${tag} ${c}`,
      );
      check(
        "Undo: the change is pending again",
        pending(fork, DRAFT).includes(c),
        () => `${tag} ${c}`,
      );
      check(
        "Undo: Live holds nothing of the fork",
        liveLeaks(live, forkClients).length === 0,
        () => `${tag} ${c}: ${liveLeaks(live, forkClients).slice(0, 4)}`,
      );
    }
  }
  if (other) {
    const ids = pending(other, OTHER);
    if (ids.length) {
      press(live, other, OTHER, ids[rnd(ids.length)]!, `${tag} second draft`, forkClients);
      counts.presses++;
    }
  }
  counts.scripts++;
  for (const f of forks) f.destroy();
  live.destroy();
}

it("one change of a fork applies into Live by id-anchored lowering", () => {
  const indices = only !== null ? [only] : Array.from({ length: scripts }, (_, i) => i);
  for (const i of indices) {
    try {
      script(i);
    } catch (error) {
      check(
        "script runs without throwing",
        false,
        () =>
          `script ${i} (FUZZ_SEED=${seed0} FUZZ_ONLY=${i}): ${(error as Error).stack?.split("\n").slice(0, 4).join(" | ")}`,
      );
    }
  }
  const report = Object.fromEntries(
    [...tally].map(([name, t]) => [
      name,
      verbose ? t : { pass: t.pass, fail: t.fail, first: t.cases[0] },
    ]),
  );
  check(
    "every overlay paired with Live's copy (dress)",
    dressFailures === 0,
    () => `${dressFailures} did not pair`,
  );
  const perChar = bytes.filter((b) => b.chars > 0).map((b) => b.update / b.chars);
  process.stdout.write(
    `${JSON.stringify({ seed: seed0, ...counts, bytesPerAppliedChar: perChar.length ? { median: perChar.sort((a, b) => a - b)[Math.floor(perChar.length / 2)], max: perChar[perChar.length - 1] } : null }, null, 1)}\n${JSON.stringify(report, null, 1)}\ndraft edits made ${JSON.stringify(Object.fromEntries(made))}\nskipped ${JSON.stringify(Object.fromEntries(skipped))}\n`,
  );
  expect([...tally.values()].every((t) => t.fail === 0)).toBe(true);
});

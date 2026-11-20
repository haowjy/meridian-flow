/**
 * Probe: the suggestion editor's incremental repaint (`suggestion-paint.ts`) against a full
 * paint, after random edits from two Works and Live, each painted in all three views, with focus
 * and the bar slot moving at random. Run it by hand when the paint changes: see repaint-fuzz.md
 * beside this file.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { type Author, recordStarted, rewrite, type View } from "@meridian/suggestions";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import type { Decoration, DecorationSet } from "@tiptap/pm/view";
import { expect, it } from "vitest";

import {
  type Paint,
  paintAll,
  repaint,
} from "@/core/editor/extensions/suggestion-mode/suggestion-paint";

const seed = Number(process.env.FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));
const edits = Number(process.env.FUZZ_EDITS ?? 2000);
const EDITS_PER_DOC = 40;

let rng = seed;
/** A deterministic integer in [0, n), so a seed replays the same run. */
const rnd = (n: number) => {
  rng = (rng * 1103515245 + 12345) & 0x7fffffff;
  return rng % n;
};

const schema = buildDocumentSchema();
const { paragraph, horizontal_rule, table, table_row, table_cell, jsx_container } = schema.nodes;
const p = (text: string, level?: number) =>
  paragraph.create(level ? { level } : null, schema.text(text));

function startDoc(): PMNode {
  const cell = (...blocks: PMNode[]) => table_cell.create(null, blocks);
  return schema.topNodeType.create(null, [
    p("Chapter one", 1),
    ...Array.from({ length: 6 }, (_, i) => p(`para ${i} alpha beta gamma delta epsilon`)),
    horizontal_rule.create(),
    table.create(null, [
      table_row.create(null, [cell(p("cell a1"), p("cell a2")), cell(p("cell b"))]),
      table_row.create(null, [cell(p("cell c")), cell(p("cell d"))]),
    ]),
    jsx_container.create({ name: "Aside" }, [
      p("aside one"),
      jsx_container.create({ name: "Note" }, [p("note one"), p("note two")]),
    ]),
    p("last para of the chapter"),
  ]);
}

/** One random edit, named for the report; one that doesn't fit the picked position inserts instead. */
function edit(tr: Transaction): string {
  const size = tr.doc.content.size;
  const a = 1 + rnd(size - 2);
  const b = Math.min(size - 1, a + rnd(10));
  const $a = tr.doc.resolve(a);
  const $b = tr.doc.resolve(b);
  const inText = $a.parent.isTextblock && $a.sameParent($b);
  const top = $a.depth > 0 ? $a.before(1) : a;
  switch (rnd(11)) {
    case 0:
      tr.insertText("xy", a);
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
    case 4:
      tr.join($a.depth > 0 ? $a.before($a.depth) : a);
      return `join at ${a}`;
    case 5:
      tr.insert(top, p("new block"));
      return `insert block at ${top}`;
    case 6:
      if (!$a.parent.isTextblock) break;
      tr.setNodeAttribute($a.before(), "level", rnd(3));
      return `level at ${a}`;
    case 7:
      if (!inText || a === b) break;
      tr.addMark(a, b, schema.marks.strong.create());
      return `bold ${a}..${b}`;
    case 8:
      tr.removeMark(a, b, schema.marks.strong);
      return `unbold ${a}..${b}`;
    case 9:
      tr.delete(top, top + tr.doc.nodeAt(top)!.nodeSize);
      return `delete block at ${top}`;
  }
  tr.insertText("q", a);
  return `insert q at ${a}`;
}

const dump = (set: DecorationSet) =>
  set
    .find()
    .map((d: Decoration) =>
      JSON.stringify([
        d.from,
        d.to,
        (d as unknown as { type: { constructor: { name: string }; attrs?: unknown } }).type
          .constructor.name,
        (d as unknown as { type: { attrs?: unknown } }).type.attrs ?? null,
        d.spec.change ?? null,
        d.spec.key ?? null,
      ]),
    )
    .sort();

const views: View[] = [{ work: "w1" }, { work: "w2" }, { work: null }];

it("an incremental repaint matches a full paint", () => {
  let checks = 0;
  let skipped = 0;
  for (let docStart = 0; docStart < edits; docStart += EDITS_PER_DOC) {
    const authors = new Map<string, Author>();
    let current = EditorState.create({ schema, doc: startDoc() });
    const painted = views.map((view) => {
      const paint: Paint = { view, focus: null, slot: rnd(2) === 0 };
      return { paint, set: paintAll(current.doc, paint) };
    });
    for (let i = docStart; i < Math.min(edits, docStart + EDITS_PER_DOC); i++) {
      const by = views[rnd(views.length)]!;
      const before = current.doc;
      let name: string;
      try {
        const tr = current.tr;
        name = edit(tr);
        const out = rewrite(
          tr,
          current,
          by,
          { chat: `c-${by.work}`, turn: `t${rnd(3)}`, by: "agent" },
          authors,
        );
        recordStarted(out, authors);
        current = current.apply(out);
      } catch {
        skipped++;
        continue;
      }
      const docs = [before, current.doc];
      // The binding's redraw after Undo or a peer's edit: the whole document, as fresh nodes.
      if (rnd(5) === 0) {
        const fresh = schema.nodeFromJSON(current.doc.toJSON());
        current = current.apply(current.tr.replaceWith(0, current.doc.content.size, fresh.content));
        docs.push(current.doc);
        name += ", then whole-document redraw";
      }
      for (const view of painted) {
        const was = view.paint;
        for (let d = 1; d < docs.length; d++)
          view.set = repaint(view.set, docs[d - 1]!, docs[d]!, was, was);
        if (rnd(4) === 0) {
          const ids = view.set
            .find()
            .map((decoration) => decoration.spec.change as string | undefined)
            .filter((id) => id !== undefined);
          view.paint = {
            ...was,
            focus: ids.length ? ids[rnd(ids.length)]! : null,
            slot: rnd(3) > 0,
          };
          view.set = repaint(view.set, current.doc, current.doc, was, view.paint);
        }
        const got = dump(view.set);
        const want = dump(paintAll(current.doc, view.paint));
        const missing = want.filter((d) => !got.includes(d));
        const extra = got.filter((d) => !want.includes(d));
        expect(
          { missing, extra },
          `seed ${seed}, edit ${i} (${name}) by ${by.work ?? "Live"}, painted in ${view.paint.view.work ?? "Live"}'s view with focus ${view.paint.focus} and slot ${view.paint.slot}; replay with FUZZ_SEED=${seed} FUZZ_EDITS=${i + 1}`,
        ).toEqual({ missing: [], extra: [] });
        checks++;
      }
    }
  }
  process.stdout.write(
    `${JSON.stringify({ seed, edits, repaints: checks, editsThatDidNotApply: skipped })}\n`,
  );
});

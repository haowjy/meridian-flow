/**
 * Two editors probe (`two-editors.md`). Run from the repo root:
 *   pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/two-editors.probe.ts [seeds] [steps]
 * Two editors on two copies of one room make random structural edits and exchange batches at
 * random. After every step each editor must equal a full read of its docs, and at the end the
 * copies must read alike. Exits non-zero on the first failure, printing the block that differs.
 */
import {
  encodeEnvelope,
  freshPeerId,
  RoomDocs,
  setCommentBody,
  visibleComments,
} from "@meridian/document-model";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Fragment, type Node, Slice } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import {
  importRemoteUpdate,
  loroSyncPlugin,
  notifyChanged,
  readProseMirror,
  shapeSchemaOf,
  writeProseMirror,
} from "../../src/index.js";

const schema = buildDocumentSchema();
const shape = shapeSchemaOf(schema);
const seeds = Number(process.argv[2] ?? 20);
const steps = Number(process.argv[3] ?? 400);

type Editor = { docs: RoomDocs; view: { state: EditorState; dispatch(tr: Transaction): void } };
type Place = { node: Node; pos: number };

function run(seed: number): string | null {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  let n = 0;
  const id = () => `p${seed}x${(n++).toString(36)}`;
  const para = () =>
    schema.nodes.paragraph.create(
      { id: id() },
      schema.text("word ".repeat(1 + Math.floor(rand() * 4)).trim()),
    );
  const owned: RoomDocs[] = [];
  const copy = () => {
    const docs = RoomDocs.create(shape, freshPeerId());
    owned.push(docs);
    return docs;
  };
  const editor = (docs: RoomDocs): Editor & { destroy(): void } => {
    const plugin = loroSyncPlugin({ docs });
    const view = {
      state: EditorState.create({ schema, doc: readProseMirror(docs, schema), plugins: [plugin] }),
      composing: false,
      isDestroyed: false,
      dom: new EventTarget(),
      dispatch(tr: Transaction) {
        this.state = this.state.apply(tr);
      },
    };
    const handle = plugin.spec.view?.(view as never) ?? {};
    return { docs, view, destroy: () => handle.destroy?.() };
  };
  // The app's block-id fixer, simplified: a block with no id or a taken one gets a fresh one.
  const fixIds = (tr: Transaction) => {
    const seen = new Set<string>();
    tr.doc.descendants((node, pos) => {
      if (node.isBlock && node.type.spec.attrs?.id) {
        const value = node.attrs.id;
        if (typeof value !== "string" || seen.has(value)) tr.setNodeAttribute(pos, "id", id());
        else seen.add(value);
      }
      return !node.isTextblock;
    });
    return tr;
  };
  const textblocks = (doc: Node) => {
    const out: Place[] = [];
    doc.descendants((node, pos) => {
      if (node.isTextblock) out.push({ node, pos });
      return !node.isTextblock;
    });
    return out;
  };
  const tops = (doc: Node) => {
    const out: Place[] = [];
    doc.forEach((node, pos) => {
      out.push({ node, pos });
    });
    return out;
  };
  const inside = (t: Place) => t.pos + 1 + Math.floor(rand() * (t.node.content.size + 1));

  const seedDocs = copy();
  writeProseMirror(seedDocs, schema.topNodeType.create(null, Array.from({ length: 8 }, para)));
  const a = editor(copy());
  const b = editor(copy());
  for (const e of [a, b]) {
    e.docs.importBatch(seedDocs.exportSince());
    e.view.state = EditorState.create({
      schema,
      doc: readProseMirror(e.docs, schema),
      plugins: e.view.state.plugins,
    });
  }

  const edits: Record<string, (e: Editor) => Transaction | null> = {
    type: ({ view: { state: s } }) => s.tr.insertText("ab", inside(pick(textblocks(s.doc)))),
    split: ({ view: { state: s } }) => {
      const t = pick(textblocks(s.doc));
      return t.node.type.name === "paragraph" ? s.tr.split(inside(t)) : null;
    },
    join: ({ view: { state: s } }) => {
      const t = tops(s.doc);
      return t.length > 1 ? s.tr.join(t[1 + Math.floor(rand() * (t.length - 1))].pos) : null;
    },
    paste: ({ view: { state: s } }) => {
      const t = pick(textblocks(s.doc));
      if (t.node.type.name !== "paragraph") return null;
      const at = inside(t);
      return s.tr.replace(at, at, new Slice(Fragment.fromArray([para(), para(), para()]), 1, 1));
    },
    mark: ({ view: { state: s } }) => {
      const t = pick(textblocks(s.doc));
      if (t.node.content.size < 2) return null;
      const mark = rand() < 0.5 ? schema.marks.strong : schema.marks.em;
      return s.tr.addMark(t.pos + 1, t.pos + t.node.content.size, mark.create());
    },
    unmark: ({ view: { state: s } }) => s.tr.removeMark(0, s.doc.content.size, schema.marks.strong),
    level: ({ view: { state: s } }) => {
      const t = pick(tops(s.doc));
      if (t.node.type.name !== "paragraph") return null;
      return s.tr.setNodeAttribute(t.pos, "level", rand() < 0.5 ? 2 : null);
    },
    deleteAcross: ({ view: { state: s } }) => {
      const t = textblocks(s.doc);
      if (t.length < 3) return null;
      const i = Math.floor(rand() * (t.length - 2));
      return s.tr.delete(t[i].pos + 1, t[i + 1].pos + 2);
    },
    move: ({ view: { state: s } }) => {
      if (s.doc.childCount < 3) return null;
      const x = pick(tops(s.doc));
      const tr = s.tr.delete(x.pos, x.pos + x.node.nodeSize);
      return tr.insert(pick(tops(tr.doc)).pos, x.node);
    },
    wrap: ({ view: { state: s } }) => {
      const t = tops(s.doc);
      const i = Math.floor(rand() * (t.length - 1));
      if (t.length < 3 || t[i].node.type.name !== "paragraph") return null;
      if (t[i + 1].node.type.name !== "paragraph") return null;
      const panel = schema.nodes.jsx_container.create({ id: id(), name: "Panel" }, [
        t[i].node,
        t[i + 1].node,
      ]);
      return s.tr.replaceWith(t[i].pos, t[i + 1].pos + t[i + 1].node.nodeSize, panel);
    },
    unwrap: ({ view: { state: s } }) => {
      const c = tops(s.doc).find((x) => x.node.type.name === "jsx_container");
      return c ? s.tr.replaceWith(c.pos, c.pos + c.node.nodeSize, c.node.content) : null;
    },
    table: ({ view: { state: s } }) => {
      const cell = () => schema.nodes.table_cell.create({ id: id() }, [para()]);
      const row = () => schema.nodes.table_row.create({ id: id() }, [cell(), cell()]);
      return s.tr.insert(pick(tops(s.doc)).pos, schema.nodes.table.create({ id: id() }, [row(), row()]));
    },
    emptyCell: ({ view: { state: s } }) => {
      let cell: Place | null = null;
      s.doc.descendants((node, pos) => {
        if (!cell && node.type.name === "table_cell") cell = { node, pos };
        return !cell;
      });
      if (!cell) return null;
      const { node, pos } = cell as Place;
      const empty = schema.nodes.paragraph.create({ id: `${node.attrs.id}/empty` });
      return s.tr.replaceWith(pos + 1, pos + node.nodeSize - 1, empty);
    },
    removeTop: ({ view: { state: s } }) => {
      if (s.doc.childCount < 3) return null;
      const x = pick(tops(s.doc));
      return s.tr.delete(x.pos, x.pos + x.node.nodeSize);
    },
    comment: ({ docs, view: { state: s } }) => {
      const t = pick(textblocks(s.doc));
      if (t.node.content.size < 2 || t.node.type.name !== "paragraph") return null;
      if (!visibleComments(docs).has("c0")) return null;
      return s.tr.addMark(t.pos + 1, t.pos + 2, schema.marks.comment.create({ id: "c0" }));
    },
  };

  const sync = (from: Editor, to: Editor) => {
    const batch = from.docs.exportSince(to.docs.version());
    if (batch.size > 0) importRemoteUpdate(to.docs, encodeEnvelope(batch));
  };
  const differs = (e: Editor, when: string) => {
    const read = readProseMirror(e.docs, schema);
    if (read.eq(e.view.state.doc)) return null;
    const at = e.view.state.doc.content.findDiffStart(read.content) ?? 0;
    const block = (doc: Node) =>
      JSON.stringify(doc.resolve(Math.min(at, doc.content.size)).parent.toJSON()).slice(0, 600);
    return `${when}: the editor shows ${block(e.view.state.doc)}\n  the docs read ${block(read)}`;
  };

  try {
    for (let step = 0; step < steps; step++) {
      const who = rand() < 0.5 ? a : b;
      let name = "body";
      if (rand() < 0.07) {
        // A comment's body comes and goes outside the editor, as a command's write does.
        const body = rand() < 0.5 ? { body: "x", author: "u", resolved: false } : null;
        const change = setCommentBody(who.docs, "c0", body);
        if (change) notifyChanged(who.docs, [change.key]);
      } else {
        name = pick(Object.keys(edits));
        let tr: Transaction | null = null;
        try {
          tr = edits[name](who);
        } catch {
          continue; // an edit that does not fit this document
        }
        if (!tr?.docChanged) continue;
        who.view.dispatch(fixIds(tr));
      }
      for (const e of [a, b]) {
        const bad = differs(e, `step ${step} (${name})`);
        if (bad) return bad;
      }
      if (rand() < 0.4) sync(a, b);
      if (rand() < 0.4) sync(b, a);
      for (const e of [a, b]) {
        const bad = differs(e, `step ${step} (${name}), after a batch`);
        if (bad) return bad;
      }
    }
    sync(a, b);
    sync(b, a);
    if (!readProseMirror(a.docs, schema).eq(readProseMirror(b.docs, schema)))
      return "the copies read differently after a full exchange";
    return differs(a, "end") ?? differs(b, "end");
  } finally {
    a.destroy();
    b.destroy();
    for (const docs of owned) docs.free();
  }
}

let failed = 0;
for (let seed = 1; seed <= seeds; seed++) {
  const failure = run(seed);
  if (failure) {
    failed++;
    process.stderr.write(`FAIL seed ${seed}: ${failure}\n`);
  }
}
process.stdout.write(failed ? `${failed} of ${seeds} seeds failed\n` : `ok: ${seeds} seeds × ${steps} steps\n`);
process.exitCode = failed ? 1 : 0;

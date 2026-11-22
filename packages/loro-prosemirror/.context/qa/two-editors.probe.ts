/**
 * Two editors probe (`two-editors.md`). Run from the repo root:
 *   pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/two-editors.probe.ts [seeds] [steps]
 * Two editors on two copies of one room make random structural edits, Ctrl+Z and Redo, and
 * exchange batches at random. After every step each editor must equal a full read of its docs, an
 * Undo must keep every word the other editor typed, an Undo chain followed by as many Redos must
 * give back the document exactly, and at the end the copies must read alike. Exits non-zero on the
 * first failure, printing the block that differs.
 */
import {
  encodeEnvelope,
  encodeRoomVersion,
  freshPeerId,
  RoomDocs,
  setCommentBody,
  TEXT_KEY,
  visibleComments,
} from "@meridian/document-model";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Fragment, type Node, Slice } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import {
  importRemoteUpdate,
  loroSyncPlugin,
  notifyChanged,
  readProseMirror,
  resolveCursor,
  shapeSchemaOf,
  UNTRACKED_ORIGIN,
  UndoHistory,
  writeProseMirror,
} from "../../src/index.js";

const schema = buildDocumentSchema();
const shape = shapeSchemaOf(schema);
const seeds = Number(process.argv[2] ?? 20);
const steps = Number(process.argv[3] ?? 400);

type Editor = {
  name: string;
  docs: RoomDocs;
  history: UndoHistory;
  view: { state: EditorState; dispatch(tr: Transaction): void };
};
type Place = { node: Node; pos: number };

/** An editor with the binding and its Undo on `docs`, started from what they read. */
function editor(name: string, docs: RoomDocs): Editor & { destroy(): void } {
  const history = new UndoHistory(docs);
  const plugin = loroSyncPlugin({ docs, history });
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
  return {
    name,
    docs,
    history,
    view,
    destroy: () => {
      handle.destroy?.();
      history.destroy();
    },
  };
}

const sync = (from: Editor, to: Editor) => {
  const batch = from.docs.exportSince(to.docs.version());
  if (batch.size > 0) importRemoteUpdate(to.docs, encodeEnvelope(batch));
};

/** Where the editor's document differs from a full read of its docs, or null. */
function differs(e: Editor, when: string): string | null {
  const read = readProseMirror(e.docs, schema);
  if (read.eq(e.view.state.doc)) return null;
  const at = e.view.state.doc.content.findDiffStart(read.content) ?? 0;
  const block = (doc: Node) =>
    JSON.stringify(doc.resolve(Math.min(at, doc.content.size)).parent.toJSON()).slice(0, 600);
  return `${when}: the editor shows ${block(e.view.state.doc)}\n  the docs read ${block(read)}`;
}

/** Ctrl+Z or Redo as the app runs it: publish nothing, re-read the changed docs, put the selection back. */
function runHistory(e: Editor, direction: "undo" | "redo"): boolean {
  const ran = direction === "undo" ? e.history.undo(e.view.state) : e.history.redo(e.view.state);
  if (!ran) return false;
  notifyChanged(
    e.docs,
    ran.changes.map((change) => change.key),
  );
  const { doc } = e.view.state;
  const at = (end: typeof ran.selection.anchor) => end && resolveCursor(e.docs, doc, end);
  const anchor = at(ran.selection.anchor);
  const head = at(ran.selection.head) ?? anchor;
  if (anchor != null && head != null)
    e.view.dispatch(
      e.view.state.tr
        .setSelection(TextSelection.create(doc, anchor, head))
        .setMeta("addToHistory", false),
    );
  return true;
}

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
  const a = editor("A", copy());
  const b = editor("B", copy());
  for (const e of [a, b]) {
    e.docs.importBatch(seedDocs.exportSince());
    e.view.state = EditorState.create({
      schema,
      doc: readProseMirror(e.docs, schema),
      plugins: e.view.state.plugins,
    });
  }

  // Each editor types words of its own (`qA3`), so an Undo can be checked to keep the other's.
  const typed = { A: new Set<string>(), B: new Set<string>() };
  const edits: Record<string, (e: Editor) => Transaction | null> = {
    type: ({ name, view: { state: s } }) => {
      const word = `q${name}${n++}`;
      typed[name as "A" | "B"].add(word);
      return s.tr.insertText(` ${word} `, inside(pick(textblocks(s.doc))));
    },
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

  // Every word in a copy's text docs, shown or hidden: a hidden block's doc keeps its text.
  const words = (e: Editor) => {
    let all = "";
    for (const doc of e.docs.texts.values()) all += ` ${doc.getText(TEXT_KEY).toString()} `;
    return new Set(all.split(/[^a-zA-Z0-9]+/));
  };
  // An Undo keeps every word the other editor typed (it may hide the block they are in).
  const undoKeeps = (e: Editor, when: string) => {
    const other = typed[e.name === "A" ? "B" : "A"];
    const before = words(e);
    runHistory(e, "undo");
    const after = words(e);
    for (const word of before)
      if (other.has(word) && !after.has(word)) return `${when}: ${e.name}'s Undo took ${word}`;
    return null;
  };
  // From an empty Redo, Ctrl+Z k times, then Redo until none is left, with no batch between: the
  // same document. A Redo can take two steps when one of them now changes nothing (a peer wrote
  // the key it set since), so the Redos are not counted.
  const chain = (e: Editor, when: string) => {
    if (e.history.canRedo()) return null;
    const start = e.view.state.doc;
    let ran = 0;
    const k = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < k; i++) {
      const bad = differs(e, `${when}, Undo ${i}`);
      if (bad) return bad;
      if (runHistory(e, "undo")) ran++;
    }
    for (let i = 0; e.history.canRedo(); i++) {
      if (!runHistory(e, "redo") && i === 0 && ran > 0) return `${when}: no Redo after ${ran} Undos`;
      const bad = differs(e, `${when}, Redo ${i}`);
      if (bad) return bad;
    }
    if (start.eq(e.view.state.doc)) return null;
    const at = start.content.findDiffStart(e.view.state.doc.content) ?? 0;
    const block = (doc: Node) =>
      JSON.stringify(doc.resolve(Math.min(at, doc.content.size)).parent.toJSON()).slice(0, 600);
    return `${when}: ${ran} Undos and Redos changed ${block(start)}\n  to ${block(e.view.state.doc)}`;
  };

  // Edits with no batch between, most a step of their own and some joining the one before, then
  // as many Ctrl+Z as steps: the document from before them exactly; then as many Redos: the
  // document after them. This is the chain that broke on Undo by character id (Enter, Backspace,
  // paste; bold, unbold). Between edits, a write no Ctrl+Z takes back (the body of a comment no
  // text carries, so the document does not show it) must stay out of every step.
  const burst = (e: Editor, when: string) => {
    e.history.endStep();
    const start = e.view.state.doc;
    const names: string[] = [];
    let steps = 0;
    let open = false;
    for (let tries = 0; names.length < 2 + Math.floor(rand() * 5) && tries < 20; tries++) {
      if (rand() < 0.2) {
        const body = rand() < 0.5 ? { body: "y", author: "u", resolved: false } : null;
        const change = setCommentBody(e.docs, "c9", body, { origin: UNTRACKED_ORIGIN });
        if (change) notifyChanged(e.docs, [change.key]);
      }
      const name = pick(Object.keys(edits));
      let tr: Transaction | null = null;
      try {
        tr = edits[name](e);
      } catch {
        continue;
      }
      if (!tr?.docChanged) continue;
      const version = encodeRoomVersion(e.docs.version()).join();
      e.view.dispatch(fixIds(tr));
      // An edit the docs already read as (a cell emptied again) writes nothing and is no step.
      if (encodeRoomVersion(e.docs.version()).join() !== version) {
        names.push(name);
        if (!open) steps++;
        open = true;
      }
      if (rand() < 0.7) {
        e.history.endStep();
        open = false;
      }
    }
    const end = e.view.state.doc;
    const compare = (want: Node, what: string) => {
      const got = e.view.state.doc;
      if (want.eq(got)) return differs(e, `${when}, ${what}`);
      const at = want.content.findDiffStart(got.content) ?? 0;
      const block = (doc: Node) =>
        JSON.stringify(doc.resolve(Math.min(at, doc.content.size)).parent.toJSON()).slice(0, 600);
      return `${when} [${names}]: ${what} gave ${block(got)}\n  want ${block(want)}`;
    };
    for (let i = 0; i < steps; i++)
      if (!runHistory(e, "undo")) return `${when} [${names}]: Undo ${i} found nothing`;
    const undone = compare(start, `${steps} Undos`);
    if (undone) return undone;
    for (let i = 0; i < steps; i++)
      if (!runHistory(e, "redo")) return `${when} [${names}]: Redo ${i} found nothing`;
    return compare(end, `${steps} Redos`);
  };

  try {
    for (let step = 0; step < steps; step++) {
      const who = rand() < 0.5 ? a : b;
      let name = "body";
      const roll = rand();
      if (roll < 0.07) {
        // A comment's body comes and goes outside the editor, as a command's write does.
        const body = rand() < 0.5 ? { body: "x", author: "u", resolved: false } : null;
        const change = setCommentBody(who.docs, "c0", body, { origin: UNTRACKED_ORIGIN });
        if (change) notifyChanged(who.docs, [change.key]);
      } else if (roll < 0.17) {
        name = "undo";
        const bad = undoKeeps(who, `step ${step} (undo)`);
        if (bad) return bad;
      } else if (roll < 0.22) {
        name = "redo";
        runHistory(who, "redo");
      } else if (roll < 0.25) {
        name = "chain";
        const bad = chain(who, `step ${step} (chain)`);
        if (bad) return bad;
      } else if (roll < 0.29) {
        name = "burst";
        const bad = burst(who, `step ${step} (burst)`);
        if (bad) return bad;
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
        // Most edits are a step of their own; the rest join the next, as a quick burst does.
        if (rand() < 0.7) who.history.endStep();
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

/**
 * Typing that races a removal of its block (design §1, "Removed blocks"): A removes a block while
 * B types into it, and the batches cross. Nothing B typed may go out of view, B's own Ctrl+Z of
 * the typing lets the removal stand, and a removal that read the typing stands. Each case starts a
 * room of its own and ends with both editors equal to their docs and to each other.
 */
function racedRemovals(): string[] {
  const p = (id: string, text: string) => schema.nodes.paragraph.create({ id }, schema.text(text));
  const cell = (id: string, text: string) =>
    schema.nodes.table_cell.create({ id }, [p(`${id}p`, text)]);
  const table = schema.nodes.table.create({ id: "t" }, [
    schema.nodes.table_row.create({ id: "r1" }, [cell("c1", "Cell one."), cell("c2", "Cell two.")]),
    schema.nodes.table_row.create({ id: "r2" }, [cell("c3", "Cell three."), cell("c4", "Cell four.")]),
  ]);
  const start = () => [p("a", "First."), p("x", "Delete-target before after."), table, p("z", "Last.")];

  const room = () => {
    const seed = RoomDocs.create(shape, freshPeerId());
    writeProseMirror(seed, schema.topNodeType.create(null, start()));
    const copy = () => {
      const docs = RoomDocs.create(shape, freshPeerId());
      docs.importBatch(seed.exportSince());
      return docs;
    };
    const a = editor("A", copy());
    const b = editor("B", copy());
    return {
      a,
      b,
      free: () => {
        for (const e of [a, b]) {
          e.destroy();
          e.docs.free();
        }
        seed.free();
      },
    };
  };
  const posOf = (e: Editor, id: string) => {
    let at = -1;
    e.view.state.doc.descendants((node, pos) => {
      if (node.attrs.id === id) at = pos;
      return at < 0;
    });
    return at;
  };
  const caret = (e: Editor, id: string, offset: number) => {
    const { state } = e.view;
    e.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, posOf(e, id) + 1 + offset)));
  };
  const remove = (e: Editor, id: string) => {
    const at = posOf(e, id);
    const { state } = e.view;
    e.view.dispatch(state.tr.delete(at, at + (state.doc.nodeAt(at) as Node).nodeSize));
    e.history.endStep();
  };
  const type = (e: Editor, text: string) => {
    for (const ch of text) e.view.dispatch(e.view.state.tr.insertText(ch));
    e.history.endStep();
  };
  const shown = (e: Editor) => e.view.state.doc.textBetween(0, e.view.state.doc.content.size, "|");
  const settle = (r: ReturnType<typeof room>, name: string, want: (text: string) => string | null) => {
    sync(r.a, r.b);
    sync(r.b, r.a);
    for (const e of [r.a, r.b]) {
      const bad = differs(e, `${name} (${e.name})`) ?? want(shown(e));
      if (bad) return `${name}: ${e.name} ${bad}`;
    }
    return shown(r.a) === shown(r.b) ? null : `${name}: the editors differ`;
  };
  const showsAll = (...parts: string[]) => (text: string) =>
    parts.every((part) => text.includes(part)) ? null : `shows "${text}", wanted ${parts.join(", ")}`;
  const showsNone = (...parts: string[]) => (text: string) =>
    parts.some((part) => text.includes(part)) ? `shows "${text}", wanted none of ${parts.join(", ")}` : null;

  const cases: Record<string, (r: ReturnType<typeof room>) => string | null> = {
    // The prober's case: B's first keys land before the removal reaches it, the rest after.
    "typing across the removal's arrival": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      type(r.b, "[remo");
      sync(r.a, r.b);
      type(r.b, "te-edit]");
      return settle(r, "typing across the removal's arrival", showsAll("Delete-target [remote-edit]before"));
    },
    "typing before the removal arrives": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      type(r.b, "[remote-edit]");
      return settle(r, "typing before the removal arrives", showsAll("Delete-target [remote-edit]before"));
    },
    "the typer's Ctrl+Z lets the removal stand": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      type(r.b, "[remote-edit]");
      sync(r.a, r.b);
      if (!shown(r.b).includes("[remote-edit]")) return `Ctrl+Z case: B lost its typing: ${shown(r.b)}`;
      runHistory(r.b, "undo");
      return settle(r, "the typer's Ctrl+Z lets the removal stand", showsNone("Delete-target"));
    },
    "a removal that read the typing stands": (r) => {
      caret(r.b, "x", 14);
      type(r.b, "[remote-edit]");
      sync(r.b, r.a);
      remove(r.a, "x");
      return settle(r, "a removal that read the typing stands", showsNone("Delete-target", "[remote-edit]"));
    },
    "a revived block removed again stays removed": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      type(r.b, "[remote-edit]");
      sync(r.b, r.a);
      sync(r.a, r.b);
      remove(r.a, "x");
      return settle(r, "a revived block removed again stays removed", showsNone("[remote-edit]"));
    },
    "typing in a cell brings its removed table back": (r) => {
      caret(r.b, "c3p", 5);
      remove(r.a, "t");
      type(r.b, "[in-cell]");
      return settle(r, "typing in a cell brings its removed table back", showsAll("Cell [in-cell]three.", "Cell one."));
    },
  };
  const failures: string[] = [];
  for (const [name, run] of Object.entries(cases)) {
    const r = room();
    try {
      const bad = run(r);
      if (bad) failures.push(bad);
    } finally {
      r.free();
    }
  }
  return failures;
}

let failed = 0;
for (const failure of racedRemovals()) {
  failed++;
  process.stderr.write(`FAIL raced removal: ${failure}\n`);
}
for (let seed = 1; seed <= seeds; seed++) {
  const failure = run(seed);
  if (failure) {
    failed++;
    process.stderr.write(`FAIL seed ${seed}: ${failure}\n`);
  }
}
process.stdout.write(
  failed ? `${failed} failed\n` : `ok: raced removals, ${seeds} seeds × ${steps} steps\n`,
);
process.exitCode = failed ? 1 : 0;

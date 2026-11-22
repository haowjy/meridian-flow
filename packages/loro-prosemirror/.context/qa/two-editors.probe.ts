/**
 * Two editors probe (`two-editors.md`). Run from the repo root:
 *   pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/two-editors.probe.ts [seeds] [steps]
 * Two editors on two copies of one room make random structural edits, Ctrl+Z and Redo, and
 * exchange batches at random, whole or one doc at a time. After every step each editor must equal
 * a full read of its docs plus the blocks it keeps for its caret, an Undo must keep every word the
 * other editor typed, an Undo chain followed by as many Redos must give back the docs' read
 * exactly, and at the end the copies must read alike and no removal may stand that did not read
 * an editor's typing in the block. Exits non-zero on the first failure, printing the block that
 * differs.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  applyOps,
  type DocKey,
  encodeEnvelope,
  freshPeerId,
  inText,
  docVersion,
  encodeRoomVersion,
  removalOf,
  RoomDocs,
  STRUCTURE_KEY,
  StructureView,
  setCommentBody,
  visibleComments,
} from "@meridian/document-model";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Fragment, type Node, Slice } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import {
  importRemoteUpdate,
  loroSyncKey,
  loroSyncPlugin,
  notifyChanged,
  readProseMirror,
  resolveCursor,
  shapeSchemaOf,
  UNTRACKED_ORIGIN,
  UndoHistory,
  writeProseMirror,
} from "../../src/index.js";

// HANDLES=1: every Loro handle the probe makes must be freed by the end (document-model's
// handles.ts). Loro registers each handle for finalization and unregisters it on `free()`, so what
// is still registered at exit was never freed.
const unfreed = new Map<object, string>();
if (process.env.HANDLES) {
  const { register, unregister } = FinalizationRegistry.prototype;
  FinalizationRegistry.prototype.register = function (target, held, token) {
    // wasm-bindgen's own closure wrappers (the callbacks handed to Loro) are not handles.
    if (token && target.constructor.name !== "Function") {
      const frame = (new Error().stack ?? "").split("\n").find((l) => l.includes("/src/") && !l.includes("handles.ts"));
      unfreed.set(token, `${target.constructor.name} ${frame?.trim() ?? ""}`);
    }
    return register.call(this, target, held, token);
  };
  FinalizationRegistry.prototype.unregister = function (token) {
    unfreed.delete(token as object);
    return unregister.call(this, token);
  };
}

const schema = buildDocumentSchema();
const shape = shapeSchemaOf(schema);
const seeds = Number(process.argv[2] ?? 20);
const steps = Number(process.argv[3] ?? 400);
/** Seeds run from `first` up, so one failing seed reruns alone: `… 1 400 85`. */
const first = Number(process.argv[4] ?? 1);
/** Another set of peer ids for the same seeds, to find the ids a failure depends on. */
const salt = Number(process.argv[5] ?? 0);

type Editor = {
  name: string;
  plugin: ReturnType<typeof loroSyncPlugin>;
  docs: RoomDocs;
  history: UndoHistory;
  view: { state: EditorState; dispatch(tr: Transaction): void };
  /** Per text doc, this copy's counter after its last forward write there (typing, not Ctrl+Z). */
  typed: Map<DocKey, number>;
};
type Place = { node: Node; pos: number };

/** An editor with the binding and its Undo on `docs`, started from what they read. */
function editor(name: string, docs: RoomDocs): Editor & { destroy(): void } {
  const history = new UndoHistory(docs);
  const typed = new Map<DocKey, number>();
  const plugin = loroSyncPlugin({
    docs,
    history,
    onLocalWrite: (changes) => {
      for (const { key, doc } of changes)
        if (key !== STRUCTURE_KEY)
          typed.set(key, docVersion(doc).get(docs.peer) ?? 0);
    },
  });
  const view = {
    state: EditorState.create({ schema, doc: readProseMirror(docs, schema), plugins: [plugin] }),
    composing: false,
    isDestroyed: false,
    dom: new EventTarget(),
    dispatch(tr: Transaction) {
      this.state = this.state.applyTransaction(tr).state;
    },
  };
  const handle = plugin.spec.view?.(view as never) ?? {};
  return {
    name,
    plugin,
    docs,
    history,
    view,
    typed,
    destroy: () => {
      handle.destroy?.();
      history.destroy();
    },
  };
}

/**
 * `from`'s ops `to` lacks, of every doc or of the docs in `keys`. A restore `to` writes on
 * importing is sent by its next sync.
 */
const sync = (from: Editor, to: Editor, keys?: readonly DocKey[]) => {
  const batch = from.docs.exportSince(to.docs.version());
  if (keys) for (const key of batch.keys()) if (!keys.includes(key)) batch.delete(key);
  if (batch.size > 0) importRemoteUpdate(to.docs, encodeEnvelope(batch), () => {});
};

const keptOf = (e: Editor) => loroSyncKey.getState(e.view.state)?.kept ?? new Set<string>();

/** Where the editor's document differs from a full read of its docs and kept blocks, or null. */
function differs(e: Editor, when: string): string | null {
  const read = readProseMirror(e.docs, schema, undefined, keptOf(e));
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
  // Peer ids come from the seed and `salt` (a stream of their own, so they leave the edits alone):
  // Loro orders concurrent ops by peer id, so a failure that depends on them must come back.
  let peers = seed * 7919 + salt * 104729;
  // The writer picks new order keys with Math.random: seed it too, so a seed replays exactly.
  let keys = peers ^ 0x5bd1e995;
  Math.random = () => {
    keys = (keys * 1103515245 + 12345) & 0x7fffffff;
    return keys / 0x7fffffff;
  };
  const copy = () => {
    peers = (peers * 1103515245 + 12345) & 0x7fffffff;
    const peer = ((1n << 48n) + BigInt(peers) * 521n).toString();
    const docs = RoomDocs.create(shape, peer as ReturnType<typeof freshPeerId>);
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
  // A place inside `t` that cuts no typed word: the words each editor types sit between spaces,
  // and a split in one would let a Join of the halves make the word again from copies, so an
  // Undo of that Join would look like it took the word.
  const between = (t: Place) => {
    const text = t.node.textBetween(0, t.node.content.size, undefined, "\ufffc");
    let at = Math.floor(rand() * (text.length + 1));
    while (at > 0 && at < text.length && text[at - 1] !== " " && text[at] !== " ") at--;
    return t.pos + 1 + at;
  };

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
      return t.node.type.name === "paragraph" ? s.tr.split(between(t)) : null;
    },
    join: ({ view: { state: s } }) => {
      const t = tops(s.doc);
      return t.length > 1 ? s.tr.join(t[1 + Math.floor(rand() * (t.length - 1))].pos) : null;
    },
    paste: ({ view: { state: s } }) => {
      const t = pick(textblocks(s.doc));
      if (t.node.type.name !== "paragraph") return null;
      const at = between(t);
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

  // All the text in a copy's text docs, shown or hidden: a hidden block's doc keeps its text.
  const words = (e: Editor) => {
    let all = "";
    for (const doc of e.docs.texts.values()) all += ` ${inText(doc, (text) => text.toString())} `;
    return all;
  };
  // A word an editor's own Undo or Redo took out of its docs is no longer one it typed that
  // must survive: it may live on only in a copy the other editor made (a Join copies text), and
  // that editor's Undo of the copy takes it away.
  const stepHistory = (e: Editor, direction: "undo" | "redo") => {
    const ran = runHistory(e, direction);
    const now = words(e);
    for (const word of typed[e.name as "A" | "B"]) if (!now.includes(word)) typed[e.name as "A" | "B"].delete(word);
    return ran;
  };
  // An Undo keeps every word the other editor typed (it may hide the block they are in). A word
  // may be glued to its neighbour (the Join of a split drops the space at the cut), so it is
  // looked for inside the text, not as a word of its own.
  const undoKeeps = (e: Editor, when: string) => {
    const other = typed[e.name === "A" ? "B" : "A"];
    const before = words(e);
    stepHistory(e, "undo");
    const after = words(e);
    for (const word of other)
      if (before.includes(word) && !after.includes(word))
        return `${when}: ${e.name}'s Undo took ${word}`;
    return null;
  };
  // The caret leaves the blocks it keeps, so the editor shows the docs' read: a local edit then
  // keeps nothing new, and an Undo chain or a burst compares reads. False when every textblock
  // is kept.
  const release = (e: Editor) => {
    const kept = keptOf(e);
    if (kept.size === 0) return true;
    let target: number | null = null;
    e.view.state.doc.descendants((node, pos) => {
      if (target !== null || kept.has(node.attrs.id)) return false;
      if (node.isTextblock) target = pos + 1;
      return !node.isTextblock;
    });
    if (target === null) return false;
    e.view.dispatch(e.view.state.tr.setSelection(TextSelection.create(e.view.state.doc, target)));
    return keptOf(e).size === 0;
  };
  // From an empty Redo, Ctrl+Z k times, then Redo until none is left, with no batch between: the
  // same document. A Redo can take two steps when one of them now changes nothing (a peer wrote
  // the key it set since), so the Redos are not counted.
  const chain = (e: Editor, when: string) => {
    if (e.history.canRedo() || !release(e)) return null;
    const start = e.view.state.doc;
    let ran = 0;
    const k = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < k; i++) {
      const bad = differs(e, `${when}, Undo ${i}`);
      if (bad) return bad;
      if (stepHistory(e, "undo")) ran++;
    }
    for (let i = 0; e.history.canRedo(); i++) {
      if (!stepHistory(e, "redo") && i === 0 && ran > 0) return `${when}: no Redo after ${ran} Undos`;
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
    if (!release(e)) return null;
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
      if (!stepHistory(e, "undo")) return `${when} [${names}]: Undo ${i} found nothing`;
    const undone = compare(start, `${steps} Undos`);
    if (undone) return undone;
    for (let i = 0; i < steps; i++)
      if (!stepHistory(e, "redo")) return `${when} [${names}]: Redo ${i} found nothing`;
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
        stepHistory(who, "redo");
      } else if (roll < 0.25) {
        name = "chain";
        const bad = chain(who, `step ${step} (chain)`);
        if (bad) return bad;
      } else if (roll < 0.29) {
        name = "burst";
        const bad = burst(who, `step ${step} (burst)`);
        if (bad) return bad;
      } else if (roll < 0.33) {
        // A click: the caret goes elsewhere, leaving any block it kept.
        name = "click";
        const { state: s } = who.view;
        who.view.dispatch(s.tr.setSelection(TextSelection.create(s.doc, inside(pick(textblocks(s.doc))))));
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
      // A whole batch, or one doc's ops alone (the structure before its text, or after).
      const part = () => {
        if (rand() < 0.7) return undefined;
        const keys = [STRUCTURE_KEY, ...a.docs.texts.keys(), ...b.docs.texts.keys()];
        return [pick(keys)];
      };
      if (rand() < 0.4) sync(a, b, part());
      if (rand() < 0.4) sync(b, a, part());
      for (const e of [a, b]) {
        const bad = differs(e, `step ${step} (${name}), after a batch`);
        if (bad) return bad;
      }
    }
    // Restores written on an import go out with the next batch: exchange until nothing moves.
    for (let round = 0; round < 4; round++) {
      sync(a, b);
      sync(b, a);
    }
    if (!readProseMirror(a.docs, schema).eq(readProseMirror(b.docs, schema)))
      return "the copies read differently after a full exchange";
    // Nothing typed is lost: a removal that stands read every forward write of each editor into a
    // text doc under the block.
    const view = new StructureView(a.docs);
    for (const id of view.ids) {
      const removal = removalOf(view.value("order", id));
      if (!removal) continue;
      for (const key of view.textKeysUnder(id))
        for (const e of [a, b]) {
          const typedTo = e.typed.get(key) ?? 0;
          const read = removal.seen.get(key)?.get(e.docs.peer) ?? 0;
          if (typedTo > read)
            return `${id} stands removed without reading ${e.name}'s typing in ${key} (${read} < ${typedTo})`;
        }
    }
    return differs(a, "end") ?? differs(b, "end");
  } finally {
    a.destroy();
    b.destroy();
    for (const docs of owned) docs.free();
  }
}

/**
 * Typing that races a removal of its block (design §1, "Removed blocks"): A removes a block while
 * B types into it, and the batches cross. Nothing B typed may go out of view, a removal that read
 * the typing stands, and B's caret keeps a block removed under it until B types there or moves
 * away. Each case starts a room of its own and ends with every editor equal to its docs (plus what
 * it keeps) and to the others.
 */
function racedRemovals(): string[] {
  const p = (id: string, text: string) => schema.nodes.paragraph.create({ id }, schema.text(text));
  const cell = (id: string, text: string) =>
    schema.nodes.table_cell.create({ id }, [p(`${id}p`, text)]);
  const table = schema.nodes.table.create({ id: "t" }, [
    schema.nodes.table_row.create({ id: "r1" }, [cell("c1", "Cell one."), cell("c2", "Cell two.")]),
    schema.nodes.table_row.create({ id: "r2" }, [cell("c3", "Cell three."), cell("c4", "Cell four.")]),
  ]);
  const panel = schema.nodes.jsx_container.create({ id: "c", name: "Panel" }, [
    p("i1", "Inner one."),
    p("i2", "Inner two."),
  ]);
  const start = () => [p("a", "First."), p("x", "Delete-target before after."), table, p("z", "Last."), panel];

  type Room = { a: Editor; b: Editor; editors: Editor[]; third(): Editor; agent(): RoomDocs; free(): void };
  const room = (): Room => {
    const seed = RoomDocs.create(shape, freshPeerId());
    writeProseMirror(seed, schema.topNodeType.create(null, start()));
    const copies: RoomDocs[] = [seed];
    const copy = () => {
      const docs = RoomDocs.create(shape, freshPeerId());
      docs.importBatch(seed.exportSince());
      copies.push(docs);
      return docs;
    };
    const made: (Editor & { destroy(): void })[] = [editor("A", copy()), editor("B", copy())];
    const r: Room = {
      a: made[0],
      b: made[1],
      editors: made,
      third: () => {
        const c = editor("C", copy());
        made.push(c);
        return c;
      },
      // A server copy the agent writes through: what A's copy holds now.
      agent: () => {
        const docs = RoomDocs.create(shape, freshPeerId());
        docs.importBatch(r.a.docs.exportSince());
        copies.push(docs);
        return docs;
      },
      free: () => {
        for (const e of made) e.destroy();
        for (const docs of copies) docs.free();
      },
    };
    return r;
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
  const away = (e: Editor) => caret(e, "a", 0);
  const remove = (e: Editor, id: string) => {
    const at = posOf(e, id);
    const { state } = e.view;
    e.view.dispatch(state.tr.delete(at, at + (state.doc.nodeAt(at) as Node).nodeSize));
    e.history.endStep();
  };
  /** One transaction per key, as ProseMirror makes for typed text. */
  const type = (e: Editor, text: string) => {
    for (const ch of text) e.view.dispatch(e.view.state.tr.insertText(ch));
    e.history.endStep();
  };
  /** Send `from`'s docs (from an agent's copy, or an editor's) to `to`. */
  const send = (from: RoomDocs, to: Editor) => {
    const batch = from.exportSince(to.docs.version());
    if (batch.size > 0) importRemoteUpdate(to.docs, encodeEnvelope(batch), () => {});
  };
  const text = (doc: Node) => doc.textBetween(0, doc.content.size, "|");
  const shown = (e: Editor) => text(e.view.state.doc);
  /** What the docs read as, without the blocks the editor keeps. */
  const reads = (e: Editor) => text(readProseMirror(e.docs, schema));
  const syncAll = (r: Room) => {
    for (let round = 0; round < 3; round++)
      for (const from of r.editors) for (const to of r.editors) if (from !== to) sync(from, to);
  };
  const settle = (r: Room, name: string, ...wants: ((text: string) => string | null)[]) => {
    syncAll(r);
    for (const e of r.editors) {
      const bad = differs(e, `${name} (${e.name})`) ?? wants.map((want) => want(shown(e))).find(Boolean);
      if (bad) return `${name}: ${e.name} ${bad}`;
    }
    return r.editors.every((e) => shown(e) === shown(r.a)) ? null : `${name}: the editors differ`;
  };
  const showsAll = (...parts: string[]) => (text: string) =>
    parts.every((part) => text.includes(part)) ? null : `shows "${text}", wanted ${parts.join(", ")}`;
  const showsNone = (...parts: string[]) => (text: string) =>
    parts.some((part) => text.includes(part)) ? `shows "${text}", wanted none of ${parts.join(", ")}` : null;
  /** B's caret rests in a block A removed: B shows it, its docs do not. */
  const keeps = (e: Editor, part: string, when: string) =>
    shown(e).includes(part) && !reads(e).includes(part) && keptOf(e).size > 0
      ? differs(e, when)
      : `${when}: ${e.name} shows "${shown(e)}" (kept ${[...keptOf(e)]}), its docs read "${reads(e)}"`;

  const cases: Record<string, (r: Room) => string | null> = {
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
    // The restore is in nobody's Undo history: the typist's Ctrl+Z takes the typing and leaves
    // the block.
    "the typer's Ctrl+Z keeps the block, without the typing": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      type(r.b, "[remote-edit]");
      sync(r.a, r.b);
      if (!shown(r.b).includes("[remote-edit]")) return `Ctrl+Z case: B lost its typing: ${shown(r.b)}`;
      runHistory(r.b, "undo");
      return settle(r, "the typer's Ctrl+Z keeps the block", showsAll("Delete-target before after."), showsNone("[remote-edit]"));
    },
    "a removal that read the typing stands": (r) => {
      caret(r.b, "x", 14);
      type(r.b, "[remote-edit]");
      sync(r.b, r.a);
      remove(r.a, "x");
      sync(r.a, r.b);
      const kept = keeps(r.b, "Delete-target [remote-edit]", "read case");
      if (kept) return kept;
      away(r.b);
      return settle(r, "a removal that read the typing stands", showsNone("Delete-target", "[remote-edit]"));
    },
    "a restored block removed again stays removed": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      type(r.b, "[remote-edit]");
      sync(r.a, r.b);
      sync(r.b, r.a);
      remove(r.a, "x");
      sync(r.a, r.b);
      away(r.b);
      return settle(r, "a restored block removed again stays removed", showsNone("[remote-edit]"));
    },
    "typing in a cell brings its removed table back": (r) => {
      caret(r.b, "c3p", 5);
      remove(r.a, "t");
      type(r.b, "[in-cell]");
      return settle(r, "typing in a cell brings its removed table back", showsAll("Cell [in-cell]three.", "Cell one."));
    },
    // Seed 85's failure: A's Enter cuts a word typed in one block, B joins the halves back (a copy
    // of A's half is B's text now), and B's Undo of the join gives the halves back. Both stay on
    // screen; the word is not whole again, which the random check once read as B's Undo taking it.
    "an Undo of a join of a split word keeps both halves": (r) => {
      caret(r.a, "x", 0);
      type(r.a, "qA163");
      sync(r.a, r.b);
      const at = posOf(r.a, "x") + 1 + 2;
      r.a.view.dispatch(
        r.a.view.state.tr.split(at, 1, [{ type: schema.nodes.paragraph, attrs: { id: "x2" } }]),
      );
      r.a.history.endStep();
      sync(r.a, r.b);
      r.b.view.dispatch(r.b.view.state.tr.join(posOf(r.b, "x2")));
      r.b.history.endStep();
      if (!shown(r.b).includes("qA163")) return `join case: the join did not make the word: ${shown(r.b)}`;
      runHistory(r.b, "undo");
      return settle(r, "an Undo of a join of a split word keeps both halves", showsAll("qA|163"));
    },
    // The usual online case (a phase 1 prober's 120 ms typing): the removal reaches B between two
    // of its keys. B's caret keeps the block on screen, and B's next keys bring it back.
    "typing after the removal arrived": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      sync(r.a, r.b);
      const kept = keeps(r.b, "Delete-target", "arrival case");
      if (kept) return kept;
      type(r.b, "[second]");
      return settle(r, "typing after the removal arrived", showsAll("Delete-target [second]before"));
    },
    "a removal that read the first keys, then the rest": (r) => {
      caret(r.b, "x", 14);
      type(r.b, "[sec");
      sync(r.b, r.a);
      remove(r.a, "x");
      sync(r.a, r.b);
      const kept = keeps(r.b, "Delete-target [sec", "first keys case");
      if (kept) return kept;
      type(r.b, "ond]");
      return settle(r, "a removal that read the first keys, then the rest", showsAll("Delete-target [second]before"));
    },
    "Ctrl+Z of typing into a removed block keeps the block": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      sync(r.a, r.b);
      type(r.b, "[second]");
      runHistory(r.b, "undo");
      return settle(r, "Ctrl+Z of typing into a removed block", showsAll("Delete-target before after."), showsNone("[second]"));
    },
    "a caret that moved on types where it is": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      sync(r.a, r.b);
      caret(r.b, "a", 2);
      type(r.b, "[moved]");
      return settle(r, "a caret that moved on types where it is", showsAll("Fi[moved]rst."), showsNone("Delete-target"));
    },
    "the selection leaving a kept block takes it off the screen": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      sync(r.a, r.b);
      const kept = keeps(r.b, "Delete-target", "leaving case");
      if (kept) return kept;
      caret(r.b, "z", 1);
      if (shown(r.b).includes("Delete-target") || keptOf(r.b).size > 0)
        return `leaving case: B still shows "${shown(r.b)}"`;
      if (r.b.view.state.selection.$head.parent.attrs.id !== "z") return "leaving case: B's caret is not in z";
      return settle(r, "the selection leaving a kept block", showsNone("Delete-target"));
    },
    // An IME commit is one transaction inserting the composed text where the caret is.
    "an IME commit in a kept block brings it back": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      sync(r.a, r.b);
      r.b.view.dispatch(r.b.view.state.tr.insertText("中文"));
      r.b.history.endStep();
      return settle(r, "an IME commit in a kept block", showsAll("Delete-target 中文before"));
    },
    "a paste in a kept block brings it back": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      sync(r.a, r.b);
      const slice = new Slice(Fragment.fromArray([p("x8", "pasted one"), p("x9", "pasted two")]), 1, 1);
      r.b.view.dispatch(r.b.view.state.tr.replaceSelection(slice));
      r.b.history.endStep();
      return settle(r, "a paste in a kept block", showsAll("Delete-target pasted one|pasted twobefore after."));
    },
    "a Backspace in a kept block brings it back": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      sync(r.a, r.b);
      const { head } = r.b.view.state.selection;
      r.b.view.dispatch(r.b.view.state.tr.delete(head - 1, head));
      r.b.history.endStep();
      return settle(r, "a Backspace in a kept block", showsAll("First.|Delete-targetbefore after."));
    },
    "an Enter in a kept block brings it back": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      sync(r.a, r.b);
      const { head } = r.b.view.state.selection;
      r.b.view.dispatch(
        r.b.view.state.tr.split(head, 1, [{ type: schema.nodes.paragraph, attrs: { id: "x2" } }]),
      );
      r.b.history.endStep();
      return settle(r, "an Enter in a kept block", showsAll("Delete-target |before after."));
    },
    // The model's S3 and S4: a Redo replays the first removal's record, which B's typing since
    // would answer; the Redo writes it again with what A reads now.
    "Redo of a delete after the peer typed stands, and Undo after it brings the block back": (r) => {
      remove(r.a, "x");
      sync(r.a, r.b);
      runHistory(r.a, "undo");
      sync(r.a, r.b);
      caret(r.b, "x", 14);
      type(r.b, " more");
      sync(r.b, r.a);
      runHistory(r.a, "redo");
      if (shown(r.a).includes("Delete-target")) return `Redo case: A still shows "${shown(r.a)}"`;
      sync(r.a, r.b);
      away(r.b);
      const redone = settle(r, "Redo of a delete after the peer typed", showsNone("Delete-target"));
      if (redone) return redone;
      runHistory(r.a, "undo");
      const undone = settle(r, "Undo after that Redo", showsAll("Delete-target  morebefore after."));
      if (undone) return undone;
      runHistory(r.a, "redo");
      return settle(r, "Redo again", showsNone("Delete-target"));
    },
    // The model's S4b: Redo items under a re-stamped removal survive it.
    "two levels of Undo and Redo around a delete": (r) => {
      caret(r.a, "a", 2);
      type(r.a, "x");
      remove(r.a, "x");
      remove(r.a, "t");
      const after = shown(r.a);
      for (let i = 0; i < 3; i++) runHistory(r.a, "undo");
      const before = shown(r.a);
      if (before !== text(schema.topNodeType.create(null, start())))
        return `two levels: 3 Undos gave "${before}"`;
      for (let i = 0; i < 3; i++) runHistory(r.a, "redo");
      if (shown(r.a) !== after) return `two levels: 3 Redos gave "${shown(r.a)}", wanted "${after}"`;
      return settle(r, "two levels of Undo and Redo", showsNone("Delete-target", "Cell one."));
    },
    // The model's S5: B's Ctrl+Z in a block a removal read changes hidden text, and a later batch
    // that removes something else does not bring the block back.
    "Ctrl+Z of typing in a block a peer removed, then an unrelated batch": (r) => {
      caret(r.b, "x", 14);
      type(r.b, "foo");
      sync(r.b, r.a);
      remove(r.a, "x");
      sync(r.a, r.b);
      runHistory(r.b, "undo");
      if (shown(r.b).includes("foo")) return `S5: B's Undo left "${shown(r.b)}"`;
      remove(r.a, "z");
      sync(r.a, r.b);
      if (reads(r.b).includes("Delete-target")) return `S5: the batch brought the block back: ${reads(r.b)}`;
      away(r.b);
      const settled = settle(r, "Ctrl+Z then an unrelated batch", showsNone("Delete-target", "Last."));
      if (settled) return settled;
      runHistory(r.b, "redo");
      const typed = inText(r.b.docs.textOf("x") as never, (t) => t.toString());
      if (!typed.includes("foo")) return `S5: B's Redo did not give foo back: ${typed}`;
      return settle(r, "Redo in a removed block", showsNone("Delete-target"));
    },
    // Review p18966: an agent's text op in a cell of a table B's typing brought back.
    "an agent's text op inside a restored table keeps it": (r) => {
      caret(r.b, "c3p", 5);
      remove(r.a, "t");
      type(r.b, "XY");
      const restored = settle(r, "agent text case, restored", showsAll("Cell XYthree."));
      if (restored) return restored;
      const agent = r.agent();
      const ok = applyOps(agent, [{ kind: "text", block: "c3p", splices: [{ from: 5, to: 7, content: [] }], formats: [] }]);
      if (!ok.ok) return `agent text case: ${ok.message}`;
      for (const e of r.editors) send(agent, e);
      const written = settle(r, "agent text case", showsAll("Cell three.", "Cell one."));
      if (written) return written;
      runHistory(r.b, "undo");
      return settle(r, "agent text case, B's Ctrl+Z", showsAll("Cell three.", "Cell one."));
    },
    // Review p18965: an agent deletes a sibling in a container B's typing brought back; B's Ctrl+Z
    // of the typing then leaves the container.
    "an agent's delete inside a restored container keeps it, through the typist's Ctrl+Z": (r) => {
      caret(r.b, "i1", 10);
      remove(r.a, "c");
      type(r.b, "X");
      const restored = settle(r, "agent delete case, restored", showsAll("Inner one.X|Inner two."));
      if (restored) return restored;
      const agent = r.agent();
      const ok = applyOps(agent, [{ kind: "delete", block: "i2" }]);
      if (!ok.ok) return `agent delete case: ${ok.message}`;
      for (const e of r.editors) send(agent, e);
      runHistory(r.b, "undo");
      return settle(r, "agent delete case, B's Ctrl+Z", showsAll("Inner one."), showsNone("Inner two.", "Inner one.X"));
    },
    "typing in a cell of a removed table with the caret kept there": (r) => {
      caret(r.b, "c3p", 5);
      remove(r.a, "t");
      sync(r.a, r.b);
      const kept = keeps(r.b, "Cell three.", "kept table case");
      if (kept) return kept;
      type(r.b, "[k]");
      return settle(r, "typing in a kept table's cell", showsAll("Cell [k]three.", "Cell one."));
    },
    // Two kept blocks on the caret's path: its paragraph removed by A, its table by C.
    "the caret's paragraph removed, then its table by another peer, then typing": (r) => {
      const c = r.third();
      caret(r.b, "c3p", 5);
      // The cell's one paragraph goes: the cell shows its unstored empty one.
      const at = posOf(r.a, "c3p");
      const { state } = r.a.view;
      const empty = schema.nodes.paragraph.create({ id: "c3/empty" });
      r.a.view.dispatch(state.tr.replaceWith(at, at + (state.doc.nodeAt(at) as Node).nodeSize, empty));
      r.a.history.endStep();
      sync(r.a, r.b);
      remove(c, "t");
      sync(c, r.b);
      if (keptOf(r.b).size !== 2) return `two kept: B keeps ${[...keptOf(r.b)]}`;
      const kept = keeps(r.b, "Cell three.", "two kept case");
      if (kept) return kept;
      type(r.b, "[k]");
      return settle(r, "typing under two removals", showsAll("Cell [k]three.", "Cell one."));
    },
    // An upload finishing or a chip respelled: untracked writes elsewhere while the caret rests.
    // The kept block stays removed in the docs and on B's screen, neither removed again nor
    // written as new, also when the write reorders its siblings.
    "an untracked write elsewhere while a block is kept": (r) => {
      caret(r.b, "x", 14);
      remove(r.a, "x");
      sync(r.a, r.b);
      const z = posOf(r.b, "z");
      r.b.view.dispatch(r.b.view.state.tr.setNodeAttribute(z, "level", 2).setMeta("addToHistory", false));
      const { state } = r.b.view;
      const at = posOf(r.b, "z");
      const node = state.doc.nodeAt(at) as Node;
      r.b.view.dispatch(state.tr.delete(at, at + node.nodeSize).insert(0, node).setMeta("addToHistory", false));
      const kept = keeps(r.b, "Delete-target", "untracked case");
      if (kept) return kept;
      if (!removalOf(new StructureView(r.b.docs).value("order", "x"))) return "untracked case: x is not removed";
      sync(r.b, r.a);
      if (shown(r.a).includes("Delete-target")) return `untracked case: A shows "${shown(r.a)}"`;
      away(r.b);
      return settle(r, "an untracked write elsewhere", showsNone("Delete-target"), (t) =>
        t.startsWith("Last.|First.") ? null : `shows "${t}", wanted the move`,
      );
    },
  };
  const failures: string[] = [];
  for (const [name, run] of Object.entries(cases)) {
    const r = room();
    try {
      const bad = run(r);
      if (bad) failures.push(bad);
    } catch (error) {
      failures.push(`${name}: threw ${(error as Error).stack}`);
    } finally {
      r.free();
    }
  }
  return failures;
}

// WASM memory only grows: a copy of Loro's that frees every handle stops growing once the probe's
// largest document has fit, a leak grows with every seed.
const wasmMemory = (
  createRequire(import.meta.url)(
    join(dirname(createRequire(import.meta.url).resolve("loro-crdt")), "loro_wasm.js"),
  ) as { __wasm: { memory: WebAssembly.Memory } }
).__wasm.memory;
const wasmBytes = () => wasmMemory.buffer.byteLength;
const memEvery = Number(process.env.MEM_EVERY ?? 0) || Number.POSITIVE_INFINITY;

let failed = 0;
for (const failure of racedRemovals()) {
  failed++;
  process.stderr.write(`FAIL raced removal: ${failure}\n`);
}
for (let seed = first; seed < first + seeds; seed++) {
  const failure = run(seed);
  if (failure) {
    failed++;
    process.stderr.write(`FAIL seed ${seed}: ${failure}\n`);
  }
  if (seed % memEvery === 0) {
    const { rss } = process.memoryUsage();
    process.stderr.write(
      `[mem] seed ${seed}: WASM ${(wasmBytes() / 2 ** 20).toFixed(0)} MB, process ${(rss / 2 ** 20).toFixed(0)} MB\n`,
    );
  }
}
if (process.env.HANDLES && unfreed.size > 0) {
  failed++;
  const groups = new Map<string, number>();
  for (const where of unfreed.values()) groups.set(where, (groups.get(where) ?? 0) + 1);
  for (const [where, n] of groups) process.stderr.write(`FAIL unfreed handles: ${n} × ${where}\n`);
}
process.stdout.write(
  failed ? `${failed} failed\n` : `ok: raced removals, ${seeds} seeds × ${steps} steps from ${first}\n`,
);
process.exitCode = failed ? 1 : 0;

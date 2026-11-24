/**
 * Two editors probe (`two-editors.md`). Run from the repo root:
 *   pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/two-editors.probe.ts [seeds] [steps]
 * Two editors on two copies of one room make random structural edits, Ctrl+Z and Redo, and
 * exchange batches at random, whole or one doc at a time. After every step each editor must equal
 * a full read of its docs plus the blocks it keeps for its caret; an Undo or Redo must leave no
 * half a block, show no word twice, keep every word the other editor typed, and bring back no
 * word nor undo no mark a peer's edit changed; an Undo chain followed by as many Redos must give
 * back the docs' read exactly; and at the end the copies must read alike and no removal may stand
 * that did not read an editor's typing in the block. Exits non-zero on the first failure,
 * printing the block that differs.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  applyBlocks,
  applyOps,
  changedBlocks,
  type DocKey,
  encodeEnvelope,
  freshPeerId,
  inText,
  docVersion,
  editSince,
  encodeRoomVersion,
  isOrderKey,
  removalOf,
  RoomDocs,
  STRUCTURE_KEY,
  StructureView,
  setCommentBody,
  undoEdits,
  undoPress,
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

/** The histories' clock stands still: typing joins a step until the probe ends it, on any machine. */
const clock = () => 1_700_000_000_000;

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

let made = 0;
const madeId = () => `n${(made++).toString(36)}`;

/**
 * An editor with the binding and its Undo on `docs`, started from what they read. `fresh` gives
 * the ids the binding stores an empty container's paragraph under: a seed passes its own, so it
 * replays exactly.
 */
function editor(name: string, docs: RoomDocs, fresh: () => string = madeId): Editor & { destroy(): void } {
  const history = new UndoHistory(docs, { now: clock });
  const typed = new Map<DocKey, number>();
  const plugin = loroSyncPlugin({
    docs,
    history,
    newBlockId: fresh,
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

/** Whether the last history run wrote a text doc. */
let wroteText = false;
/** Undo chains a peer's write since made come back different, with no word lost. */
let chainsOverPeers = 0;
/**
 * Undo chains whose Redo deleted again words its step had deleted, after a peer's move brought
 * them back (seeds 23, 236): the Ctrl+Z wrote over the move, and the Redo over it.
 */
let redeleted = 0;
/** Undos and Redos that brought back a word a peer deleted, or a mark a peer changed. */
let overPeers = 0;
/** Undos and Redos that showed a word more times than it had shown. */
let shownTwice = 0;
/**
 * Ctrl+Z or Redo as the app runs it: publish nothing, re-read the changed docs, put the selection
 * back. Whether a step ran.
 */
function runHistory(e: Editor, direction: "undo" | "redo"): boolean {
  const ran = direction === "undo" ? e.history.undo(e.view.state) : e.history.redo(e.view.state);
  wroteText = ran?.changes.some((change) => change.key !== STRUCTURE_KEY) ?? false;
  const selection = ran?.selection;
  if (!ran || !selection) return false;
  notifyChanged(
    e.docs,
    ran.changes.map((change) => change.key),
  );
  const { doc } = e.view.state;
  const at = (end: typeof selection.anchor) => end && resolveCursor(e.docs, doc, end);
  const anchor = at(selection.anchor);
  const head = at(selection.head) ?? anchor;
  if (anchor != null && head != null)
    e.view.dispatch(
      e.view.state.tr
        .setSelection(TextSelection.create(doc, anchor, head))
        .setMeta("addToHistory", false),
    );
  return true;
}

/** The app's block-id fixer, simplified: a block with no id or a taken one gets a fresh one. */
function fixBlockIds(tr: Transaction, fresh: () => string): Transaction {
  const seen = new Set<string>();
  tr.doc.descendants((node, pos) => {
    if (node.isBlock && node.type.spec.attrs?.id) {
      const value = node.attrs.id;
      if (typeof value !== "string" || seen.has(value)) tr.setNodeAttribute(pos, "id", fresh());
      else seen.add(value);
    }
    return !node.isTextblock;
  });
  return tr;
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
  const fixIds = (tr: Transaction) => fixBlockIds(tr, id);
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
  const a = editor("A", copy(), id);
  const b = editor("B", copy(), id);
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
  class Bad extends Error {}
  /** The typed words a copy's docs read as (what every screen shows), with how often each shows. */
  const tokens = (e: Editor) => {
    const doc = readProseMirror(e.docs, schema);
    const out = new Map<string, number>();
    for (const [word] of doc.textBetween(0, doc.content.size, "|").matchAll(/q[AB]\d+/g))
      out.set(word, (out.get(word) ?? 0) + 1);
    return out;
  };
  const peak = { A: new Map<string, number>(), B: new Map<string, number>() };
  /** Per editor, the other's words typed while it had a Redo. */
  const sinceRedo = { A: new Set<string>(), B: new Set<string>() };
  /**
   * Each typed word the editor shows (its caret's kept blocks too: the writer sees them), with the
   * marks any of its characters carry; and each place it shows, by block and occurrence in it
   * (a split undone leaves a copy of the words in two blocks), with that place's marks.
   */
  const wordMarks = (e: Editor) => {
    const out = new Map<string, Set<string>>();
    const placed = new Map<string, Set<string>>();
    e.view.state.doc.descendants((node) => {
      if (!node.isTextblock) return true;
      let text = "";
      const marks: string[][] = [];
      node.forEach((child) => {
        const piece = child.isText ? (child.text as string) : "\ufffc";
        text += piece;
        const names = child.marks.map((mark) => mark.type.name).filter((name) => name !== "comment");
        for (let k = 0; k < piece.length; k++) marks.push(names);
      });
      const seen = new Map<string, number>();
      for (const match of text.matchAll(/q[AB]\d+/g)) {
        const word = match[0];
        const here = new Set<string>();
        for (let k = match.index; k < match.index + word.length; k++) for (const name of marks[k]) here.add(name);
        out.set(word, new Set([...(out.get(word) ?? []), ...here]));
        const nth = seen.get(word) ?? 0;
        seen.set(word, nth + 1);
        placed.set(`${node.attrs.id}\u0000${word}\u0000${nth}`, here);
      }
      return false;
    });
    return { marks: out, placed };
  };
  /** Who changed a word on a screen: the editor's own edit, a peer's, both merged, or a Ctrl+Z. */
  type Source = "own" | "peer" | "merge" | "run";
  /** Per editor: the words it shows, what last took each word off its screen, and each mark. */
  const screens = new Map<
    string,
    { words: ReturnType<typeof wordMarks>; left: Map<string, Source>; marked: Map<string, Source> }
  >();
  /**
   * What changed on `e`'s screen since it was last looked at, and who did it. A Ctrl+Z or Redo
   * that brings back a word a peer's edit took away, or undoes a peer's mark on a word, ran over
   * the peer's write (design §2: last writer wins) and is counted. A change
   * a batch from `peer` made is the peer's when the peer's screen shows it too; otherwise it came
   * of the two copies' edits meeting (a block moved into a container the other removed).
   */
  const observe = (e: Editor, source: Source, peer?: Editor) => {
    const screen = screens.get(e.name) ?? {
      words: { marks: new Map(), placed: new Map() },
      left: new Map(),
      marked: new Map(),
    };
    screens.set(e.name, screen);
    const now = wordMarks(e);
    const peerSees = peer && wordMarks(peer);
    const theirs = peerSees?.marks;
    const what = `${e.name}'s ${source === "run" ? "Undo or Redo" : source}`;
    for (const word of screen.words.marks.keys())
      if (!now.marks.has(word)) screen.left.set(word, theirs?.has(word) ? "merge" : source);
    for (const word of now.marks.keys()) {
      if (screen.words.marks.has(word)) continue;
      if (source === "run" && screen.left.get(word) === "peer") overPeers++;
      screen.left.delete(word);
    }
    // Marks are judged per place, not per word: a word in two places (seed 1098 at 200 400 900,
    // a split undone) shows each place's own marks, and a peer unbolding one place says nothing
    // about A's Undo rebolding the other. A place coming or going is no one marking.
    for (const [place, marks] of now.placed) {
      const was = screen.words.placed.get(place);
      if (!was) continue;
      const word = place.split("\u0000")[1];
      for (const name of new Set([...was, ...marks])) {
        if (was.has(name) === marks.has(name)) continue;
        if (source === "run" && screen.marked.get(`${place}\u0000${name}`) === "peer") overPeers++;
        const same = peerSees && peerSees.placed.get(place)?.has(name) === marks.has(name);
        screen.marked.set(`${place}\u0000${name}`, peerSees && !same ? "merge" : source);
      }
    }
    screen.words = now;
  };
  /** A block with a place in the order but no node or no parent: half of a block. */
  const dangling = (e: Editor) => {
    const view = new StructureView(e.docs);
    for (const id of view.ids)
      if (isOrderKey(view.value("order", id)) && (view.value("node", id) === undefined || view.value("parent", id) === undefined))
        return `${id} with an order key, node ${view.value("node", id)}, parent ${view.value("parent", id)}`;
    return null;
  };
  const typeWord = (name: string) => {
    const word = `q${name}${n++}`;
    typed[name as "A" | "B"].add(word);
    const reader = name === "A" ? b : a;
    if (reader.history.canRedo()) sinceRedo[reader.name as "A" | "B"].add(word);
    return word;
  };
  const edits: Record<string, (e: Editor) => Transaction | null> = {
    type: ({ name, view: { state: s } }) => {
      // Between words, as Enter and paste cut: typing inside a word would read as deleting it.
      return s.tr.insertText(` ${typeWord(name)} `, between(pick(textblocks(s.doc))));
    },
    // A paragraph of the editor's words in a container, which the other may just have made: its
    // Undo of that container must leave these words on screen.
    nest: ({ name, view: { state: s } }) => {
      const boxes: Place[] = [];
      s.doc.descendants((node, pos) => {
        if (node.type.name === "jsx_container" || node.type.name === "table_cell") boxes.push({ node, pos });
        return !node.isTextblock;
      });
      if (boxes.length === 0) return null;
      const box = pick(boxes);
      const block = schema.nodes.paragraph.create({ id: id() }, schema.text(typeWord(name)));
      return s.tr.insert(box.pos + box.node.nodeSize - 1, block);
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
    const before = tokens(e);
    if (process.env.TRACE) { const d = readProseMirror(e.docs, schema); process.stderr.write(`   ${e.name} ${direction} from: ${d.textBetween(0, d.content.size, "|")}\n`); }
    const ran = runHistory(e, direction);
    if (process.env.TRACE) { const d = readProseMirror(e.docs, schema); process.stderr.write(`   ${e.name} ${direction}   to: ${d.textBetween(0, d.content.size, "|")}\n`); }
    const now = words(e);
    for (const word of typed[e.name as "A" | "B"]) if (!now.includes(word)) typed[e.name as "A" | "B"].delete(word);
    const after = tokens(e);
    const what = `${e.name}'s ${direction === "undo" ? "Undo" : "Redo"}`;
    const torn = dangling(e);
    if (torn) throw new Bad(`${what} left ${torn}`);
    // A word that shows twice where it showed once is counted, not failed (design §2: an Undo
    // over a peer's Join can show text twice). A run that wrote no text only put blocks back as
    // they were (the Undo of a delete): a copy of their text a peer's Join made is not this run's.
    for (const [word, n] of after)
      if (wroteText && n > 1 && n > (before.get(word) ?? 0) && n > (peak[e.name as "A" | "B"].get(word) ?? 0))
        shownTwice++;
    // Nothing the other editor typed leaves the screen: by an Undo, none of its words; by a Redo
    // (which may delete a block again, with the words it had), none typed since this editor's
    // Redo was last empty.
    const other = e.name === "A" ? "B" : "A";
    for (const word of direction === "undo" ? typed[other] : sinceRedo[e.name as "A" | "B"])
      if (typed[other].has(word) && before.has(word) && !after.has(word))
        throw new Bad(`${what} took ${word} off the screen`);
    observe(e, "run");
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
    // A kept block leaving the screen is the peer's removal taking effect, unless the peer still
    // shows it (two edits met: a block moved into one this editor removed).
    observe(e, "peer", e === a ? b : a);
    return keptOf(e).size === 0;
  };
  /** The typed words `e` shows. */
  const shownWords = (e: Editor) => {
    const { doc } = e.view.state;
    return new Set([...doc.textBetween(0, doc.content.size, "|").matchAll(/q[AB]\d+/g)].map(([word]) => word));
  };
  /** The id of `e`'s newest Undo step: the probe reads the history's own steps to tell them apart. */
  const newestStep = (e: Editor) =>
    `${e.name}${(e.history as unknown as { undoSteps: { id: number }[] }).undoSteps.at(-1)?.id}`;
  /** Per step, the typed words its editor showed as it wrote it. */
  const stepSaw = new Map<string, Set<string>>();
  /** A local edit, noting what its editor showed as the step took it. */
  const write = (e: Editor, tr: Transaction) => {
    const saw = shownWords(e);
    e.view.dispatch(fixIds(tr));
    const step = newestStep(e);
    stepSaw.set(step, new Set([...(stepSaw.get(step) ?? []), ...saw]));
  };
  // From an empty Redo, Ctrl+Z k times, then Redo until none is left, with no batch between: the
  // same document. A Redo can take two steps when one of them now changes nothing (a peer deleted
  // the text it puts back), so the Redos are not counted.
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
    // Words a Redo took off the screen that its step's editor saw when it wrote the step: the
    // step deleted them, and the Redo deletes them again.
    const redone = new Set<string>();
    for (let i = 0; e.history.canRedo(); i++) {
      const before = shownWords(e);
      if (!stepHistory(e, "redo") && i === 0 && ran > 0) return `${when}: no Redo after ${ran} Undos`;
      const saw = stepSaw.get(newestStep(e)) ?? new Set();
      const after = shownWords(e);
      for (const word of before) if (!after.has(word) && saw.has(word)) redone.add(word);
      const bad = differs(e, `${when}, Redo ${i}`);
      if (bad) return bad;
    }
    if (start.eq(e.view.state.doc)) return null;
    // A step a peer wrote over since goes back over it and comes again over the peer's write
    // (design §2: last writer wins), so the document can differ: no word typed goes, and a
    // block both show reads the same.
    const blocks = (doc: Node) => {
      const out = new Map<string, string>();
      doc.descendants((node) => {
        if (node.isTextblock) out.set(node.attrs.id, node.textContent);
      });
      return out;
    };
    const was = blocks(start);
    const now = blocks(e.view.state.doc);
    const all = (map: Map<string, string>) => [...map.values()].join("|");
    const gone = [...all(was).matchAll(/q[AB]\d+/g)].map(([word]) => word).filter((word) => !all(now).includes(word));
    const lost = gone.filter((word) => !redone.has(word));
    const changed = [...was].filter(([id, text]) => now.has(id) && now.get(id) !== text);
    if (lost.length === 0 && changed.length === 0) {
      if (gone.length > 0) redeleted++;
      else chainsOverPeers++;
      return null;
    }
    if (lost.length > 0) return `${when}: ${ran} Undos and Redos lost ${lost.join(" ")}`;
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
      write(e, tr);
      // An edit that empties the Redo ends what a Redo could take off the screen since.
      if (!e.history.canRedo()) sinceRedo[e.name as "A" | "B"].clear();
      observe(e, "own");
      for (const [word, count] of tokens(e))
        if (count > (peak[e.name as "A" | "B"].get(word) ?? 0)) peak[e.name as "A" | "B"].set(word, count);
      // An edit the docs already read as (a cell emptied again) writes nothing and is no step.
      if (encodeRoomVersion(e.docs.version()).join() !== version) names.push(name);
      if (rand() < 0.7) e.history.endStep();
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
    // Each edit is at most one step (typing joins the step before it): Ctrl+Z until the document
    // is the one before the burst, then as many Redos.
    let steps = 0;
    for (; steps < names.length && !start.eq(e.view.state.doc); steps++)
      if (!stepHistory(e, "undo")) return `${when} [${names}]: Undo ${steps} found nothing`;
    const undone = compare(start, `${steps} Undos`);
    if (undone) return undone;
    for (let i = 0; i < steps; i++)
      if (!stepHistory(e, "redo")) return `${when} [${names}]: Redo ${i} found nothing`;
    return compare(end, `${steps} Redos`);
  };

  let at = 0;
  try {
    for (let step = 0; step < steps; step++) {
      at = step;
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
        observe(who, "peer", who === a ? b : a);
      } else {
        name = pick(Object.keys(edits));
        let tr: Transaction | null = null;
        try {
          tr = edits[name](who);
        } catch {
          continue; // an edit that does not fit this document
        }
        if (!tr?.docChanged) continue;
        write(who, tr);
        observe(who, "own");
        // Most edits are a step of their own; the rest join the next, as a quick burst does.
        if (rand() < 0.7) who.history.endStep();
      }
      if (process.env.TRACE) {
        const show = (e: Editor) => { const d = readProseMirror(e.docs, schema); return d.textBetween(0, d.content.size, "|"); };
        process.stderr.write(`${step} ${who.name} ${name}\n   A: ${show(a)}\n   B: ${show(b)}\n`);
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
      observe(b, "peer", a);
      if (rand() < 0.4) sync(b, a, part());
      observe(a, "peer", b);
      for (const e of [a, b]) {
        const bad = differs(e, `step ${step} (${name}), after a batch`);
        if (bad) return bad;
        const torn = dangling(e);
        if (torn) return `step ${step} (${name}): ${e.name} holds ${torn}`;
        for (const [word, count] of tokens(e))
          if (count > (peak[e.name as "A" | "B"].get(word) ?? 0)) peak[e.name as "A" | "B"].set(word, count);
        if (!e.history.canRedo()) sinceRedo[e.name as "A" | "B"].clear();
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
  } catch (error) {
    if (error instanceof Bad) return `step ${at}: ${error.message}`;
    throw error;
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
  const p = (id: string, text?: string) =>
    schema.nodes.paragraph.create({ id }, text ? schema.text(text) : undefined);
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
  /**
   * A room starting with `blocks`. `peers` fixes A's and B's peer ids, for a case that depends on
   * which of two concurrent writes wins (the higher peer at one Lamport time).
   */
  const room = (blocks: Node[] = start(), peers?: [bigint, bigint]): Room => {
    const seed = RoomDocs.create(shape, freshPeerId());
    writeProseMirror(seed, schema.topNodeType.create(null, blocks));
    const copies: RoomDocs[] = [seed];
    const ids = [...(peers ?? [])];
    const copy = () => {
      const fixed = ids.shift();
      const peer = fixed === undefined ? freshPeerId() : (((1n << 48n) + fixed).toString() as ReturnType<typeof freshPeerId>);
      const docs = RoomDocs.create(shape, peer);
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
  /** Move block `id` to just before block `before`, as a drag does: the same node, elsewhere. */
  const move = (e: Editor, id: string, before: string) => {
    const at = posOf(e, id);
    const { state } = e.view;
    const node = state.doc.nodeAt(at) as Node;
    const tr = state.tr.delete(at, at + node.nodeSize);
    e.view.dispatch(tr.insert(tr.mapping.map(posOf(e, before)), node));
    e.history.endStep();
  };
  /** Set a top block's type and attributes, as a heading or code-block command does. */
  const retype = (e: Editor, id: string, type: string, attrs: Record<string, unknown> = {}) => {
    e.view.dispatch(e.view.state.tr.setNodeMarkup(posOf(e, id), schema.nodes[type], { id, ...attrs }));
    e.history.endStep();
  };
  /** Enter in block `id` at `offset`: the tail becomes block `half`. */
  const split = (e: Editor, id: string, offset: number, half: string) => {
    e.view.dispatch(
      e.view.state.tr.split(posOf(e, id) + 1 + offset, 1, [
        { type: schema.nodes.paragraph, attrs: { id: half } },
      ]),
    );
    e.history.endStep();
  };
  const typeOf = (e: Editor, id: string) => e.view.state.doc.nodeAt(posOf(e, id))?.type.name;
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
  const once = (part: string) => (text: string) =>
    text.split(part).length === 2 ? null : `shows "${text}", wanted ${part} once`;
  const showsNone = (...parts: string[]) => (text: string) =>
    parts.some((part) => text.includes(part)) ? `shows "${text}", wanted none of ${parts.join(", ")}` : null;
  /** B's caret rests in a block A removed: B shows it, its docs do not. */
  const keeps = (e: Editor, part: string, when: string) =>
    shown(e).includes(part) && !reads(e).includes(part) && keptOf(e).size > 0
      ? differs(e, when)
      : `${when}: ${e.name} shows "${shown(e)}" (kept ${[...keptOf(e)]}), its docs read "${reads(e)}"`;

  /** A case run in the room it makes, rather than the default one. */
  type Own = { room: () => Room; run: (r: Room) => string | null };
  /** Replace container `id` with its children, as an unwrap does: they move, keeping their ids. */
  const unwrap = (e: Editor, id: string) => {
    const c = e.view.state.doc.nodeAt(posOf(e, id)) as Node;
    const at = posOf(e, id);
    e.view.dispatch(e.view.state.tr.replaceWith(at, at + c.nodeSize, c.content));
    e.history.endStep();
  };
  /** Empty container `id` to its placeholder paragraph `<id>/empty`, the one it shows when empty. */
  const emptyOut = (e: Editor, id: string) => {
    const c = e.view.state.doc.nodeAt(posOf(e, id)) as Node;
    const at = posOf(e, id);
    e.view.dispatch(e.view.state.tr.replaceWith(at + 1, at + c.nodeSize - 1, p(`${id}/empty`)));
    e.history.endStep();
  };
  /** The id of container `id`'s first child on `e`'s screen. */
  const firstIn = (e: Editor, id: string) =>
    (e.view.state.doc.nodeAt(posOf(e, id)) as Node).child(0).attrs.id as string;
  /** Every block id `e`'s docs read, in document order. */
  const readIds = (e: Editor) => {
    const ids: string[] = [];
    readProseMirror(e.docs, schema).descendants((node) => {
      if (node.isBlock) ids.push(node.attrs.id);
      return true;
    });
    return ids;
  };
  /** A block id some editor's docs read twice, or a placeholder id they store. */
  const badIds = (r: Room, when: string) => {
    for (const e of r.editors) {
      const ids = readIds(e);
      const twice = ids.find((id, k) => ids.indexOf(id) !== k);
      if (twice) return `${when}: ${e.name} reads ${twice} twice in [${ids}]`;
      const stored = ids.find((id) => id.endsWith("/empty") && new StructureView(e.docs).shown.has(id));
      if (stored) return `${when}: ${e.name} stores the placeholder id ${stored}`;
    }
    return null;
  };
  const ownRooms: Record<string, Own> = {
    // Seed 414: B joins x into p, so p holds a copy of x's text and x is removed; A,
    // not having seen it, deletes across x and y. B's removal did not read A's ops in x, so the
    // import restores x. A's Ctrl+Z goes back: no word is lost; x's text may show beside B's copy
    // in p (design §2: text twice is the accepted cost of a clash).
    "a peer's join took away text A deleted across": {
      room: () => room([p("p", "Pre."), p("x", "Mid qA8 word."), p("y", "Tail text.")]),
      run: (r) => {
        r.b.view.dispatch(r.b.view.state.tr.join(posOf(r.b, "x")));
        r.b.history.endStep();
        r.a.view.dispatch(r.a.view.state.tr.delete(posOf(r.a, "x") + 1, posOf(r.a, "y") + 2));
        r.a.history.endStep();
        syncAll(r);
        runHistory(r.a, "undo");
        return settle(r, "join/delete-across then A Undo", showsAll("qA8", "Pre.", "Tail text."));
      },
    },
    // B joins x into p, so p holds a copy of x's text; A, not having seen it, types in x. B's
    // removal did not read A's typing, so the import restores x: x's words show in p and in x,
    // A's typing with them (design §1: a restore only puts the block back).
    "a join that did not read A's typing gives the block back": {
      room: () => room([p("p", "Pre."), p("x", "Mid word."), p("y", "Tail text.")]),
      run: (r) => {
        r.b.view.dispatch(r.b.view.state.tr.join(posOf(r.b, "x")));
        r.b.history.endStep();
        r.a.view.dispatch(r.a.view.state.tr.insertText("qA9 ", posOf(r.a, "x") + 1));
        r.a.history.endStep();
        return settle(r, "join against unread typing", showsAll("Pre.Mid word.|qA9 Mid word."), once("qA9"));
      },
    },
    // Review p19056: B joins x into p, then splits p where x began, so x's words move again, into
    // a block of their own. A, not having seen either, types in x. The restore of x shows x's
    // words beside the copy of a copy.
    "a join, then a split of its copy, gives the block back": {
      room: () => room([p("p", "Pre."), p("x", "Mid word."), p("y", "Tail text.")]),
      run: (r) => {
        r.b.view.dispatch(r.b.view.state.tr.join(posOf(r.b, "x")));
        r.b.history.endStep();
        split(r.b, "p", 4, "p2");
        r.a.view.dispatch(r.a.view.state.tr.insertText("qA9 ", posOf(r.a, "x") + 1));
        r.a.history.endStep();
        return settle(r, "join, split, unread typing", showsAll("Pre.|Mid word.|qA9 Mid word."), once("qA9"));
      },
    },
    // Review p19057: B joins y into x, then x into p, so p holds a copy of x's copy of y's text. A,
    // not having seen either, types in y. The restore of y shows its words beside the copy.
    "two joins in a row give the block back": {
      room: () => room([p("p", "Pre."), p("x", "Mid word."), p("y", "Tail text.")]),
      run: (r) => {
        r.b.view.dispatch(r.b.view.state.tr.join(posOf(r.b, "y")));
        r.b.history.endStep();
        r.b.view.dispatch(r.b.view.state.tr.join(posOf(r.b, "x")));
        r.b.history.endStep();
        r.a.view.dispatch(r.a.view.state.tr.insertText("qA9 ", posOf(r.a, "y") + 1));
        r.a.history.endStep();
        return settle(r, "two joins, unread typing", showsAll("Pre.Mid word.Tail text.|qA9 Tail text."), once("qA9"));
      },
    },
    // Seed 35: as above, and B's Ctrl+Z and Redo of the join. The Redo's removal counts what the
    // join read, not what the Ctrl+Z left on screen: the join's copy has none of A's typing, so x
    // comes back again beside it.
    "a Redo of a join that did not read A's typing gives the block back": {
      room: () => room([p("p", "Pre."), p("x", "Mid word.")]),
      run: (r) => {
        r.b.view.dispatch(r.b.view.state.tr.join(posOf(r.b, "x")));
        r.b.history.endStep();
        r.a.view.dispatch(r.a.view.state.tr.insertText("qA9 ", posOf(r.a, "x") + 1));
        r.a.history.endStep();
        syncAll(r);
        if (!runHistory(r.b, "undo")) return "join Redo: B's Ctrl+Z did not run";
        const undone = settle(r, "join Redo, B's Ctrl+Z", showsAll("Pre.|qA9 Mid word."), once("qA9"));
        if (undone) return undone;
        if (!runHistory(r.b, "redo")) return "join Redo: B's Redo did not run";
        return settle(r, "join Redo, B's Redo", showsAll("Pre.Mid word.|qA9 Mid word."), once("qA9"));
      },
    },
    // Seed 247: B adds a paragraph of its words in a cell of the table A inserted. A's Ctrl+Z,
    // Redo and Ctrl+Z again of the table keep B's words: each removal counts what the insert read,
    // not what the Redo showed.
    "a Ctrl+Z after a Redo of a table keeps the peer's paragraph in it": {
      room: () => room([p("a", "First."), p("z", "Last.")]),
      run: (r) => {
        const cell = (id: string) => schema.nodes.table_cell.create({ id }, [p(`${id}p`, "Cell.")]);
        const grid = schema.nodes.table.create({ id: "t" }, [schema.nodes.table_row.create({ id: "r" }, [cell("c1"), cell("c2")])]);
        r.a.view.dispatch(r.a.view.state.tr.insert(posOf(r.a, "z"), grid));
        r.a.history.endStep();
        syncAll(r);
        const c2 = posOf(r.b, "c2");
        const box = r.b.view.state.doc.nodeAt(c2) as Node;
        r.b.view.dispatch(r.b.view.state.tr.insert(c2 + box.nodeSize - 1, p("n", "qB1")));
        r.b.history.endStep();
        syncAll(r);
        for (const direction of ["undo", "redo", "undo"] as const) {
          if (!runHistory(r.a, direction)) return `table ${direction}: did not run`;
          const bad = settle(r, `table, A's ${direction}`, showsAll("qB1"), once("qB1"));
          if (bad) return bad;
        }
        return null;
      },
    },
    // Seed 221: B typed in i2; A deletes across i1 and i2, so i1 holds a copy of B's words and i2
    // is removed; B unwraps the panel, moving i1 out and removing c. A's Ctrl+Z takes its copy out
    // and puts i2 back under c: c comes back with it, so B's words stay on screen.
    "a Ctrl+Z that puts a block back under a container a peer removed brings the container back": {
      room: () => room(),
      run: (r) => {
        caret(r.b, "i2", 0);
        type(r.b, "qB1 ");
        away(r.b);
        syncAll(r);
        r.a.view.dispatch(r.a.view.state.tr.delete(posOf(r.a, "i1") + 1, posOf(r.a, "i2") + 1));
        r.a.history.endStep();
        syncAll(r);
        unwrap(r.b, "c");
        syncAll(r);
        if (!runHistory(r.a, "undo")) return "unwrapped panel: A's Ctrl+Z did not run";
        return settle(r, "unwrapped panel, A's Ctrl+Z", showsAll("qB1 Inner two."));
      },
    },
    // Seed 23: A removes the table with its own words in a cell, and B, not having seen it, moves
    // the table, which brings it back (B's peer id is the higher, so its key wins). A's Ctrl+Z
    // puts the table back where it was, over B's move, and Redo removes it again, A's words with
    // it: A deleted them.
    "A's Redo of a delete goes over a peer's move that brought the block back": {
      room: () => room(start(), [1n, 2n]),
      run: (r) => {
        caret(r.a, "c1p", 0);
        type(r.a, "qA1 ");
        syncAll(r);
        remove(r.a, "t");
        move(r.b, "t", "a");
        syncAll(r);
        if (!shown(r.a).startsWith("qA1 Cell one.")) return `moved-back table: A shows "${shown(r.a)}"`;
        runHistory(r.a, "undo");
        const undone = settle(r, "moved-back table, A's Ctrl+Z", (t) =>
          t.startsWith("First.|Delete-target before after.|qA1 Cell one.") ? null : `shows "${t}"`,
        );
        if (undone) return undone;
        if (!runHistory(r.a, "redo")) return "moved-back table: A's Redo did not run";
        return settle(r, "moved-back table, A's Redo", showsNone("Cell one."));
      },
    },
    // Review p19017 (#1851): a draft, forked before A's Ctrl+Z step, rewrites "First.", so it too
    // deletes the "F" A deleted. Its press carries that delete into Live; the press's Undo takes it
    // back, so it counts as never made, and A's Ctrl+Z goes back.
    "a press undone since does not keep A's step": {
      room: () => room([p("a", "First."), p("z", "Last.")]),
      run: (r) => {
        const live = r.agent();
        const draft = RoomDocs.draftOf(live, freshPeerId());
        const command = <T,>(run: (cmd: RoomDocs) => T): T => {
          const cmd = draft.fork(freshPeerId());
          try {
            const out = run(cmd);
            live.importBatch((cmd.live as RoomDocs).exportSince(live.version()));
            draft.importBatch(cmd.exportSince(draft.version()));
            draft.forward();
            return out;
          } finally {
            cmd.free();
          }
        };
        try {
          const state = EditorState.create({ schema, doc: readProseMirror(draft, schema) });
          writeProseMirror(draft, state.tr.insertText("B rewrote f", 1, 2).doc);
          r.a.view.dispatch(r.a.view.state.tr.delete(posOf(r.a, "a") + 1, posOf(r.a, "a") + 2));
          r.a.history.endStep();
          live.importBatch(r.a.docs.exportSince(live.version()));
          const pressed = command((cmd) => applyBlocks(cmd, "all", { liveVersion: live.version() }).pressed);
          command((cmd) => undoPress(cmd, pressed));
          send(live, r.a);
          send(live, r.b);
          if (shown(r.a) !== "irst.|Last.") return `undone press: A shows "${shown(r.a)}" before its Ctrl+Z`;
          if (!runHistory(r.a, "undo")) return "undone press: A's Ctrl+Z did not run";
          return settle(r, "undone press, then A's Ctrl+Z", (t) => (t === "First.|Last." ? null : `shows "${t}"`));
        } finally {
          draft.free();
        }
      },
    },
    // B's Ctrl+Z of its own delete of A's "F", before it sees A's, puts "F" back. A's Ctrl+Z puts
    // its "F" back too: the text shows twice (design §2), no word is lost.
    "a peer's Undo put back text A deleted": {
      room: () => room([p("a", "First."), p("z", "Last.")]),
      run: (r) => {
        for (const e of [r.a, r.b]) {
          e.view.dispatch(e.view.state.tr.delete(posOf(e, "a") + 1, posOf(e, "a") + 2));
          e.history.endStep();
        }
        runHistory(r.b, "undo");
        syncAll(r);
        if (!runHistory(r.a, "undo")) return "put back by a peer: A's Ctrl+Z did not run";
        return settle(r, "a peer's Undo put back text A deleted", (t) => (t === "FFirst.|Last." ? null : `shows "${t}"`));
      },
    },
    // B Backspaces "f", "e", "d" before it sees A's delete of "f": Loro stores the run as one delete
    // op with a negative length whose `start_id` is "d", the lowest id. A's Ctrl+Z puts its "f"
    // back over B's delete of it (design §2: holes are accepted).
    "a peer's Backspace run deleted text A deleted": {
      room: () => room([p("a", "abcdefgh."), p("z", "Last.")]),
      run: (r) => {
        r.a.view.dispatch(r.a.view.state.tr.delete(posOf(r.a, "a") + 6, posOf(r.a, "a") + 7));
        r.a.history.endStep();
        for (const at of [6, 5, 4]) {
          r.b.view.dispatch(r.b.view.state.tr.delete(posOf(r.b, "a") + at, posOf(r.b, "a") + at + 1));
          r.b.history.endStep();
        }
        syncAll(r);
        if (!runHistory(r.a, "undo")) return "Backspace run: A's Ctrl+Z did not run";
        return settle(r, "a peer's Backspace run deleted text A deleted", (t) => (t === "abcfgh.|Last." ? null : `shows "${t}"`));
      },
    },
    // Seed 477: A and B remove x from one state, so their removal records are equal, and A's wins
    // (the higher peer). B's Ctrl+Z puts x back over A's removal (last writer wins).
    "a peer's equal removal is undone by the other's Ctrl+Z": {
      room: () => room([p("a", "First."), p("x", "Target qA81."), p("z", "Last.")], [2000n, 1000n]),
      run: (r) => {
        remove(r.b, "x");
        remove(r.a, "x");
        syncAll(r);
        runHistory(r.b, "undo");
        return settle(r, "equal removals then B Undo", once("qA81"));
      },
    },
    // Seed 602: B's caret keeps table t, which A removed; B moves y from before t to
    // after it. The writer gives y a new key around t's: t stays removed in the docs.
    "a move beside a kept block leaves it removed": {
      room: () => {
        const c = (id: string, text: string) => schema.nodes.table_cell.create({ id }, [p(`${id}p`, text)]);
        const t = schema.nodes.table.create({ id: "t" }, [
          schema.nodes.table_row.create({ id: "r" }, [c("c1", "Cell qA97."), c("c2", "Two.")]),
        ]);
        return room([p("y", "Before."), t, p("z", "Last.")]);
      },
      run: (r) => {
        caret(r.b, "c1p", 2);
        remove(r.a, "t");
        sync(r.a, r.b);
        move(r.b, "y", "z");
        if (!removalOf(new StructureView(r.b.docs).value("order", "t")))
          return "kept move: B's move brought t back";
        caret(r.b, "y", 0);
        return settle(r, "a move beside a kept block", showsNone("qA97"), (t) =>
          t.startsWith("Before.|Last.") ? null : `shows "${t}", wanted y moved`,
        );
      },
    },
    // The placeholder id (p18995's dup-id): A types into emptied c, so the paragraph is stored
    // under a fresh id, and unwraps c, a move of it to the top. B's concurrent move of c brings
    // c back with no child: it shows its placeholder, and no id reads twice.
    "an unwrap of an emptied container and a peer's move of it": {
      room: () => room([p("a", "First."), schema.nodes.jsx_container.create({ id: "c", name: "Panel" }, [p("i", "Inner.")]), p("z", "Last.")]),
      run: (r) => {
        emptyOut(r.a, "c");
        caret(r.a, "c/empty", 0);
        type(r.a, "TOKEN");
        syncAll(r);
        unwrap(r.a, "c");
        for (const level of [2, null, 2, null]) {
          r.b.view.dispatch(r.b.view.state.tr.setNodeAttribute(posOf(r.b, "a"), "level", level));
          r.b.history.endStep();
        }
        move(r.b, "c", "a");
        syncAll(r);
        return badIds(r, "unwrap/move") ?? settle(r, "unwrap/move", once("TOKEN"));
      },
    },
    // Review p18998 (Sol): three copies unwrap c, wrap c in w and move c at once. The paragraph A
    // typed in moved out as itself, so the merge shows its text once, through every Undo.
    "three copies: placeholder id under unwrap, wrap and move": {
      room: () => room([p("a", "First."), schema.nodes.jsx_container.create({ id: "c", name: "Panel" }, [p("i", "Inner.")]), p("z", "Last.")]),
      run: (r) => {
        const third = r.third();
        emptyOut(r.a, "c");
        caret(r.a, "c/empty", 0);
        type(r.a, "TOKEN");
        syncAll(r);
        unwrap(r.a, "c");
        const at = posOf(r.b, "c");
        const node = r.b.view.state.doc.nodeAt(at) as Node;
        r.b.view.dispatch(r.b.view.state.tr.replaceWith(at, at + node.nodeSize,
          schema.nodes.jsx_container.create({ id: "w", name: "Panel" }, [node])));
        r.b.history.endStep();
        move(third, "c", "a");
        syncAll(r);
        const merged = badIds(r, "three-copy merge") ?? settle(r, "three-copy merge", once("TOKEN"));
        if (merged) return merged;
        for (const e of [r.a, r.b, third]) {
          runHistory(e, "undo");
          syncAll(r);
        }
        return badIds(r, "three-copy undos") ?? settle(r, "three-copy undos", once("TOKEN"));
      },
    },
    // Seed 953: B deletes the words A typed into c's empty paragraph, its caret staying there,
    // and A gives c another child. B's screen never shows the words again, and B's Ctrl+Z gives
    // them back once.
    "a peer fills a container whose paragraph B emptied, B's caret in it": {
      room: () => room([p("a", "First."), schema.nodes.jsx_container.create({ id: "c", name: "Panel" }, [p("i", "Inner.")]), p("z", "Last.")]),
      run: (r) => {
        emptyOut(r.a, "c");
        caret(r.a, "c/empty", 0);
        type(r.a, "WORD");
        syncAll(r);
        const typed = firstIn(r.b, "c");
        caret(r.b, typed, 4);
        const at = posOf(r.b, typed);
        r.b.view.dispatch(r.b.view.state.tr.delete(at + 1, at + 5));
        r.b.history.endStep();
        const c = posOf(r.a, "c");
        const inner = r.a.view.state.doc.nodeAt(c) as Node;
        r.a.view.dispatch(r.a.view.state.tr.replaceWith(c + 1, c + inner.nodeSize - 1, p("n1", "New.")));
        r.a.history.endStep();
        sync(r.a, r.b);
        if (shown(r.b).includes("WORD")) return `emptied/filled: B shows "${shown(r.b)}"`;
        const filled = settle(r, "emptied/filled", showsAll("New."), showsNone("WORD"));
        if (filled) return filled;
        runHistory(r.b, "undo");
        return badIds(r, "emptied/filled, B Undo") ?? settle(r, "emptied/filled, B Undo", showsNone("WORDWORD"));
      },
    },
    // B empties c to its placeholder, removing the paragraph A typed in, while A's caret is in
    // it. A's typing into the placeholder afterwards is a new paragraph: the removed one's words
    // never show in it. Storing the paragraph is typing for the history, so one Ctrl+Z takes the
    // whole burst back: c shows its placeholder again (review p19004).
    "typing in a container's placeholder after a peer emptied it": {
      room: () => room([p("a", "First."), schema.nodes.jsx_container.create({ id: "c", name: "Panel" }, [p("i", "Inner.")]), p("z", "Last.")]),
      run: (r) => {
        emptyOut(r.a, "c");
        caret(r.a, "c/empty", 0);
        type(r.a, "old");
        syncAll(r);
        emptyOut(r.b, "c");
        syncAll(r);
        // A's caret kept the paragraph on its screen; it moves away first.
        away(r.a);
        if (shown(r.a).includes("old")) return `emptied: A still shows "${shown(r.a)}"`;
        caret(r.a, "c/empty", 0);
        type(r.a, "new");
        const typed = badIds(r, "emptied, typed") ?? settle(r, "emptied, typed", showsAll("First.|new|Last."), showsNone("old"));
        if (typed) return typed;
        runHistory(r.a, "undo");
        const undone = settle(r, "emptied, A one Undo", showsAll("First.||Last."));
        if (undone) return undone;
        return firstIn(r.a, "c") === "c/empty" ? null : `emptied, A Undo: c shows ${firstIn(r.a, "c")} "${shown(r.a)}", wanted its placeholder`;
      },
    },
    // Review p18998: B's batch between each of A's keys splits A's one typing step into an item
    // per key, more than a manager kept; its Undo left the first key.
    "a typing step of more items than the step limit": {
      room: () => room([p("x", "base")]),
      run: (r) => {
        caret(r.a, "x", 0);
        caret(r.b, "x", 0);
        for (let i = 0; i < 1001; i++) {
          r.a.view.dispatch(r.a.view.state.tr.insertText("A"));
          r.b.view.dispatch(r.b.view.state.tr.insertText("b"));
          sync(r.b, r.a);
        }
        r.a.history.endStep();
        r.b.history.endStep();
        const count = (e: Editor, ch: string) => shown(e).split(ch).length - 1;
        if (count(r.a, "A") !== 1001 || count(r.a, "b") !== 1002)
          return `long step: A shows ${count(r.a, "A")} A and ${count(r.a, "b")} b`;
        const ran = runHistory(r.a, "undo");
        if (!ran || count(r.a, "A") !== 0) return `long step: Undo left ${count(r.a, "A")} of 1001 A`;
        return settle(r, "long step undone", (t) => (t.includes("A") ? `shows "${t}", wanted no A` : null));
      },
    },
  };
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
    // The caret rule: A joins x into the block before while B's caret rests in x. B keeps x on
    // screen beside A's copy; B's typing brings x back, beside the copy (design §1).
    "typing in a block a peer joined away": (r) => {
      caret(r.b, "x", 14);
      r.a.view.dispatch(r.a.view.state.tr.join(posOf(r.a, "x")));
      r.a.history.endStep();
      sync(r.a, r.b);
      if (!keptOf(r.b).has("x")) return `joined-away case: B does not keep x: "${shown(r.b)}"`;
      type(r.b, "[third]");
      return settle(r, "typing in a block a peer joined away", showsAll("First.Delete-target before after.|Delete-target [third]before after."), once("[third]"));
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
    "Redo of a delete after the peer typed stays": (r) => {
      remove(r.a, "x");
      sync(r.a, r.b);
      runHistory(r.a, "undo");
      sync(r.a, r.b);
      caret(r.b, "x", 14);
      type(r.b, " more");
      sync(r.b, r.a);
      // B typed in the block since A's Undo: the Redo removes it again, and rule 1 brings it back
      // for B's words, which the removal did not read.
      if (!runHistory(r.a, "redo")) return "Redo case: the Redo did not run";
      return settle(r, "Redo of a delete after the peer typed", showsAll("Delete-target  morebefore after."));
    },
    // A Redo of a delete with nothing typed since still lands, with a record of what the delete read.
    "Redo of a delete stands when nothing was typed since": (r) => {
      remove(r.a, "x");
      syncAll(r);
      runHistory(r.a, "undo");
      syncAll(r);
      if (!runHistory(r.a, "redo")) return "plain Redo case: the Redo did not run";
      const redone = settle(r, "plain Redo of a delete", showsNone("Delete-target"));
      if (redone) return redone;
      runHistory(r.a, "undo");
      return settle(r, "Undo after the plain Redo", showsAll("Delete-target before after."));
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
    // that removes something else does not bring the block back; B's Redo puts the text back, and
    // with it the block.
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
      return settle(r, "Redo in a removed block", once("foo"));
    },
    // Seeds 289 and 55: A and B move one block at once and B's move wins (B wrote more structure
    // first, so on any peer ids). B's Ctrl+Z puts the key back where both moves found it. A's
    // Ctrl+Z of its move finds a later write there and leaves it, so it takes back A's step
    // before (typing), and Redo gives that back.
    "a peer's Ctrl+Z put the key back where A's step found it": (r) => {
      caret(r.a, "a", 2);
      type(r.a, "Q");
      retype(r.b, "z", "paragraph", { level: 2 });
      retype(r.b, "z", "paragraph");
      move(r.a, "x", "c");
      move(r.b, "x", "a");
      syncAll(r);
      runHistory(r.b, "undo");
      syncAll(r);
      const start = "FiQrst.|Delete-target before after.|";
      if (!shown(r.a).startsWith(start)) return `put-back case: A starts "${shown(r.a)}"`;
      if (!runHistory(r.a, "undo")) return "put-back case: A's Ctrl+Z found nothing";
      if (!shown(r.a).startsWith("First.|Delete-target"))
        return `put-back case: A's Ctrl+Z gave "${shown(r.a)}", wanted its typing gone and x left where it is`;
      if (!runHistory(r.a, "redo")) return "put-back case: no Redo after A's Ctrl+Z";
      return settle(r, "a peer's Ctrl+Z put the key back", (t) =>
        t.startsWith(start) ? null : `shows "${t}", wanted "${start}…"`,
      );
    },
    // A peer's move, retype or delete after A's step is a later write: A's Ctrl+Z puts A's key
    // back over it and Redo gives A's step again (design §2: last writer wins per key).
    "A's Ctrl+Z of a move goes back over a peer's later move": (r) => {
      const before = shown(r.a);
      move(r.a, "x", "c");
      syncAll(r);
      const moved = shown(r.a);
      move(r.b, "x", "a");
      syncAll(r);
      runHistory(r.a, "undo");
      const undone = settle(r, "later move, A's Ctrl+Z", (t) =>
        t === before ? null : `shows "${t}", wanted "${before}"`,
      );
      if (undone) return undone;
      runHistory(r.a, "redo");
      return settle(r, "later move, A's Redo", (t) => (t === moved ? null : `shows "${t}", wanted "${moved}"`));
    },
    "A's Ctrl+Z of a retype goes back over a peer's later retype": (r) => {
      retype(r.a, "z", "code_block");
      syncAll(r);
      retype(r.b, "z", "jsx_leaf", { name: "Note" });
      syncAll(r);
      runHistory(r.a, "undo");
      const undone = settle(r, "later retype, A's Ctrl+Z");
      if (undone) return undone;
      if (typeOf(r.a, "z") !== "paragraph") return `later retype: A's Ctrl+Z made z a ${typeOf(r.a, "z")}`;
      runHistory(r.a, "redo");
      const redone = settle(r, "later retype, A's Redo");
      if (redone) return redone;
      return typeOf(r.b, "z") === "code_block" ? null : `later retype: A's Redo made z a ${typeOf(r.b, "z")}`;
    },
    "A's Ctrl+Z of a move brings back a block a peer deleted since": (r) => {
      move(r.a, "x", "c");
      syncAll(r);
      remove(r.b, "x");
      syncAll(r);
      runHistory(r.a, "undo");
      const undone = settle(r, "later delete, A's Ctrl+Z", once("Delete-target"));
      if (undone) return undone;
      runHistory(r.a, "redo");
      return settle(r, "later delete, A's Redo", once("Delete-target"));
    },
    // An Undo always runs (design §2): A's Ctrl+Z takes its split back over B's move of the new
    // half, and the text shows once, in the first half.
    "a peer moves the new half of A's split before A undoes": (r) => {
      const splitAt = posOf(r.a, "x") + 1 + 14;
      r.a.view.dispatch(
        r.a.view.state.tr.split(splitAt, 1, [{ type: schema.nodes.paragraph, attrs: { id: "x2" } }]),
      );
      r.a.history.endStep();
      syncAll(r);
      move(r.b, "x2", "a");
      syncAll(r);
      if (!shown(r.a).startsWith("before after.|First."))
        return `split/move setup: A shows "${shown(r.a)}"`;
      if (!runHistory(r.a, "undo")) return "split/move: A's Ctrl+Z did not run";
      return settle(r, "split/move then A Undo", showsAll("Delete-target before after."));
    },
    "a peer deletes the new half of A's split before A undoes": (r) => {
      const splitAt = posOf(r.a, "x") + 1 + 14;
      r.a.view.dispatch(
        r.a.view.state.tr.split(splitAt, 1, [{ type: schema.nodes.paragraph, attrs: { id: "x2" } }]),
      );
      r.a.history.endStep();
      syncAll(r);
      remove(r.b, "x2");
      syncAll(r);
      if (!runHistory(r.a, "undo")) return "split/delete: A's Ctrl+Z did not run";
      return settle(r, "split/delete then A Undo", showsAll("Delete-target before after."));
    },
    // --- The step rule: every step runs (design §2, "An Undo always runs").
    "a peer's typing undone since does not keep A's split": (r) => {
      split(r.a, "x", 14, "x2");
      syncAll(r);
      caret(r.b, "x2", 0);
      type(r.b, "Zq");
      if (!runHistory(r.b, "undo")) return "typing undone: B's Ctrl+Z did not run";
      away(r.b);
      syncAll(r);
      if (!runHistory(r.a, "undo")) return "typing undone: A's Ctrl+Z did not run";
      return settle(r, "typing undone, then A's Ctrl+Z", showsAll("Delete-target before after."));
    },
    "A's own split goes back exactly, and Redo gives it back": (r) => {
      const before = shown(r.a);
      split(r.a, "x", 14, "x2");
      const after = shown(r.a);
      syncAll(r);
      if (!runHistory(r.a, "undo")) return "own split: Undo did not run";
      if (shown(r.a) !== before) return `own split: Undo gave "${shown(r.a)}"`;
      const undone = settle(r, "own split, Undo");
      if (undone) return undone;
      if (!runHistory(r.a, "redo")) return "own split: Redo did not run";
      if (shown(r.a) !== after) return `own split: Redo gave "${shown(r.a)}"`;
      return settle(r, "own split, Redo");
    },
    // Opus R7: B joins the halves back (a copy of the tail is B's text in x now). A's Ctrl+Z of
    // the split puts its tail back beside B's copy: the tail shows twice (design §2).
    "a peer joins A's split back before A undoes": (r) => {
      split(r.a, "x", 14, "x2");
      syncAll(r);
      r.b.view.dispatch(r.b.view.state.tr.join(posOf(r.b, "x2")));
      r.b.history.endStep();
      syncAll(r);
      runHistory(r.a, "undo");
      return settle(r, "split/join then A Undo", showsAll("Delete-target before after.before after."));
    },
    // A's Ctrl+Z of the Enter runs over B's words in the new half: the half is removed with a
    // record that did not read them, so it comes back with them alone (design §2).
    "a peer types in the new half of A's split before A undoes": (r) => {
      split(r.a, "x", 14, "x2");
      syncAll(r);
      caret(r.b, "x2", 7);
      type(r.b, "PEER ");
      syncAll(r);
      runHistory(r.a, "undo");
      return settle(r, "split/type then A Undo", showsAll("Delete-target before after.|PEER "), once("before"), once("PEER"));
    },
    // B's words reach A after A's Ctrl+Z: the removal of the new half did not read them, so the
    // half comes back with them alone, and the tail is in x.
    "a peer types in the new half while A undoes the split": (r) => {
      split(r.a, "x", 14, "x2");
      syncAll(r);
      caret(r.b, "x2", 7);
      type(r.b, "PEER ");
      if (!runHistory(r.a, "undo")) return "split/race: Undo did not run";
      return settle(r, "split/race", showsAll("Delete-target before after.|PEER "), once("before"), once("PEER"));
    },
    // B deletes x (the head) after the split: A's Ctrl+Z puts the tail back in x, which brings x
    // back (rule 1 over the Undo's own text), so the tail shows once.
    "a peer deletes the first half of A's split before A undoes": (r) => {
      split(r.a, "x", 14, "x2");
      syncAll(r);
      remove(r.b, "x");
      syncAll(r);
      runHistory(r.a, "undo");
      return settle(r, "split/delete-head then A Undo", showsAll("First.|Delete-target before after."), once("before after."));
    },
    // B typing in the head does not touch what the split made: the Enter goes back around it.
    "a peer types in the first half of A's split before A undoes": (r) => {
      split(r.a, "x", 14, "x2");
      syncAll(r);
      caret(r.b, "x", 0);
      type(r.b, "PEER ");
      syncAll(r);
      if (!runHistory(r.a, "undo")) return "split/type-head: Undo did not run";
      return settle(r, "split/type-head then A Undo", showsAll("PEER Delete-target before after.|Cell one."));
    },
    // Opus R3: A joins i1 and i2, B retypes i1 (a key the join did not set): the join goes back.
    "a peer retypes the block A joined into before A undoes": (r) => {
      r.a.view.dispatch(r.a.view.state.tr.join(posOf(r.a, "i2")));
      r.a.history.endStep();
      syncAll(r);
      retype(r.b, "i1", "code_block");
      syncAll(r);
      if (!runHistory(r.a, "undo")) return "join/retype: Undo did not run";
      const settled = settle(r, "join/retype then A Undo", showsAll("Inner one.|Inner two."));
      return settled ?? (typeOf(r.a, "i1") === "code_block" ? null : `join/retype: i1 is a ${typeOf(r.a, "i1")}`);
    },
    // Opus R4: A wraps a and x in a container, B moves x out: A's Ctrl+Z takes the wrap away and
    // puts both back at the top.
    "a peer moves a block out of A's wrap before A undoes": (r) => {
      const at = posOf(r.a, "a");
      const { state } = r.a.view;
      const [na, nx] = [state.doc.nodeAt(at) as Node, state.doc.nodeAt(posOf(r.a, "x")) as Node];
      const w = schema.nodes.jsx_container.create({ id: "w", name: "Panel" }, [na, nx]);
      r.a.view.dispatch(state.tr.replaceWith(at, posOf(r.a, "x") + nx.nodeSize, w));
      r.a.history.endStep();
      syncAll(r);
      move(r.b, "x", "z");
      syncAll(r);
      runHistory(r.a, "undo");
      const settled = settle(r, "wrap/move then A Undo", showsAll("First.", "Delete-target before after."));
      if (settled) return settled;
      const parent = (id: string) => new StructureView(r.a.docs).value("parent", id);
      return parent("a") === null && parent("x") === null && posOf(r.a, "w") < 0
        ? null
        : `wrap/move: a under ${parent("a")}, x under ${parent("x")}, w at ${posOf(r.a, "w")}`;
    },
    // Opus R5: A splits, B wraps the new half in a container: A's Ctrl+Z takes the half out, and
    // the tail shows once, in x.
    "a peer wraps the new half of A's split before A undoes": (r) => {
      split(r.a, "x", 14, "x2");
      syncAll(r);
      const at = posOf(r.b, "x2");
      const node = r.b.view.state.doc.nodeAt(at) as Node;
      const w = schema.nodes.jsx_container.create({ id: "w", name: "Panel" }, [node]);
      r.b.view.dispatch(r.b.view.state.tr.replaceWith(at, at + node.nodeSize, w));
      r.b.history.endStep();
      syncAll(r);
      runHistory(r.a, "undo");
      return settle(r, "split/wrap then A Undo", showsAll("Delete-target before after."), once("before after."));
    },
    // Opus R6: a move a peer wrote over goes back over it, the typing either side of it goes back,
    // and Redo gives all three back.
    "typing either side of a move a peer wrote over": (r) => {
      caret(r.a, "a", 2);
      type(r.a, "Q");
      move(r.a, "x", "c");
      caret(r.a, "a", 3);
      type(r.a, "R");
      syncAll(r);
      move(r.b, "x", "a");
      syncAll(r);
      runHistory(r.a, "undo");
      runHistory(r.a, "undo");
      runHistory(r.a, "undo");
      if (!shown(r.a).startsWith("First.|Delete-target before after.|"))
        return `skipped move: three Undos gave "${shown(r.a)}"`;
      for (let i = 0; i < 3; i++) runHistory(r.a, "redo");
      if (r.a.history.canRedo()) return "skipped move: a Redo is left";
      return settle(r, "skipped move, Redo", showsAll("FiQRrst.|"), showsNone("Delete-target before after.|FiQRrst."));
    },
    // A split a peer moved the new half of goes back over the move, and the typing under it goes
    // back after it.
    "a split a peer wrote over goes back, and the typing under it": (r) => {
      const before = shown(r.a);
      caret(r.a, "x", 14);
      type(r.a, "abc def ");
      split(r.a, "x", 18, "x2");
      syncAll(r);
      move(r.b, "x2", "a");
      syncAll(r);
      const setup = shown(r.a);
      if (!setup.startsWith("def before after.|First.|Delete-target abc |"))
        return `standing split: setup shows "${setup}"`;
      if (!runHistory(r.a, "undo")) return "standing split: the Undo did not run";
      if (!shown(r.a).includes("Delete-target abc def before after."))
        return `standing split: the Undo gave "${shown(r.a)}"`;
      runHistory(r.a, "undo");
      return settle(r, "standing split, A Undo", (t) => (t === before ? null : `shows "${t}", wanted "${before}"`));
    },
    // Review p18993 C2: B types in the new half, C deletes "before " from it, and A presses Ctrl+Z
    // before C's delete reaches it. The Undo puts the tail back in x as new text, so C's delete
    // of the old finds nothing (a hole, design §2), and the half comes back for B's words.
    "a peer's deletion in flight while A undoes the split": (r) => {
      const c = r.third();
      split(r.a, "x", 14, "x2");
      syncAll(r);
      caret(r.b, "x2", 7);
      type(r.b, "PEER ");
      sync(r.b, r.a);
      const at = posOf(c, "x2") + 1;
      c.view.dispatch(c.view.state.tr.delete(at, at + 7));
      c.history.endStep();
      runHistory(r.a, "undo");
      return settle(r, "deletion in flight", showsAll("Delete-target before after.|PEER "), once("PEER"));
    },
    // Review p18993 C3: the steps either side of a split a peer typed in go back and come again.
    "Undo and Redo either side of a split a peer typed in": (r) => {
      caret(r.a, "a", 2);
      type(r.a, "ONE");
      split(r.a, "x", 14, "x2");
      caret(r.a, "z", 0);
      type(r.a, "THREE");
      syncAll(r);
      caret(r.b, "x2", 0);
      type(r.b, "PEER ");
      syncAll(r);
      for (let i = 0; i < 3; i++) runHistory(r.a, "undo");
      if (shown(r.a).includes("ONE") || shown(r.a).includes("THREE") || !shown(r.a).includes("PEER"))
        return `Redo elsewhere: three Undos gave "${shown(r.a)}"`;
      for (let i = 0; i < 3; i++) runHistory(r.a, "redo");
      if (r.a.history.canRedo()) return "Redo elsewhere: a Redo is left";
      return settle(r, "Redo elsewhere", showsAll("FiONErst.", "THREELast.", "PEER "), once("PEER"));
    },
    // Review p18993 C4: the writer alone inserts a picture, its upload lands (an untracked write of
    // the writer's own), and Ctrl+Z takes the picture back.
    "Ctrl+Z takes back a picture whose upload landed": (r) => {
      caret(r.a, "z", 0);
      type(r.a, "hello");
      const z = posOf(r.a, "z");
      const after = z + (r.a.view.state.doc.nodeAt(z) as Node).nodeSize;
      const image = schema.nodes.image.create({ src: "pending:1", uploadToken: "u1" });
      r.a.view.dispatch(r.a.view.state.tr.insert(after, schema.nodes.paragraph.create({ id: "pic" }, [image])));
      r.a.history.endStep();
      const landing = posOf(r.a, "pic") + 1;
      r.a.view.dispatch(
        r.a.view.state.tr
          .setNodeAttribute(landing, "src", "https://example.test/1.png")
          .setNodeAttribute(landing, "uploadToken", null)
          .setMeta("addToHistory", false),
      );
      syncAll(r);
      if (!runHistory(r.a, "undo")) return "picture: Ctrl+Z did nothing";
      if (posOf(r.a, "pic") >= 0) return "picture: Ctrl+Z left the picture";
      const undone = settle(r, "picture, Ctrl+Z", showsAll("helloLast."));
      if (undone) return undone;
      runHistory(r.a, "redo");
      const src = r.a.view.state.doc.nodeAt(posOf(r.a, "pic") + 1)?.attrs.src;
      return src === "https://example.test/1.png" ? settle(r, "picture, Redo") : `picture: Redo gave src ${src}`;
    },
    // A peer's bold on the new half: A's Ctrl+Z of the Enter puts the original text back without
    // the bold (a hole, design §2); the half the bold kept shows empty.
    "a peer's mark on the new half, then A undoes the split": (r) => {
      split(r.a, "x", 14, "x2");
      syncAll(r);
      const at = posOf(r.b, "x2") + 1;
      r.b.view.dispatch(r.b.view.state.tr.addMark(at, at + 6, schema.marks.strong.create()));
      r.b.history.endStep();
      syncAll(r);
      runHistory(r.a, "undo");
      return settle(r, "split/mark then A Undo", showsAll("Delete-target before after."), once("before after."));
    },
    // A moves i1 out of the container, B removes the container, A's Ctrl+Z puts i1 back under
    // it: a move into a removed block brings it back, with what it held.
    "an Undo that would put a block under a removed container": (r) => {
      move(r.a, "i1", "z");
      syncAll(r);
      caret(r.b, "i1", 0);
      type(r.b, "PEER ");
      remove(r.b, "c");
      syncAll(r);
      away(r.b);
      runHistory(r.a, "undo");
      return settle(r, "move back under a removed container", showsAll("PEER Inner one.|Inner two."));
    },
    "a peer retypes the new half of A's split before A undoes": (r) => {
      const splitAt = posOf(r.a, "x") + 1 + 14;
      r.a.view.dispatch(
        r.a.view.state.tr.split(splitAt, 1, [{ type: schema.nodes.paragraph, attrs: { id: "x2" } }]),
      );
      r.a.history.endStep();
      syncAll(r);
      retype(r.b, "x2", "code_block");
      syncAll(r);
      if (!runHistory(r.a, "undo")) return "split/retype: A's Ctrl+Z did not run";
      return settle(r, "split/retype then A Undo", showsAll("Delete-target before after."));
    },
    // Review p18966: an agent's text op in a cell of a table B's typing brought back.
    "an agent's text op inside a restored table keeps it": (r) => {
      caret(r.b, "c3p", 5);
      remove(r.a, "t");
      type(r.b, "XY");
      const restored = settle(r, "agent text case, restored", showsAll("Cell XYthree."));
      if (restored) return restored;
      const agent = r.agent();
      const ok = applyOps(agent, [{ kind: "text", block: "c3p", splices: [{ from: 5, to: 7, content: [] }], formats: [] }], { newBlockId: madeId });
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
      const ok = applyOps(agent, [{ kind: "delete", block: "i2" }], { newBlockId: madeId });
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
  // A draft's Undo deletes its override, so the draft reads Live's key again; Live then moves the
  // block, and the draft's Redo writes its override over that move (last writer wins).
  const draftRedoAfterLiveWrite = (): string | null => {
    const live = RoomDocs.create(shape, freshPeerId());
    writeProseMirror(live, schema.topNodeType.create(null, start()));
    const draft = RoomDocs.draftOf(live, freshPeerId());
    const de = editor("Draft", draft);
    const le = editor("Live", live);
    try {
      move(de, "x", "a");
      if (!runHistory(de, "undo")) return "draft case: Undo did not run";
      // Before c: the writer keeps a, t, z and c in place and gives x the new key.
      move(le, "x", "c");
      const forwarded = draft.forward();
      notifyChanged(draft, forwarded.changed);
      const beforeRedo = shown(de);
      if (!beforeRedo.startsWith("First.|Cell one."))
        return `draft case: forwarding Live's later move showed "${beforeRedo}"`;
      if (!runHistory(de, "redo")) return "draft case: the Redo did not run";
      return shown(de).startsWith("Delete-target before after.|First.")
        ? null
        : `draft case: the draft shows "${shown(de)}", wanted the draft's move`;
    } finally {
      de.destroy();
      le.destroy();
      draft.free();
      live.free();
    }
  };

  // A Draft tab's Ctrl+Z of an edit the writer then applied: the press deleted the draft's
  // overrides and carried its text into Live, and the draft reads Live's, which hold them now.
  // Ctrl+Z of text runs: the draft takes its text back, a pending change against Live; Ctrl+Z of
  // structure finds no override to put back (the draft reads Live's value), so the draft shows
  // what it applied. With the press undone first (`then`), Ctrl+Z of structure takes it back;
  // text the press's Undo returned to the draft is new text, which neither Ctrl+Z nor `Undo
  // turn` deletes (they take back the edit's own characters, design §2): it stays, no word lost.
  /** Whether `text` holds every character of `want`, in order. */
  const holds = (text: string, want: string) => {
    let at = 0;
    for (const ch of text) if (ch === want[at]) at++;
    return at === want.length;
  };
  const draftUndoAfterApply = (
    name: string,
    edit: (de: Editor) => void,
    writesText: boolean,
    then: "nothing" | "Ctrl+Z" | "restore press",
  ): string | null => {
    const live = RoomDocs.create(shape, freshPeerId());
    writeProseMirror(live, schema.topNodeType.create(null, start()));
    const draft = RoomDocs.draftOf(live, freshPeerId());
    const de = editor("Draft", draft);
    const command = <T,>(run: (cmd: RoomDocs) => T): T => {
      const cmd = draft.fork(freshPeerId());
      try {
        const out = run(cmd);
        live.importBatch((cmd.live as RoomDocs).exportSince(live.version()));
        const got = draft.importBatch(cmd.exportSince(draft.version()));
        notifyChanged(draft, [...got.changed, ...draft.forward().changed]);
        return out;
      } finally {
        cmd.free();
      }
    };
    try {
      const before = shown(de);
      const since = draft.shownVersion();
      edit(de);
      const stored = editSince(draft, since, draft.version().keys());
      const pressed = command((cmd) => applyBlocks(cmd, "all", { liveVersion: live.version() }).pressed);
      if (then === "nothing") {
        const applied = shown(de);
        const ran = runHistory(de, "undo");
        if (!writesText) return shown(de) === applied ? null : `applied ${name}: the draft shows "${shown(de)}"`;
        if (!ran) return `applied ${name}: the Draft tab's Ctrl+Z did not run`;
        if (!holds(shown(de), before)) return `applied ${name}: Ctrl+Z gave "${shown(de)}", wanted "${before}"`;
        return changedBlocks(draft).length ? null : `applied ${name}: Ctrl+Z left nothing pending`;
      }
      const undone = command((cmd) => undoPress(cmd, pressed));
      if (then === "Ctrl+Z") {
        const pending = shown(de);
        runHistory(de, "undo");
        if (writesText)
          return holds(shown(de), before) ? null : `applied ${name}, undone, then Ctrl+Z lost text: "${shown(de)}" from "${pending}"`;
      } else {
        const back = command((cmd) => undoEdits(cmd, [stored]));
        if (back.compacted.size) return `applied ${name}, then undone: the restore press found no history`;
        if (writesText)
          return holds(shown(de), before) ? null : `applied ${name}, undone, then the restore press gave "${shown(de)}"`;
      }
      return shown(de) === before
        ? null
        : `applied ${name}, undone, then ${then}: the draft shows "${shown(de)}", wanted "${before}"`;
    } finally {
      de.destroy();
      draft.free();
      live.free();
    }
  };

  const failures: string[] = [];
  const all: [string, Own][] = [
    ...Object.entries(cases).map(([name, run]): [string, Own] => [name, { room: () => room(), run }]),
    ...Object.entries(ownRooms),
  ];
  for (const [name, { room: make, run }] of all) {
    const r = make();
    try {
      const bad = run(r);
      if (bad) failures.push(bad);
    } catch (error) {
      failures.push(`${name}: threw ${(error as Error).stack}`);
    } finally {
      r.free();
    }
  }
  const draft = draftRedoAfterLiveWrite();
  if (draft) failures.push(draft);
  const edits: [string, (de: Editor) => void, boolean][] = [
    ["split", (de) => split(de, "x", 14, "x2"), true],
    ["move", (de) => move(de, "x", "a"), false],
    ["retype", (de) => retype(de, "x", "heading", { level: 2 }), false],
    [
      "typing",
      (de) => {
        caret(de, "x", 6);
        type(de, " new");
      },
      true,
    ],
  ];
  for (const [name, edit, writesText] of edits)
    for (const then of ["nothing", "Ctrl+Z", "restore press"] as const) {
      const applied = draftUndoAfterApply(name, edit, writesText, then);
      if (applied) failures.push(applied);
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
  `${failed ? `${failed} failed` : `ok: raced removals, ${seeds} seeds × ${steps} steps from ${first}`}; ${chainsOverPeers} Undo chains and ${overPeers} words or marks put back over a peer's write, ${redeleted} chains whose Redo deleted words again, ${shownTwice} words shown twice\n`,
);
process.exitCode = failed ? 1 : 0;

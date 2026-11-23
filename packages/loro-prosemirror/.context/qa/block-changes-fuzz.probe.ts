/**
 * The block-change fuzz (`block-changes-fuzz.md`): seeded scripts of Live, Draft and AI writes, presses, their
 * Undos, Discards and `Restore before` on `@meridian/document-model` itself, on the real schema through the
 * binding's codec. Gate 5's fuzz (`gate/loro-fuzz` at 39f49e50ee) moved onto the product, with its `reset`
 * step named discard, removals as records, and dependent presses undone in turn and out of order.
 *
 *   pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/block-changes-fuzz.probe.ts --n 1000
 *   pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/block-changes-fuzz.probe.ts --seed 37   # one script, step by step
 *
 * FUZZ_TRACE=1 with --seed prints, after each step, every block where Live (L), the fork (F) and the Draft tab
 * (T) differ, and the fork's overrides.
 */
import {
  applyBlocks,
  changedBlocks,
  commentVisibility,
  decodeEnvelope,
  discardBlocks,
  editSince,
  editStays,
  inMap,
  inText,
  isOrderKey,
  noteEdit,
  opsBetween,
  RoomDocs,
  replaceText,
  STRUCTURE_KEY,
  STRUCTURE_MAPS,
  StructureView,
  sameValue,
  setCommentBody,
  structureValues,
  emptyParagraphOf,
  encodeChanges,
  isDerivedEmpty,
  takeBack,
  textUnits,
  undoEdits,
  undoPress,
  valuesOf,
  versionOf,
} from "@meridian/document-model";
import { Fragment, Slice } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { blockOf } from "../../src/codec.js";
import { movedPieces, readProseMirror, shapeSchemaOf, writeProseMirror } from "../../src/index.js";
import { Gen, randomEdit, schema, TOKEN } from "./block-changes.gen.ts";

const shape = shapeSchemaOf(schema);

class Fail extends Error {
  constructor(cls, detail) {
    super(`${cls}: ${detail}`);
    this.cls = cls;
  }
}
const check = (ok, cls, detail) => {
  if (!ok) throw new Fail(cls, typeof detail === "function" ? detail() : detail);
};
const same = sameValue;
const read = (d) => readProseMirror(d, schema);
const render = (d) => JSON.stringify(read(d).toJSON());
const textOfDoc = (doc) => (doc ? inText(doc, (t) => t.toString()) : "");
const say = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);
/** A text doc's delta with each style set in key order: Loro's order follows the history, not the value. */
const deltaOf = (doc) =>
  doc
    ? inText(doc, (t) => t.toDelta()).map((op) =>
        op.attributes ? { ...op, attributes: Object.fromEntries(Object.entries(op.attributes).sort(([a], [b]) => (a < b ? -1 : 1))) } : op,
      )
    : [];
const tokensOf = (text) => text.match(TOKEN) ?? [];
const tokens = (d) => {
  const pm = read(d);
  return tokensOf(pm.textBetween(0, pm.content.size, " ", " "));
};
/** Every shown textblock's id and its normalized text, from the read. */
function textblocks(d) {
  const out = new Map();
  read(d).descendants((node) => {
    if (node.isTextblock) {
      out.set(node.attrs.id, node);
      return false;
    }
    return true;
  });
  return out;
}
/** Comments each shown block carries, as the normalized read shows them. */
function carriers(d) {
  const out = new Map();
  for (const [id, node] of textblocks(d)) {
    const set = new Set();
    node.forEach((child) => {
      for (const mark of child.marks) if (mark.type.name === "comment") set.add(mark.attrs.id);
    });
    out.set(id, set);
  }
  return out;
}
const comments = (d) => {
  const out = new Set();
  for (const set of carriers(d).values()) for (const c of set) out.add(c);
  return out;
};
const tokenBlocks = (d) => {
  const out = new Map();
  for (const id of new StructureView(d).shown)
    for (const tok of tokensOf(textOfDoc(d.textOf(id)))) out.set(tok, id);
  return out;
};
/** Whether `text` is `wanted` with characters added where `extra(at)` allows one. */
function withExtras(wanted, text, extra) {
  // reach[j]: `wanted`'s first j characters match a prefix of `text` read so far.
  let reach = new Array(wanted.length + 1).fill(false);
  reach[0] = true;
  for (let at = 0; at < text.length; at++) {
    const next = new Array(wanted.length + 1).fill(false);
    for (let j = 0; j <= wanted.length; j++) {
      if (!reach[j]) continue;
      if (extra(at)) next[j] = true;
      if (j < wanted.length && wanted[j] === text[at]) next[j + 1] = true;
    }
    reach = next;
  }
  return reach[wanted.length];
}
/** Each unit's op id (`peer:counter`), from a cursor per unit. */
function charIds(doc) {
  if (!doc) return [];
  return inText(doc, (t) => {
    const out = [];
    for (let i = 0; i < t.length; i++) {
      const c = t.getCursor(i, 0);
      if (!c) {
        out.push(null);
        continue;
      }
      const pos = c.pos();
      out.push(pos ? `${pos.peer}:${pos.counter}` : null);
      c.free();
    }
    return out;
  });
}
/**
 * What a write between `before` and `after` did to text doc `doc`, character by character: the characters it
 * deleted (id and character, in order), the ones it inserted, and both per place (a run with no retain inside).
 */
function textWrite(doc, before, after) {
  const at = (frontiers) => {
    const view = doc.fork();
    try {
      view.checkout(frontiers);
      return { ids: charIds(view), text: textOfDoc(view) };
    } finally {
      view.free();
    }
  };
  const old = at(before);
  const now = at(after);
  const places = [];
  let place = null;
  let pos = 0;
  let next = 0;
  for (const op of doc.diff(before, after, false).find(([, d]) => d.type === "text")?.[1].diff ?? []) {
    if (op.retain != null) {
      place = null;
      pos += op.retain;
      next += op.retain;
      continue;
    }
    if (!place) places.push((place = { deleted: [], inserted: [] }));
    if (op.delete != null) {
      for (let k = 0; k < op.delete; k++) place.deleted.push({ id: old.ids[pos + k], ch: old.text[pos + k] });
      pos += op.delete;
    } else {
      for (let k = 0; k < op.insert.length; k++) place.inserted.push({ id: now.ids[next + k], ch: now.text[next + k] });
      next += op.insert.length;
    }
  }
  return { places, deleted: places.flatMap((p) => p.deleted), inserted: places.flatMap((p) => p.inserted) };
}
/** `textWrite` of each text doc among `changes`, by key. */
const textWrites = (changes) => new Map(changes.filter((c) => c.key !== STRUCTURE_KEY).map((c) => [c.key, textWrite(c.doc, c.before, c.after)]));
const blockValues = (d) => {
  const view = new StructureView(d);
  const out = new Map();
  for (const id of view.shown)
    out.set(
      id,
      JSON.stringify([
        ["parent", "order", "node"].map((k) => view.value(k, id)),
        Object.entries(view.attrs(id)).sort(([a], [b]) => (a < b ? -1 : 1)),
        deltaOf(d.textOf(id)),
      ]),
    );
  return out;
};
/** Each shown textblock's stored text: what a restore or an Undo must keep, whatever its node shows. */
const textValues = (d) => {
  const out = new Map();
  for (const id of textblocks(d).keys()) out.set(id, JSON.stringify(deltaOf(d.textOf(id))));
  return out;
};
/**
 * Whether the fork's `d.order` of `id` puts it where Live's key would among its siblings. `removed`: blocks the
 * write removed, which still count at their record's key (the writer drops matching overrides before its
 * removals, so a Discard of a removal leaves a moved block where the draft put it).
 */
function sameOrderAsBase(view, id, removed = new Set()) {
  const override = view.override("order", id);
  const base = view.baseValue("order", id);
  if (!isOrderKey(override) || !isOrderKey(base)) return false;
  if (view.baseValue("parent", id) !== view.value("parent", id)) return false;
  const parent = view.parent(id) ?? null;
  const siblings = [...view.children(parent), ...[...removed].filter((o) => view.parent(o) === parent && view.removal(o))];
  for (const other of siblings) {
    if (other === id) continue;
    const key = view.order(other) ?? view.removal(other).at;
    const side = (mine) => (mine < key ? -1 : mine > key ? 1 : id < other ? -1 : 1);
    if (side(override) !== side(base)) return false;
  }
  return true;
}

let idCounter = 0;
function fixBlockIds(tr, rng, skip = () => false) {
  const seen = new Set();
  const A = "0123456789abcdefghijklmnopqrstuvwxyz";
  tr.doc.descendants((node, pos, parent) => {
    if (node.type.spec.attrs?.id === undefined || skip(node, parent)) return !node.isTextblock;
    if (node.attrs.id == null || seen.has(node.attrs.id) || emptyParagraphOf(node.attrs.id) !== undefined) {
      let id = "";
      for (let i = 0; i < 10; i++) id += A[Math.floor(rng() * 36)];
      tr.setNodeAttribute(pos, "id", id + (idCounter++).toString(36));
    } else seen.add(node.attrs.id);
    return !node.isTextblock;
  });
}
function withIds(pm, rng) {
  const tr = EditorState.create({ schema, doc: pm }).tr;
  fixBlockIds(tr, rng);
  return tr.doc;
}
/** One editor transaction on `d`, written as the editor writes it. */
function edit(d, fn, { rng, by } = {}) {
  const state = EditorState.create({ schema, doc: read(d) });
  const tr = fn(state.tr, state.doc);
  if (!tr || !tr.docChanged) return [];
  // The binding's placeholder rule (design §1): `<container>/empty` stays only on its container's
  // one empty paragraph; anywhere else the node takes a fresh id before the write.
  fixBlockIds(tr, rng, (node, parent) => {
    if (typeof node.attrs.id !== "string" || emptyParagraphOf(node.attrs.id) === undefined) return false;
    const under = parent === tr.doc ? null : parent.attrs.id;
    return parent.childCount === 1 && isDerivedEmpty(blockOf(node), under);
  });
  return writeProseMirror(d, tr.doc, { by, random: rng, moved: process.env.FUZZ_NO_PIECES ? undefined : movedPieces(tr) });
}

export function runScript(seed, { verbose = false } = {}) {
  idCounter = 0;
  const g = new Gen(seed);
  const all = [];
  const stats = {
    edits: 0, presses: 0, pressUndos: 0, discards: 0, discardUndos: 0, discardAlls: 0, discardAllUndos: 0,
    restores: 0, ctrlz: 0, liveEdits: 0, stale: 0, lateDraft: 0, unsyncedLive: 0, chains: 0, chainPresses: 0,
    chainUndosInTurn: 0, chainUndosOutOfOrder: 0, overwrites: 0, replacedChecks: 0, wholeChecks: 0,
    tabVersionPresses: 0, stayedChanges: 0, quietUndos: 0, twoDrafts: 0, twoDraftsMoved: 0, twoDraftsGained: 0, structureAfter: 0, undoReapply: 0, matchingChecks: 0, tokenSplit: 0, liveTokenDeleted: 0,
    resetCopyObserved: 0, kinds: {},
  };
  const outcomes = [];
  const track = (d) => (all.push(d), d);
  let peer = 100;
  const next = () => String(++peer);

  const live = track(RoomDocs.create(shape, "1"));
  let liveTab;
  let fork;
  let tab;
  let tabLive;
  const deleted = new Set();
  const touched = new Set();
  /** Blocks whose marks a Discard, Undo or restore wrote back as the fork's own: Live's later unmark leaves its copy. */
  const markCopied = new Set();
  const markCopies = (changes) => {
    for (const c of changes)
      if (c.key !== STRUCTURE_KEY && c.doc.diff(c.before, c.after, false).some(([, d]) => d.type === "text" && d.diff.some((op) => op.attributes))) markCopied.add(c.key);
  };
  const liveTokenBlock = new Map();
  const liveTokenIds = new Map();
  const draftDeletedChars = new Set();
  const resetRestored = new Map();
  const inverseCopies = new Map();
  /** The token each character was first seen in, by block and character id: ids repeat across text docs. */
  const origins = new Map();
  let liveWrites = 0;
  /** Press Undos that left a change: Live keeps that press's write, so an earlier press can't bring Live back. */
  let kept = 0;
  /** Every write to any copy: an Undo with none since its press must take every change back. */
  let writes = 0;
  /**
   * What each Undo put back, by the probe's own record (never the take-back messages the model reads): per text
   * doc, a put-back character's id to the character it stands for.
   */
  const putBack = new Map();
  /** Whether character `id` of text doc `key` is one of `ids`, or stands for one through the Undos that put it back. */
  const isOneOf = (key, id, ids) => {
    for (let at = id; at; at = putBack.get(`${key}|${at}`)) if (ids.has(at)) return true;
    return false;
  };
  /**
   * An Undo of `edit` (`textWrite`) that wrote `undone` in doc `key` went back whole: it put back every character
   * the edit deleted, in order, each standing for the one it replaces.
   */
  function putBackWhole(key, edit, undone, what) {
    const want = edit.deleted.map((c) => c.ch).join("");
    const got = (undone?.inserted ?? []).map((c) => c.ch).join("");
    check(got === want, "undo-whole", () => `${what} of ${key} put back "${got}", not the "${want}" the edit deleted`);
    undone?.inserted.forEach((c, i) => putBack.set(`${key}|${c.id}`, edit.deleted[i].id));
  }
  /** The positions in `doc` (text doc `key`) of the characters `ids`: themselves, or ones an Undo put back for them. */
  const placeAt = (doc, key, ids) => charIds(doc).flatMap((id, i) => (id && isOneOf(key, id, ids) ? [i] : []));

  const row = (d, id) => {
    if (!d) return "(hidden)";
    const view = new StructureView(d);
    if (!view.shown.has(id)) return "(hidden)";
    const text = deltaOf(d.textOf(id)).map((r) => (r.attributes ? `{${r.insert}:${Object.keys(r.attributes)}}` : r.insert)).join("");
    return `${view.value("node", id)}<${String(view.value("parent", id) ?? "-").slice(0, 4)}|${String(view.value("order", id)).slice(0, 3)}>${JSON.stringify(view.attrs(id))}[${text}]`;
  };
  const trace = () => {
    const ids = new Set();
    for (const d of [live, fork, tab]) if (d) for (const id of new StructureView(d).shown) ids.add(id);
    for (const id of [...ids].sort()) {
      const l = row(live, id);
      const f = row(fork, id);
      const t = row(tab, id);
      if (l !== f || f !== t) say(`     ${id.slice(0, 4)} L ${l}\n          F ${f}${t !== f ? `\n          T ${t}` : ""}`);
    }
  };
  // The overrides in force: a press's settled ones read as Live's.
  const overrides = () => {
    if (!fork) return "";
    const view = new StructureView(fork);
    return STRUCTURE_MAPS.flatMap((name) =>
      view.overrideKeys(name).map((key) => `${name}:${key.slice(0, 4)}${key.includes("/") ? key.slice(key.indexOf("/")) : ""}=${JSON.stringify(view.override(name, key))?.slice(0, 12)}`),
    ).join(" ");
  };
  const note = (s) => {
    if (!verbose) return;
    say(s);
    if (process.env.FUZZ_TRACE) {
      trace();
      say("     overrides:", overrides());
    }
  };

  /** `to` imports what `from` holds beyond it: one sync of two copies. */
  function send(from, to) {
    const tabStructure = () => versionOf(live.structure, live.structure.frontiers()).get(liveTab?.peer) ?? 0;
    const tabWrote = to === live && from === liveTab ? tabStructure() : null;
    const r = to.importBatch(from.exportSince(to.shownVersion()));
    check(!r.pending, "pending-import", "an import waited on ops the copy lacks");
    // A restore Live writes, or one its tab wrote reaching it (Live typing answering a removal), is a Live write.
    if ((to === live && r.restore.length > 0) || (tabWrote !== null && tabStructure() > tabWrote)) liveWrites++;
  }
  function sync(a, b) {
    send(a, b);
    send(b, a);
  }
  /**
   * Run a press or its Undo on a command's own copy of draft room `d`, as the server does: each side gets a fresh
   * peer, so every later write is someone else's. Then each room imports only the changes the press returned,
   * Live's first, encoded as the server commits them (`encodeChanges`): a write the press made but did not
   * return never reaches a room. `view` reads what the caller keeps while the copy's docs still live.
   */
  function command(d, run, view = (r) => r) {
    const cmd = d.fork(next());
    try {
      const r = run(cmd);
      commit(d.live, r.live);
      // A room forwards its forks on every Live commit, before the fork's own batch lands.
      d.forward();
      commit(d, r.fork);
      d.forward();
      return view(r);
    } finally {
      cmd.free();
    }
  }
  function commit(to, changes) {
    if (changes.length === 0) return;
    const imported = to.importBatch(decodeEnvelope(encodeChanges(changes)));
    check(!imported.pending, "pending-import", "a press's changes waited on ops the room lacks");
    if (to === live && imported.restore.length > 0) liveWrites++;
  }
  /** A press's changes as `press_changes` stores them: JSON. */
  const stored = (pressed) => JSON.parse(JSON.stringify(pressed));
  const fwdLive = () => fork.forward();
  function syncLive() {
    sync(liveTab, live);
    if (fork) fwdLive();
  }
  /** The Draft tab: its writes reach the fork room; its Live copy and its fork copy catch up. */
  function syncTab() {
    if (!fork) return;
    send(tab, fork);
    fwdLive();
    toTab();
  }
  function toTab() {
    send(live, tabLive);
    tab.forward();
    send(fork, tab);
  }
  const pending = () => {
    fwdLive();
    return changedBlocks(fork);
  };
  const pendingIds = () => pending().flatMap((c) => [...c.blocks, ...c.comments]);
  function ensure() {
    if (fork) return;
    syncLive();
    fork = track(RoomDocs.draftOf(live, "10"));
    tabLive = track(live.fork(next()));
    tab = track(RoomDocs.draftOf(tabLive, next()));
    send(fork, tab);
    note("fork created");
  }
  function recordOrigins(d) {
    for (const id of new StructureView(d).shown) {
      const td = d.textOf(id);
      if (!td) continue;
      const text = textOfDoc(td);
      const cs = charIds(td);
      for (const m of text.matchAll(new RegExp(TOKEN.source, "g")))
        for (const c of cs.slice(m.index, m.index + m[0].length)) if (c && !origins.has(`${id}|${c}`)) origins.set(`${id}|${c}`, m[0]);
    }
  }
  const records = (changes) => changes.map((c) => ({ id: c.key === STRUCTURE_KEY ? null : c.key, doc: c.doc, before: c.before, after: c.after }));

  const overridesNow = (d) => {
    const view = new StructureView(d);
    return new Map(["parent", "order", "node", "attrs"].flatMap((name) => view.overrideKeys(name).map((key) => [`${name}\n${key}`, JSON.stringify(view.override(name, key))])));
  };

  /** No override this write set on `blocks` equals Live's (one Live later caught up with is the draft's own). */
  function matching(d, blocks, editedComments, shownBefore, prior) {
    if (!d.draft) return;
    const view = new StructureView(d);
    const written = (name, key) => prior.get(`${name}\n${key}`) !== JSON.stringify(view.override(name, key));
    const removed = new Set([...shownBefore].filter((id) => !view.shown.has(id)));
    const carried = carriers(d);
    for (const name of ["parent", "node", "attrs", "comments"])
      for (const key of view.overrideKeys(name)) {
        const relevant =
          name === "comments"
            ? editedComments.has(key) || [...blocks].some((id) => carried.get(id)?.has(key))
            : blocks.has(name === "attrs" ? key.split("/")[0] : key) && written(name, key);
        if (!relevant) continue;
        const base = view.baseValue(name, key);
        check(!same(name === "attrs" ? (base ?? null) : base, view.override(name, key)), "matching-override", `${name}/${key} matches Live`);
      }
    for (const id of view.overrideKeys("order"))
      if (blocks.has(id) && written("order", id))
        check(!sameOrderAsBase(view, id, removed), "matching-override", () => `order/${id} matches Live relative position: override ${view.override("order", id)} base ${view.baseValue("order", id)} siblings ${view.children(view.parent(id) ?? null).map((o) => `${o.slice(0, 4)}=${view.order(o)}`)} all ${view.ids.filter((o) => view.value("parent", o) === view.value("parent", id)).map((o) => `${o.slice(0, 4)}=${String(view.value("order", o)).slice(0, 8)}${view.shown.has(o) ? "" : "(hidden)"}`)} parent ${JSON.stringify(view.baseValue("parent", id))}/${JSON.stringify(view.value("parent", id))}`);
    stats.matchingChecks++;
  }

  /** One writer's edit: random, or `opts.edit` (a prepared `{ kind, build }`). */
  function userEdit(d, origin, opts = {}) {
    recordOrigins(d);
    const pm = read(d);
    const e = opts.edit ?? randomEdit(g, pm, origin, { commentsHere: [...comments(d)], ...opts });
    if (!e) return null;
    const old = blockValues(d);
    const before = tokens(d);
    const shown = new StructureView(d).shown;
    const oldIds = new Map([...shown].map((id) => [id, charIds(d.textOf(id))]));
    const b0 = d.structure.frontiers();
    const prior = d.draft ? overridesNow(d) : null;
    for (const [id, body] of e.comments ?? []) setCommentBody(d, id, body);
    let built = null;
    const changed = e.write
      ? records(e.write(d))
      : e.build
      ? records(edit(d, (tr, doc) => {
          built = e.build(tr, doc);
          return built;
        }, { rng: g.rng, by: opts.by }))
      : [];
    if (built?.docChanged)
      check(built.doc.eq(read(d)), "binding", () => `codec failed round trip for ${e.kind}: expected ${JSON.stringify(built.doc.toJSON())}; got ${render(d)}`);
    const b1 = d.structure.frontiers();
    if (!same(b0, b1)) {
      const r = changed.find((x) => x.id === null);
      if (r) r.before = b0;
      else changed.unshift({ id: null, doc: d.structure, before: b0, after: b1 });
    }
    recordOrigins(d);
    writes++;
    const after = tokens(d);
    const now = new Set(after);
    const fresh = blockValues(d);
    const modified = new Set([...new Set([...old.keys(), ...fresh.keys()])].filter((id) => old.get(id) !== fresh.get(id)));
    matching(d, modified, new Set((e.comments ?? []).map(([id]) => id)), shown, prior);
    for (const t of before) if (!now.has(t)) deleted.add(t);
    if (d === liveTab) {
      liveWrites++;
      const bs = tokenBlocks(d);
      for (const token of after)
        if (!before.includes(token) && token.startsWith("l")) {
          const id = bs.get(token);
          const td = d.textOf(id);
          const pos = textOfDoc(td).indexOf(token);
          liveTokenBlock.set(token, id);
          if (pos >= 0) liveTokenIds.set(token, charIds(td).slice(pos, pos + token.length));
        }
    } else {
      for (const [id, beforeIds] of oldIds) {
        const afterIds = new Set(charIds(d.textOf(id)));
        for (const charId of beforeIds) if (charId && !afterIds.has(charId)) draftDeletedChars.add(charId);
      }
      for (const id of modified) touched.add(id);
      if (e.comments) {
        const ids = new Set(e.comments.map(([id]) => id));
        for (const [id, set] of carriers(d)) if ([...set].some((c) => ids.has(c))) touched.add(id);
      }
    }
    stats.kinds[e.kind] = (stats.kinds[e.kind] ?? 0) + 1;
    note(`  ${origin} ${e.kind}`);
    return { e, changed };
  }

  /** Record characters an inverse created in a text doc (the N7 copy) and tokens it gave back. */
  function rememberInverse(td, id, beforeIds) {
    if (!td || !id) return;
    const old = new Set(beforeIds);
    const text = textOfDoc(td);
    const ids = charIds(td);
    const lt = live.textOf(id);
    // An Undo of a discard writes back a copy the discard had removed: the block stays a copy.
    if ((lt && textOfDoc(lt) === text) || inverseCopies.has(id)) {
      const original = new Set(charIds(lt));
      for (const c of ids)
        if (c && !old.has(c) && !original.has(c)) {
          if (!inverseCopies.has(id)) inverseCopies.set(id, new Set());
          inverseCopies.get(id).add(c);
        }
    }
    for (const match of text.matchAll(new RegExp(TOKEN.source, "g"))) {
      const at = match.index;
      if (ids.slice(at, at + match[0].length).some((c) => c && !old.has(c)) && textOfDoc(live.textOf(id)).includes(match[0]))
        resetRestored.set(match[0], id);
    }
  }
  const snapshotIds = (d) => new Map([...d.texts].map(([id, td]) => [id, charIds(td)]));
  function rememberAll(d, before) {
    for (const [id, td] of d.texts) rememberInverse(td, id, before.get(id) ?? []);
  }

  /** A Live change made after the fork's last write of a block must reach the fork's read. */
  function structureAfter(candidates) {
    const pendingNow = new Set(pendingIds());
    const liveView = new StructureView(live);
    const id = candidates.find((x) => !pendingNow.has(x) && liveView.shown.has(x) && liveView.value("node", x) === "paragraph");
    if (!id) return;
    const b = fork.fork(next());
    try {
      const a = b.live;
      const view = new StructureView(a);
      const kinds = ["level", "align", "move"];
      let kind = kinds[stats.structureAfter % 3];
      const siblings = view.children(view.value("parent", id) ?? null);
      if (kind === "move" && siblings.length < 2) kind = "align";
      let key;
      let want;
      if (kind === "move") {
        const rest = siblings.filter((x) => x !== id);
        const first = siblings.at(-1) === id;
        const lo = first ? null : view.value("order", rest.at(-1));
        const hi = first ? view.value("order", rest[0]) : null;
        key = id;
        want = keyBetweenFixed(lo, hi);
        inMap(a.structure, "order", (m) => m.set(key, want));
      } else {
        key = `${id}/${kind}`;
        const old = view.value("attrs", key);
        want = kind === "level" ? (old === 2 ? 3 : 2) : old === "center" ? "right" : "center";
        inMap(a.structure, "attrs", (m) => m.set(key, want));
      }
      a.structure.commit();
      b.forward();
      const after = new StructureView(b);
      check(after.value(kind === "move" ? "order" : "attrs", key) === want && !changedBlocks(b).some((c) => c.blocks.includes(id)), "stale-override", `Live ${kind} did not reach ${id}`);
      stats.structureAfter++;
    } finally {
      b.free();
    }
  }

  /** After an Undo, each block it returned to pending applies and discards cleanly. */
  function undoCheck(ids) {
    const now = pendingIds();
    for (const id of ids) {
      check(now.includes(id), "undo-pending", `block ${id} not pending after Undo`);
      for (const mode of ["apply", "discard"]) {
        const b = fork.fork(next());
        try {
          if (mode === "apply") applyBlocks(b, [id], { liveVersion: b.live.version() });
          else discardBlocks(b, [id]);
          check(!changedBlocks(b).some((c) => c.blocks.includes(id) || c.comments.includes(id)), `undo-${mode}`, () => `${mode} after Undo left ${id} pending: live ${JSON.stringify(deltaOf(b.live.textOf(id)))} fork ${JSON.stringify(deltaOf(b.textOf(id)))} bodies live ${JSON.stringify(new StructureView(b.live).value("comments", "c0"))} fork ${JSON.stringify(new StructureView(b).value("comments", "c0"))}`);
        } finally {
          b.free();
        }
      }
      stats.undoReapply++;
    }
  }

  function liveEdit(structure = g.chance(0.3)) {
    userEdit(liveTab, "l", { structure });
    stats.liveEdits++;
    if (g.chance(0.8)) syncLive();
  }
  function writerEdit(prefer = []) {
    ensure();
    const before = render(tab);
    const r = userEdit(tab, "f", { prefer });
    stats.edits++;
    if (r?.changed.length && g.chance(0.18)) {
      // The writer's Ctrl+Z of the edit just made, as one edit through the shared rule and the server's text inverse.
      const ctrlz = { peer: tab.peer, values: new Map(), texts: new Map(), leaving: new Map(), arriving: new Set(), shown: new Set(), structureAt: [] };
      for (const rec of r.changed)
        if (rec.id === null) valuesOf(rec.doc, rec.before, rec.after, ctrlz.values);
        else ctrlz.texts.set(rec.id, { before: rec.before, after: rec.after, ops: opsBetween(rec.doc, rec.before, rec.after, tab.peer) });
      noteEdit(tab, ctrlz);
      const view = new StructureView(tab);
      const why = editStays(tab, ctrlz, view);
      check(why === null, "ctrlz", () => `the edit just made stays: ${why}`);
      const undone = textWrites(takeBack(tab, [ctrlz], view, "ctrlz"));
      for (const rec of r.changed) if (rec.id !== null) putBackWhole(rec.id, textWrite(rec.doc, rec.before, rec.after), undone.get(rec.id), "Ctrl+Z");
      recordOrigins(tab);
      stats.ctrlz++;
      note("  CTRLZ");
      check(render(tab) === before, "ctrlz", () => `tab not back to before edit:\n${before}\n${render(tab)}`);
    }
    if (g.chance(0.6)) syncTab();
  }
  function aiTurn(n) {
    ensure();
    syncTab();
    const work = fork.fork(next());
    const edits = [];
    try {
      for (let i = 0; i < n; i++) {
        const since = work.shownVersion();
        const r = userEdit(work, "a", { by: { turn: "turn" } });
        stats.edits++;
        if (!r) continue;
        edits.push(editSince(work, since, work.peer, new Set(r.changed.map((rec) => rec.id ?? STRUCTURE_KEY))));
      }
      send(work, fork);
    } finally {
      work.free();
    }
    toTab();
    return { edits };
  }
  /** `Restore before` the turn: its writes taken back by the Undo rule, newest first (design §2). */
  function restore(turn) {
    syncTab();
    fwdLive();
    const prior = textValues(fork);
    const before = snapshotIds(fork);
    markCopies(undoEdits(fork, [...turn.edits].reverse(), { press: "restore" }).changes);
    recordOrigins(fork);
    rememberAll(fork, before);
    toTab();
    stats.restores++;
    note("  RESTORE");
    const now = textValues(fork);
    structureAfter([...now.keys()].filter((id) => now.get(id) !== prior.get(id)));
  }
  function markerAttrs(d, id, token) {
    const delta = deltaOf(d.textOf(id));
    const text = delta.map((p) => p.insert).join("");
    const start = text.indexOf(token);
    if (start < 0) return null;
    let offset = 0;
    const attrs = [];
    for (const span of delta)
      for (let i = 0; i < span.insert.length; i++, offset++)
        if (offset >= start && offset < start + token.length) attrs.push(span.attributes ?? {});
    return attrs;
  }
  function typeIn(d, id, token) {
    let position = null;
    read(d).descendants((node, pos) => {
      if (node.isTextblock && node.attrs.id === id) position = pos + node.nodeSize - 1;
    });
    if (position === null) return false;
    if (d === liveTab) liveWrites++;
    writes++;
    edit(d, (tr) => tr.insertText(` ${token} `, position), { rng: g.rng });
    return true;
  }

  /**
   * A Work's `Apply all` over two drafts that both rewrite one paragraph (design §2): pressed one after the other on
   * a copy of the Live room, each on Live as the one before left it, then undone draft by draft in the reverse
   * order, each from what it stored. Live typing may land between the presses. Leaves the script's copies alone.
   */
  function twoDrafts() {
    syncLive();
    const room = track(live.fork(next()));
    const view = new StructureView(room);
    const paragraphs = [...view.shown].filter((id) => view.node(id) === "paragraph" && textOfDoc(room.textOf(id)));
    if (!paragraphs.length) return;
    const id = g.pick(paragraphs);
    const drafts = [track(RoomDocs.draftOf(room, next())), track(RoomDocs.draftOf(room, next()))];
    const original = charIds(room.textOf(id));
    const deletedBy = [];
    for (const [i, d] of drafts.entries()) {
      let block = null;
      read(d).descendants((node, pos) => {
        if (node.isTextblock && node.attrs.id === id) block = { from: pos + 1, size: node.content.size };
      });
      const from = g.int(block.size + 1);
      const to = from + g.int(Math.min(6, block.size - from) + 1);
      edit(d, (tr) => tr.insertText(` d${i}${seed}k `, block.from + from, block.from + to), { rng: g.rng });
      const kept = new Set(charIds(d.textOf(id)));
      deletedBy.push(new Set(original.filter((c) => !kept.has(c))));
    }
    // Characters both drafts deleted: the second press's import deleted them again, but its Undo took that back, so
    // the first press goes back too (design §2), and puts them back into Live as new characters the second draft
    // never deleted.
    const bothDeleted = [...deletedBy[0]].filter((c) => deletedBy[1].has(c)).length;
    const before = render(room);
    const draftsBefore = drafts.map((d) => {
      d.forward();
      return textOfDoc(d.textOf(id));
    });
    const liveToken = `y${seed}0wk`;
    const liveTyped = g.chance(0.4);
    const pressed = [];
    for (const [i, d] of drafts.entries()) {
      if (i === 1 && liveTyped) typeIn(room, id, liveToken);
      pressed.push(command(d, (cmd) => applyBlocks(cmd, "all", { by: { press: `work press ${i}` }, liveVersion: room.version() }), (r) => stored(r.pressed)));
    }
    for (const d of drafts) {
      d.forward();
      check(!changedBlocks(d).length, "two-drafts", () => `a draft still pending after Apply all: ${JSON.stringify(changedBlocks(d))}`);
    }
    for (let i = drafts.length - 1; i >= 0; i--) {
      const { stayed } = command(drafts[i], (cmd) => undoPress(cmd, pressed[i], { by: { press: `work press undo ${i}` } }));
      check(!stayed.length, "two-drafts", () => `draft ${i}'s press stayed: ${JSON.stringify(stayed.map((c) => c.members))}`);
    }
    const liveIds = new Set(charIds(room.textOf(id)));
    for (const [i, d] of drafts.entries()) {
      d.forward();
      const changes = changedBlocks(d);
      check(changes.length === 1 && same(changes[0].blocks, [id]), "two-drafts", () => `draft ${i} pending ${JSON.stringify(changes)} after the Undo, not ${id}`);
      // The draft's text is back (as new characters of its own: the return to pending). Beside it are only Live's
      // characters: its typing, and text both drafts deleted that the other press's Undo put back as new
      // characters, which this draft never deleted (the accepted copy of design §2: Loro has no undelete).
      const text = textOfDoc(d.textOf(id));
      const ids = charIds(d.textOf(id));
      const live = (at) => liveIds.has(ids[at]);
      if (!withExtras(draftsBefore[i], text, live)) {
        // Text the other draft deleted comes back as one run of new characters, placed by Loro beside this
        // draft's own re-created insertion at the same gap: on either side. Counted, not failed (reported to
        // the text Undo redesign); a character the draft had that is gone still fails.
        const left = [...text];
        for (const ch of draftsBefore[i]) {
          const at = left.indexOf(ch);
          check(at >= 0, "two-drafts", () => `draft ${i} lost "${ch}" to the Undo: ${draftsBefore[i]} -> ${text}`);
          left.splice(at, 1);
        }
        stats.twoDraftsMoved++;
      }
      if (!liveTyped) {
        // Text both drafts deleted, which the first press's Undo put back, shows in the second draft (counted, not
        // failed: design §2, "Text both drafts deleted"); nothing else may come in.
        const gained = text.length - draftsBefore[i].length;
        check(gained === 0 || (i === 1 && gained <= bothDeleted), "two-drafts", () => `draft ${i} gained text from the Undo: ${draftsBefore[i]} -> ${text}`);
        if (gained > 0) stats.twoDraftsGained++;
      }
    }
    const liveText = textOfDoc(room.textOf(id));
    if (liveTyped) check(liveText.includes(liveToken), "two-drafts", "Live typing between the presses lost by the Undo");
    if (!liveTyped) check(render(room) === before, "two-drafts", () => `Live not back after the Undo: ${before} -> ${render(room)}`);
    stats.twoDrafts++;
    note("  TWO DRAFTS");
  }

  /**
   * The press's replacements in Live's text (a deletion and an insertion at one place), each with the characters it
   * put in: where a later write goes.
   */
  const replacements = (written) =>
    [...written].flatMap(([key, { places }]) =>
      places
        .filter((place) => place.deleted.length && place.inserted.length)
        .map((place) => ({ key, ids: new Set(place.inserted.map((c) => c.id)) })),
    );

  function press(prefer = [], only = false) {
    syncLive();
    syncTab();
    const groups = pending();
    if (!groups.length) return null;
    const wanted = prefer.length ? groups.filter((c) => c.blocks.some((id) => prefer.includes(id))) : [];
    let selection = only ? wanted : (wanted.length && g.chance(0.7) ? wanted : groups).filter(() => g.chance(0.5));
    if (!selection.length) selection = [g.pick(wanted.length ? wanted : groups)];
    const chosen = selection.flatMap((c) => [...c.blocks, ...c.comments]);
    const before = render(live);
    const fbefore = render(fork);
    const oldBlocks = blockValues(live);
    const liveView = new StructureView(live);
    const forkView = new StructureView(fork);
    const leaf = chosen.find((id) => fork.texts.has(id) && live.texts.has(id) && liveView.shown.has(id) && forkView.shown.has(id));
    const late = leaf && g.chance(0.7) ? track(fork.fork(next())) : null;
    const draftToken = `x${seed}0${stats.presses}k`;
    const liveToken = `y${seed}0${stats.presses}k`;
    const lateTyped = late && typeIn(late, leaf, draftToken);
    const liveTyped = leaf && g.chance(0.7) && typeIn(liveTab, leaf, liveToken);
    // What the writer was shown: the Live tab's copy, or the Changes list's, read on the server just now.
    const fromTab = g.chance(0.5);
    if (fromTab) stats.tabVersionPresses++;
    const liveVersion = fromTab ? tabLive.version() : live.version();
    const { r, written } = command(
      fork,
      (cmd) => applyBlocks(cmd, chosen, { by: { press: `${stats.presses}` }, liveVersion }),
      (r) => ({ r, written: textWrites(r.live) }),
    );
    const liveKeys = [...written.keys()];
    const replaced = replacements(written);
    const ids = r.chosen.flatMap((c) => [...c.blocks, ...c.comments]);
    stats.presses++;
    note(`  PRESS ${chosen.map((x) => x.slice(0, 4))} -> ${ids.map((x) => x.slice(0, 4))}`);
    check(render(fork) === fbefore, "apply", "fork changed during Apply");
    const after = pendingIds();
    for (const id of chosen) check(!after.includes(id), "apply", () => `block ${id} still pending after Apply: live ${blockValues(live).get(id)} fork ${blockValues(fork).get(id)}`);
    structureAfter(ids);
    const newBlocks = blockValues(live);
    for (const [id, b] of oldBlocks) if (!ids.includes(id) && newBlocks.has(id)) check(b === newBlocks.get(id), "apply", () => `unchosen block ${id} changed: ${b} -> ${newBlocks.get(id)}`);
    const again = fork.fork(next());
    try {
      const r2 = applyBlocks(again, chosen, { liveVersion: live.version() });
      check(r2.pressed.every((c) => !c.live && !c.fork), "apply", "applying again was not a no-op");
    } finally {
      again.free();
    }
    if (liveTyped) {
      syncLive();
      stats.unsyncedLive++;
      const contains = (d) => {
        const text = textOfDoc(d.textOf(leaf));
        let i = 0;
        for (const ch of text) if (ch === liveToken[i]) i++;
        return i === liveToken.length;
      };
      check(contains(live) && contains(fork), "unsynced-live", () => `unsynced ${liveToken}: live ${blockValues(live).get(leaf)} fork ${blockValues(fork).get(leaf)}`);
    }
    if (lateTyped) {
      send(late, fork);
      stats.lateDraft++;
      check(textOfDoc(fork.textOf(leaf)).includes(draftToken) && pendingIds().includes(leaf), "late-draft", "typing after Apply not pending");
      touched.add(leaf);
      toTab();
    }
    const result = { r, keptAt: kept, beforeBlocks: oldBlocks, pressed: stored(r.pressed), liveKeys, before, fbefore, chosen, ids, liveTyped, lateTyped, liveAt: liveWrites, writesAt: writes, afterLive: blockValues(live), afterFork: blockValues(fork), written, replaced };
    return result;
  }

  /** Undo a press. `exact`: nothing but later presses (all undone since) touched Live after it. */
  function undoPressStep(p, { exact, inTurn }) {
    syncTab();
    fwdLive();
    const fb = render(fork);
    const ft = textValues(fork);
    const beforeLive = blockValues(live);
    const beforeFork = blockValues(fork);
    // The docs where a later write removed some of what the press put in (by id, or put back for it by a later
    // Undo; never by what it spells).
    const expectGone = [...p.written]
      .filter(([key, { inserted }]) => inserted.length && placeAt(live.texts.get(key), key, new Set(inserted.map((c) => c.id))).length < inserted.length)
      .map(([key]) => key);
    const liveBefore = snapshotIds(live);
    const forkBefore = snapshotIds(fork);
    const { stayed, undone } = command(
      fork,
      (cmd) => {
        const u = undoPress(cmd, p.pressed, { by: { press: "press undo" } });
        markCopies(u.fork);
        return u;
      },
      (u) => ({ stayed: u.stayed, undone: textWrites(u.live) }),
    );
    stats.stayedChanges += stayed.length;
    if (stayed.length) kept++;
    const stayedIds = new Set(stayed.flatMap((c) => c.members));
    // Nothing wrote over the press since: every change goes back.
    if (inTurn && writes === p.writesAt && !p.liveTyped && !p.lateTyped) {
      stats.quietUndos++;
      check(!stayed.length, "press-undo", () => `a change stayed with nothing written since the press: ${JSON.stringify(stayed.map((c) => c.members))}`);
    }
    // A later write removed some of what the press put in: the change stays, so the Undo neither puts the old text
    // back beside or inside the later write nor takes the press's characters it kept out of it.
    for (const key of expectGone) {
      stats.replacedChecks++;
      check(stayedIds.has(key) && same(charIds(live.texts.get(key)), liveBefore.get(key)), "undo-replaced", () => `Undo of a press a later write partly removed changed ${key} (stayed ${stayedIds.has(key)}): ${textOfDoc(live.texts.get(key))}`);
    }
    // A change that went back went back whole: every character the press deleted is back, and none it put in is left.
    for (const [key, edit] of p.written) {
      if (stayedIds.has(key)) continue;
      putBackWhole(key, edit, undone.get(key), "the press Undo");
      const mine = new Set(edit.inserted.map((c) => c.id));
      const left = placeAt(live.texts.get(key), key, mine);
      check(!left.length, "undo-whole", () => `the press Undo of ${key} left ${left.length} of the press's characters: ${textOfDoc(live.texts.get(key))}`);
      stats.wholeChecks++;
    }
    recordOrigins(live);
    recordOrigins(fork);
    for (const key of p.liveKeys) {
      rememberInverse(live.texts.get(key), key, liveBefore.get(key) ?? []);
      const td = fork.texts.get(key);
      if (td) {
        rememberInverse(td, key, forkBefore.get(key) ?? []);
        const kept = new Set(charIds(td));
        for (const ch of charIds(live.texts.get(key))) if (ch && !kept.has(ch)) draftDeletedChars.add(ch);
      }
    }
    fwdLive();
    send(live, liveTab);
    toTab();
    stats.pressUndos++;
    note(`  UNDO PRESS${inTurn ? "" : " (out of order)"}`);
    const afterLive = p.afterLive;
    const afterFork = p.afterFork;
    // A change that stayed wrote nothing.
    const liveNow = blockValues(live);
    const forkNow = blockValues(fork);
    for (const id of stayedIds) check(liveNow.get(id) === beforeLive.get(id) && forkNow.get(id) === beforeFork.get(id), "press-undo", () => `${id}, of a change that stayed, changed`);
    undoCheck(p.ids.filter((id) => !stayedIds.has(id) && (afterLive.has(id) || afterFork.has(id))).filter((id) => afterLive.get(id) === beforeLive.get(id) && afterFork.get(id) === beforeFork.get(id)));
    if (inTurn) {
      const now = blockValues(fork);
      check(render(fork) === fb, "press-undo", () => `fork changed by press Undo: ${[...new Set([...beforeFork.keys(), ...now.keys()])].filter((id) => beforeFork.get(id) !== now.get(id)).map((id) => `${id}: ${beforeFork.get(id)} -> ${now.get(id)}`).join("; ")}`);
    }
    else {
      const now = textValues(fork);
      for (const [id, text] of ft) if (now.has(id)) check(now.get(id) === text, "press-undo", () => `draft text of ${id} changed by an out-of-order press Undo: ${text} -> ${now.get(id)}`);
    }
    if (exact && !stayed.length && kept === p.keptAt)
      check(render(live) === p.before, "press-undo", () => {
        const now = blockValues(live);
        return `Live not back to before Apply: ${[...new Set([...p.beforeBlocks.keys(), ...now.keys()])].filter((id) => p.beforeBlocks.get(id) !== now.get(id)).map((id) => `${id} ${p.beforeBlocks.get(id)} -> ${now.get(id)}`).join("; ")}`;
      });
  }

  /**
   * A write of text doc `key` as the editor's typing writes it (`replaceText`, by shown unit): each span's [from, to)
   * becomes its `text`, right to left so the positions hold.
   */
  const typeOver = (key, rule, spans) => (w) => {
    const { doc, before } = w.writableText(key);
    const rules = { rule, shape, visibleComment: commentVisibility(structureValues(w)) };
    for (const { from, to, text } of [...spans].sort((x, y) => y.from - x.from))
      replaceText(doc, rules, from, to, text ? [{ kind: "text", text, marks: {} }] : []);
    doc.commit();
    return [{ key, doc, before, after: doc.frontiers() }];
  };

  /** Replace or delete, in Live or in the draft, text a press put in (design §2's "later write"). */
  function overwrite(p, side) {
    const place = g.pick(p.replaced.length ? p.replaced : [null]);
    const key = place?.key ?? g.pick([...p.liveKeys, null]);
    if (!key) return;
    const d = side === "live" ? liveTab : tab;
    if (side === "live") syncLive();
    else syncTab();
    const doc = d.textOf(key);
    const view = new StructureView(d);
    if (!doc || !view.shown.has(key)) return;
    const text = textOfDoc(doc);
    // The units the press put in, found by identity: all of them most of the time (the case the edit rule's
    // part 4 decides), else a part.
    const mine = place ? placeAt(doc, key, place.ids) : [];
    let from;
    let to;
    if (mine.length) {
      from = mine[0];
      to = mine.at(-1) + 1;
      if (g.chance(0.3)) to = from + 1 + g.int(to - from);
    } else {
      const words = [...text.matchAll(/\S+/g)];
      if (!words.length) return;
      const w = g.pick(words);
      from = w.index;
      to = w.index + w[0].length;
    }
    const rule = shape.node(view.node(key));
    const units = textUnits(doc, rule, shape);
    const shownIndex = (raw) => units.slice(0, raw).filter((u) => !u.hidden).length;
    const a = shownIndex(from);
    const b = shownIndex(to);
    const origin = side === "live" ? "l" : "f";
    // Over the press's text, also a retype that holds it ("home" pressed to "house", then "household") or is held by
    // it ("hous"), typing right after it, which may be text an Undo put back: none of it is the press's; and a
    // rewrite that keeps one of the press's characters inside its own text, as a chat's rewrite keeps the letters
    // it shares with what it replaces.
    const kind = mine.length
      ? g.pick(["overwrite", "overwrite", "overdelete", "overdelete", "holds", "held", "after", "rewrite"])
      : g.pick(["overwrite", "overdelete"]);
    const pressed = text.slice(from, to);
    const replacement = {
      overwrite: g.tok(origin),
      holds: g.chance(0.5) ? `${pressed}ed` : `re${pressed}`,
      held: pressed.slice(0, Math.max(1, pressed.length - 1 - g.int(Math.max(1, pressed.length - 1)))),
      after: ` ${g.tok(origin)}`,
    }[kind];
    // By position, as the editor's typing is: every character typed is new, so a retype can spell the press's
    // text without being it.
    const keep = kind === "rewrite" ? shownIndex(g.pick(mine)) : 0;
    const spans =
      kind === "rewrite"
        ? [
            { from: a, to: keep, text: g.tok(origin) },
            { from: keep + 1, to: Math.max(keep + 1, b), text: g.tok(origin) },
          ]
        : [{ from: kind === "after" ? b : a, to: b, text: replacement ?? "" }];
    userEdit(d, origin, { edit: { kind, write: typeOver(key, rule, spans) } });
    stats.overwrites++;
    if (side === "live") syncLive();
    else syncTab();
  }

  /**
   * The draft replaces a word, or two, the press applies it alone, a later write in Live or the draft replaces or
   * deletes what the press put in at one place (wholly or in part), and the press is undone: design §2's edit rule,
   * part 4. With two words and one of them retyped in Live, the change stays whole ("the fox went home" pressed as
   * "the dog went house", "dog" retyped "cat": Live keeps "the cat went house"), as Ctrl+Z's does.
   */
  function replaceThenOverwrite() {
    ensure();
    syncTab();
    const blocks = [...textblocks(tab)].filter(([, node]) => node.type.name === "paragraph" && /\S/.test(node.textContent));
    if (!blocks.length) return;
    // A block with nothing pending, so the press replaces only these words.
    const pendingNow = new Set(pendingIds());
    const clean = blocks.filter(([id]) => !pendingNow.has(id));
    const [id, node] = g.pick(clean.length ? clean : blocks);
    if (node.content.childCount !== 1) return;
    const words = [...node.textContent.matchAll(/\S+/g)];
    const first = g.int(words.length);
    const picked = words.length > 1 && g.chance(0.5) ? [first, (first + 1 + g.int(words.length - 1)) % words.length] : [first];
    const spans = picked.map((i) => ({ from: words[i].index, to: words[i].index + words[i][0].length, text: g.tok("f") }));
    userEdit(tab, "f", { edit: { kind: `replace${spans.length}`, write: typeOver(id, shape.node("paragraph"), spans) } });
    const p = press([id], true);
    if (!p) return;
    overwrite(p, g.chance(0.75) ? "live" : "draft");
    syncLive();
    undoPressStep(p, { exact: false, inTurn: true });
    stats.replaceThenOverwrite = (stats.replaceThenOverwrite ?? 0) + 1;
  }

  /** Two to five presses on the same blocks, undone newest first or in random order. */
  function chain() {
    ensure();
    const presses = [];
    let focus = [];
    const count = 2 + g.int(4);
    for (let i = 0; i < count; i++) {
      for (let k = 0, n = 1 + g.int(2); k < n; k++) writerEdit(focus);
      const p = press(focus);
      if (!p) continue;
      presses.push(p);
      stats.chainPresses++;
      focus = [...new Set([...focus, ...p.ids])];
      if (g.chance(0.35)) liveEdit(false);
    }
    if (!presses.length) return;
    stats.chains++;
    const inTurn = g.chance(0.6);
    const order = presses.map((_, i) => i);
    if (inTurn) order.reverse();
    else
      for (let i = order.length - 1; i > 0; i--) {
        const j = g.int(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
    for (const i of order) {
      const p = presses[i];
      if (g.chance(0.5)) overwrite(p, g.chance(0.7) ? "live" : "draft");
      if (g.chance(0.3)) userEdit(tab, "f", { prefer: p.ids });
      if (g.chance(0.25)) liveEdit(false);
      syncLive();
      undoPressStep(p, { exact: inTurn && liveWrites === p.liveAt && !p.liveTyped, inTurn });
      if (inTurn) stats.chainUndosInTurn++;
      else stats.chainUndosOutOfOrder++;
    }
  }

  function discard(all = false, named = null) {
    syncTab();
    const groups = pending();
    if (!groups.length) return null;
    const selected = all ? null : (groups.find((c) => c.blocks.includes(named)) ?? g.pick(groups));
    const chosen = all ? "all" : [...selected.blocks, ...selected.comments];
    const before = render(fork);
    const pendingBefore = new Set(touched);
    const oldBlocks = blockValues(fork);
    const oldTextTokens = new Map([...fork.texts].map(([id, d]) => [id, new Set(tokensOf(textOfDoc(d)))]));
    const ids = snapshotIds(fork);
    const r = command(
      fork,
      (cmd) => {
        const r = discardBlocks(cmd, chosen, { by: { press: all ? "discard all" : "discard" } });
        markCopies(r.fork);
        return r;
      },
      (r) => ({ chosen: r.chosen, pressed: stored(r.pressed), textKeys: r.fork.filter((c) => c.key !== STRUCTURE_KEY).map((c) => c.key) }),
    );
    rememberAll(fork, ids);
    recordOrigins(fork);
    toTab();
    const done = r.chosen.flatMap((c) => [...c.blocks, ...c.comments]);
    note(`  ${all ? "DISCARD ALL" : `DISCARD ${chosen.map((x) => x.slice(0, 4))}`} -> ${done.map((x) => x.slice(0, 4))}`);
    if (all) stats.discardAlls++;
    else stats.discards++;
    if (all) check(render(fork) === render(live), "discard-all", "fork differs from Live");
    else {
      const now = pendingIds();
      for (const id of chosen) check(!now.includes(id), "discard", () => `block ${id} still pending: live ${blockValues(live).get(id)} fork ${blockValues(fork).get(id)}`);
    }
    for (const key of r.textKeys) {
      const was = oldTextTokens.get(key) ?? new Set();
      const onLive = new Set(tokensOf(textOfDoc(live.textOf(key))));
      for (const token of tokensOf(textOfDoc(fork.texts.get(key)))) if (!was.has(token) && onLive.has(token)) resetRestored.set(token, key);
    }
    structureAfter(done);
    const newBlocks = blockValues(fork);
    for (const [id, b] of oldBlocks) if (!done.includes(id) && newBlocks.has(id)) check(b === newBlocks.get(id), "discard", `unchosen block ${id} changed`);
    for (const id of done) touched.delete(id);
    return { r, before, blocksBefore: oldBlocks, pendingBefore };
  }
  function undoDiscard(rec, kind, checkBefore = true) {
    syncTab();
    const ids = snapshotIds(fork);
    const { stayed } = command(fork, (cmd) => {
      const u = undoPress(cmd, rec.r.pressed, { by: { press: `${kind} undo` } });
      markCopies(u.fork);
      return u;
    });
    stats.stayedChanges += stayed.length;
    rememberAll(fork, ids);
    recordOrigins(fork);
    toTab();
    note(`  UNDO ${kind}`);
    for (const id of rec.pendingBefore) touched.add(id);
    if (kind === "discard") stats.discardUndos++;
    else stats.discardAllUndos++;
    if (checkBefore && !stayed.length)
      check(render(fork) === rec.before, `${kind}-undo`, () => {
        const now = blockValues(fork);
        return `fork not back to before Discard: ${[...new Set([...rec.blocksBefore.keys(), ...now.keys()])].filter((id) => rec.blocksBefore.get(id) !== now.get(id)).map((id) => `${id} ${rec.blocksBefore.get(id)} -> ${now.get(id)}`).join("; ")}`;
      });
  }

  /** The draft's top-level paragraphs of plain text with nothing pending: `[id, node, pos]`. */
  function cleanParagraphs() {
    ensure();
    syncLive();
    syncTab();
    const pendingNow = new Set(pendingIds());
    const out = [];
    read(tab).forEach((node, pos) => {
      const plain = node.type === schema.nodes.paragraph && node.childCount === 1 && node.firstChild.isText && node.firstChild.marks.length === 0;
      out.push(plain && !pendingNow.has(node.attrs.id) && new StructureView(live).shown.has(node.attrs.id) ? [node.attrs.id, node, pos] : null);
    });
    return out;
  }
  const changeOf = (id) => pending().findIndex((c) => c.blocks.includes(id));

  /**
   * A split or a join is one change (design §2): the writer's Enter inside a paragraph, or a join
   * of two, then a press that names one of the two blocks. Both settle, Live shows no word twice,
   * and the press's Undo leaves them one change again.
   */
  function halves() {
    const paragraphs = cleanParagraphs();
    const wordy = (p) => p && / \S/.test(p[1].textContent.slice(1));
    const kind = g.pick(["split", "split", "join", "join", "crossDelete", "typeOver", "multi", "paste", "joinEnter"]);
    const alone = kind === "split" || kind === "paste";
    const at = paragraphs.findIndex((p, i) => wordy(p) && (alone || wordy(paragraphs[i + 1])));
    if (at < 0) return;
    const [first, node, pos] = paragraphs[at];
    const [second, next, nextPos] = alone ? [] : paragraphs[at + 1];
    const idsBefore = new Set(textblocks(tab).keys());
    // Words the draft already shows twice (a `Restore before` over a split leaves such a copy).
    const drafted = tokens(tab);
    const already = new Set(drafted.filter((t) => drafted.indexOf(t) !== drafted.lastIndexOf(t)));
    const moved = [...tokensOf(node.textContent), ...(next ? tokensOf(next.textContent) : [])];
    // A place inside each paragraph, before a space, so no word is cut.
    const inFirst = pos + 1 + node.textContent.indexOf(" ", 1);
    const inSecond = next && nextPos + 1 + next.textContent.indexOf(" ", 1);
    const paragraph = () => schema.nodes.paragraph.create(null, schema.text(g.tok("f")));
    const builds = {
      split: (tr) => tr.split(inFirst),
      join: (tr) => tr.join(nextPos),
      // A selection from inside one paragraph to inside the next, deleted or typed over.
      crossDelete: (tr) => tr.delete(inFirst, inSecond),
      typeOver: (tr) => tr.insertText(` ${g.tok("f")}`, inFirst, inSecond),
      // Two steps: typing at the start, then the delete across the break.
      multi: (tr) => {
        tr.insertText(`${g.tok("f")} `, pos + 1);
        return tr.delete(tr.mapping.map(inFirst), tr.mapping.map(inSecond));
      },
      // Two paragraphs pasted inside one: its tail ends up in the second pasted paragraph.
      paste: (tr) => tr.replace(inFirst, inFirst, new Slice(Fragment.from([paragraph(), paragraph()]), 1, 1)),
      joinEnter: (tr) => tr.join(nextPos),
    };
    if (!userEdit(tab, "f", { edit: { kind, build: builds[kind] } })) return;
    // A join mended by hand: Enter where the two were joined. The first paragraph reads as Live
    // again, and the second, removed, and the new one are one change through it.
    if (kind === "joinEnter" && !userEdit(tab, "f", { edit: { kind: "split", build: (tr) => tr.split(pos + 1 + node.content.size) } })) return;
    syncTab();
    const fresh = [...textblocks(tab).keys()].find((x) => !idsBefore.has(x));
    const [id, other] = kind === "joinEnter" ? [second, fresh] : [first, alone ? fresh : second];
    stats.halves = (stats.halves ?? 0) + 1;
    stats[`halves:${kind}`] = (stats[`halves:${kind}`] ?? 0) + 1;
    check(changeOf(id) >= 0 && changeOf(id) === changeOf(other), "pieces", () => `${kind} of ${id} and ${other} is not one change: ${JSON.stringify(pending())}`);
    const named = g.chance(0.5) ? id : other;
    // By what the press acted on: the press step types into a pressed block afterwards.
    const settled = (what, acted) =>
      check(acted.includes(id) && acted.includes(other), "pieces", () => `${what} naming ${named} acted on ${acted}, not on both halves`);
    if (g.chance(0.6)) {
      const p = press([named], true);
      if (!p) return;
      settled("Apply", p.ids);
      const shown = tokens(live);
      const twice = moved.filter((t) => !already.has(t) && shown.indexOf(t) !== shown.lastIndexOf(t));
      check(!twice.length, "pieces", () => `Live shows ${twice.join(" ")} twice after Apply naming ${named}`);
      if (g.chance(0.5)) {
        syncLive();
        undoPressStep(p, { exact: liveWrites === p.liveAt && !p.liveTyped, inTurn: true });
        const [a, b] = [changeOf(id), changeOf(other)];
        if (a >= 0 || b >= 0) check(a === b, "pieces", () => `after the Undo ${id} and ${other} are not one change: ${JSON.stringify(pending())}`);
      }
    } else {
      const r = discard(false, named);
      if (!r) return;
      settled("Discard", r.r.chosen.flatMap((c) => c.blocks));
      if (g.chance(0.5)) undoDiscard(r, "discard");
    }
  }

  /**
   * Independent rewrites of two neighbours stay two changes (design §2), though one loses three
   * characters the other gains: applying the first leaves the second pending.
   */
  function neighbours() {
    const paragraphs = cleanParagraphs();
    const at = paragraphs.findIndex((p, i) => p && paragraphs[i + 1] && /^\S{4,}/.test(p[1].textContent));
    if (at < 0) return;
    const [[a, node, pos], [b]] = [paragraphs[at], paragraphs[at + 1]];
    const word = node.textContent.match(/^\S+/)[0];
    const fresh = g.tok("f");
    if (!userEdit(tab, "f", { edit: { kind: "rewrite", build: (tr) => tr.insertText(fresh, pos + 1, pos + 1 + word.length) } })) return;
    // The first rewrite moved the second paragraph: find its end in the document as it is now.
    const endOf = (doc) => {
      let end = -1;
      doc.forEach((child, offset) => {
        if (child.attrs.id === b) end = offset + 1 + child.content.size;
      });
      return end;
    };
    if (!userEdit(tab, "f", { edit: { kind: "rewrite", build: (tr, doc) => tr.insertText(` ${word.slice(0, 3)}~`, endOf(doc)) } })) return;
    syncTab();
    stats.neighbours = (stats.neighbours ?? 0) + 1;
    check(changeOf(a) >= 0 && changeOf(b) >= 0 && changeOf(a) !== changeOf(b), "pieces", () => `rewrites of ${a} and ${b} are not two changes: ${JSON.stringify(pending())}`);
    if (!press([a], true)) return;
    check(pendingIds().includes(b), "pieces", () => `Apply of ${a} did not leave ${b} pending`);
  }

  try {
    writeProseMirror(live, withIds(g.initialDoc(), g.rng), { random: g.rng });
    if (g.chance(0.6)) {
      const e = randomEdit(g, read(live), "s", { structure: false });
      if (e?.kind === "comment" || e?.kind === "comment2") {
        for (const [id, b] of e.comments) setCommentBody(live, id, b);
        edit(live, e.build, { rng: g.rng });
      }
    }
    recordOrigins(live);
    liveTab = track(live.fork("2"));
    const count = 1 + g.int(8);
    let made = 0;
    let turn = null;
    while (made < count) {
      if (g.chance(0.25)) liveEdit();
      if (g.chance(0.6)) {
        writerEdit();
        made++;
      } else {
        const n = Math.min(count - made, 1 + g.int(2));
        const t = aiTurn(n);
        made += n;
        if (!turn && g.chance(0.35)) turn = t;
      }
    }
    if (g.chance(0.4)) liveEdit();
    if (turn && g.chance(0.6)) restore(turn);

    for (let a = 0, n = 2 + g.int(3); a < n; a++) {
      const k = g.r();
      if (k < 0.3) {
        const p = press();
        if (p && g.chance(0.55)) {
          for (let i = 0, m = g.int(3); i < m; i++) userEdit(tab, "f");
          const since = g.chance(0.3);
          if (since) liveEdit(false);
          syncLive();
          undoPressStep(p, { exact: liveWrites === p.liveAt && !p.liveTyped, inTurn: true });
        }
      } else if (k < 0.42) chain();
      else if (k < 0.5) replaceThenOverwrite();
      else if (k < 0.65) {
        const r = discard();
        if (r && g.chance(0.5)) undoDiscard(r, "discard");
      } else if (k < 0.82) {
        syncTab();
        syncLive();
        if (!pendingIds().length) continue;
        const discarded = new Set(tokens(fork).filter((t) => (t[0] === "f" || t[0] === "a") && !tokens(live).includes(t)));
        const stale = g.chance(0.5) ? track(tab.fork(next())) : null;
        const r = discard(true);
        const typed = [];
        if (stale)
          for (let i = 0, m = 1 + g.int(3); i < m; i++) {
            const b = new Set(tokens(stale));
            userEdit(stale, "f", { structure: false });
            typed.push(...tokens(stale).filter((t) => !b.has(t)));
          }
        const order = g.int(3);
        let undone = false;
        if (order === 0) {
          undoDiscard(r, "discard all");
          undone = true;
        } else if (order === 1) aiTurn(1);
        if (stale) {
          send(stale, fork);
          fwdLive();
          toTab();
          const now = new Set(tokens(fork));
          const back = [...discarded].filter((t) => now.has(t) && !undone);
          outcomes.push({ route: "stale", back: back.length, typed: typed.length, kept: typed.filter((t) => now.has(t)).length });
          stats.stale++;
          check(!back.length, "stale-discarded-back", `discarded ${back.join(" ")}`);
        }
        if (order === 1 && g.chance(0.5)) undoDiscard(r, "discard all", false);
      } else if (k < 0.87) twoDrafts();
      else {
        liveEdit();
        if (g.chance(0.5)) writerEdit();
      }
    }
    // After the seeded steps, so a seed's script up to here is what it was before these cases.
    halves();
    neighbours();
    syncLive();
    syncTab();

    const fTokens = tokenBlocks(fork);
    const lTokens = tokenBlocks(live);
    const copied = new Set();
    for (const [token, id] of resetRestored) {
      const ft = fork.textOf(id);
      const lt = live.textOf(id);
      if (!tokensOf(textOfDoc(ft)).includes(token)) continue;
      const fp = textOfDoc(ft).indexOf(token);
      const lp = textOfDoc(lt).indexOf(token);
      if (!tokensOf(textOfDoc(lt)).includes(token) || !same(charIds(ft).slice(fp, fp + token.length), charIds(lt).slice(lp, lp + token.length))) copied.add(id);
    }
    for (const id of markCopied) if (fork.textOf(id) && live.textOf(id) && textOfDoc(fork.textOf(id)) === textOfDoc(live.textOf(id))) copied.add(id);
    for (const [id, chars] of inverseCopies) if (charIds(fork.textOf(id)).some((c) => chars.has(c))) copied.add(id);
    const finalPending = pendingIds();
    if ([...copied].some((id) => finalPending.includes(id))) stats.resetCopyObserved++;
    const fv = new StructureView(fork);
    const lv = new StructureView(live);
    for (const id of finalPending)
      for (const view of [lv, fv]) {
        const seen = new Set();
        for (let par = view.value("parent", id); typeof par === "string" && !seen.has(par); par = view.value("parent", par)) {
          if (touched.has(par)) {
            touched.add(id);
            break;
          }
          seen.add(par);
        }
      }
    for (const id of finalPending)
      check(touched.has(id) || copied.has(id) || fv.override("comments", id) !== undefined, "spurious-pending", () => `untouched block ${id} pending: live ${blockValues(live).get(id)} fork ${blockValues(fork).get(id)}`);
    for (const [tok, id] of liveTokenBlock) {
      if (deleted.has(tok) || !lTokens.has(tok) || !fv.shown.has(id)) continue;
      const ids = liveTokenIds.get(tok) ?? [];
      const present = new Set(charIds(fork.textOf(id)));
      const missing = ids.filter((c) => c && !present.has(c));
      if (missing.some((c) => draftDeletedChars.has(c))) {
        stats.liveTokenDeleted++;
        continue;
      }
      // A Live split or join since carried the token on: the fork shows it where Live does.
      if (fTokens.get(tok) !== id && fTokens.get(tok) !== lTokens.get(tok)) {
        const text = textOfDoc(fork.textOf(id));
        let at = 0;
        for (const c of text) if (c === tok[at]) at++;
        if (at === tok.length) stats.tokenSplit++;
        else check(false, "live-typing-lost", () => `Live token ${tok} characters missing from fork; id ${id}; live ${blockValues(live).get(id)}; fork ${blockValues(fork).get(id)}`);
      }
    }
    command(fork, (cmd) => applyBlocks(cmd, "all", { by: { press: "apply all" }, liveVersion: live.version() }));
    syncTab();
    syncLive();
    toTab();
    check(render(live) === render(fork), "converge", "Live and fork differ after Apply all");
    check(!pendingIds().length, "pending", "pending after Apply all");
    check(render(tab) === render(fork), "tab", () => `Draft tab differs: tab ${[...blockValues(tab)].filter(([id, v]) => blockValues(fork).get(id) !== v).map(([id, v]) => `${id} ${v} / fork ${blockValues(fork).get(id)}`).join("; ")} | fork-only ${[...blockValues(fork).keys()].filter((id) => !blockValues(tab).has(id))}`);
    check(render(liveTab) === render(live), "live-tab", "Live tab differs");
    const bodies = new StructureView(live);
    const forkBodies = new StructureView(fork);
    for (const k of comments(live)) {
      check(bodies.value("comments", k) != null, "bodies", `missing body ${k}`);
      check(same(bodies.value("comments", k), forkBodies.value("comments", k)), "bodies", `body ${k} differs`);
    }
    const final = tokens(live);
    const collisions = new Set();
    for (const id of lv.shown) {
      const td = live.textOf(id);
      if (!td) continue;
      const text = textOfDoc(td);
      const cs = charIds(td);
      for (const m of text.matchAll(new RegExp(TOKEN.source, "g")))
        if (cs.slice(m.index, m.index + m[0].length).some((c) => origins.has(`${id}|${c}`) && origins.get(`${id}|${c}`) !== m[0])) collisions.add(m[0]);
    }
    const dup = final.filter((t, i) => final.indexOf(t) !== i && !collisions.has(t));
    check(!dup.length, "duplicate-text", () => `duplicate tokens ${dup.join(",")}; Live ${render(live)}`);
    const allIds = [];
    read(live).descendants((n) => {
      if (n.type.spec.attrs?.id !== undefined) allIds.push(n.attrs.id);
    });
    check(!allIds.includes(null) && new Set(allIds).size === allIds.length, "block-ids", "missing or duplicate block ids");
    read(live).check();
    return { ok: true, stats, outcomes };
  } catch (e) {
    return { ok: false, cls: e.cls ?? "throw", msg: e.stack ?? String(e), stats, outcomes };
  } finally {
    for (const d of all.reverse()) d.free();
  }
}

/** A fixed key between two (structure-after's Live move): the middle, no randomness. */
function keyBetweenFixed(lo, hi) {
  const A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let prefix = "";
  let upper = hi;
  for (let i = 0; ; i++) {
    const a = lo && i < lo.length ? A.indexOf(lo[i]) : 0;
    const b = upper && i < upper.length ? A.indexOf(upper[i]) : 61;
    if (b - a > 1) return `${prefix}${A[Math.floor((a + b) / 2)]}PPV`;
    prefix += A[a];
    if (a < b) upper = null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? def : process.argv[i + 1];
  };
  const seed = arg("seed", null);
  if (seed !== null) {
    const r = runScript(Number(seed), { verbose: true });
    say(r.ok ? "OK" : `FAIL ${r.cls}\n${r.msg}`);
    process.exit(r.ok ? 0 : 1);
  }
  const start = Number(arg("start", 0));
  const n = Number(arg("n", 100));
  const fails = {};
  const failureSeeds = {};
  const totals = {};
  const routes = {};
  let ok = 0;
  let peak = 0;
  const begin = Date.now();
  for (let s = start; s < start + n; s++) {
    const r = runScript(s);
    await new Promise((resolve) => setImmediate(resolve));
    peak = Math.max(peak, process.memoryUsage().rss);
    for (const [k, v] of Object.entries(r.stats)) if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
    for (const o of r.outcomes) {
      const x = (routes[o.route] ??= { n: 0, back: 0, typed: 0, kept: 0 });
      x.n++;
      x.back += o.back;
      x.typed += o.typed;
      x.kept += o.kept;
    }
    if (r.ok) ok++;
    else {
      fails[r.cls] = (fails[r.cls] ?? 0) + 1;
      (failureSeeds[r.cls] ??= []).push(s);
      if (fails[r.cls] === 1) say(`seed ${s} FAIL ${r.msg.split("\n").slice(0, 3).join(" | ")}`);
    }
  }
  say(`SUMMARY ${JSON.stringify({ start, n, ok, fails, failureSeeds, totals, routes, ms: Date.now() - begin, peakRssMB: Math.round(peak / 2 ** 20) })}`);
  process.exit(ok === n ? 0 : 1);
}

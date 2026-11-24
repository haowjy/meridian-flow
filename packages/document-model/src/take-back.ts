import type { Delta, Frontiers, LoroDoc } from "loro-crdt";
import { type CommitAuthor, commitMessage, readCommitMessage } from "./commit-message.js";
import { inMap, inText } from "./handles.js";
import type { PeerId } from "./peer.js";
import { answerRemovals } from "./removals.js";
import type { RoomDocs } from "./room-docs.js";
import { type BlockId, type DocKey, mapKind, membersOf, overrideMap, sameValue } from "./shape.js";
import { isOrderKey, removalOf, StructureView } from "./structure.js";
import {
  type DocVersion,
  docCovers,
  docVersion,
  mergeVersion,
  plainVersion,
  withVector,
} from "./version.js";
import { commitStructure, type DocChange, StructureWriter } from "./write.js";

/**
 * The rule every Undo follows (design §2, "An Undo always runs"): the editor's Ctrl+Z and Redo, a
 * press's Undo, a turn's restore press and agent-edit's undo. An Undo takes its edit back whatever was
 * written since. Text goes back by its inverse, which deletes the characters the edit put in that
 * still stand and puts back the ones it deleted (Loro's `UndoManager` in the editor,
 * `textInverse` here). Structure goes back key by key, each to the value it held before the edit,
 * last writer wins. A block the Undo takes away is removed with a record that counts as read only
 * what the edit's copy showed of the text under the blocks it touched (`Edit.read`), and rule 1
 * (`answerRemovals`) runs over the Undo's own write, so a block anyone typed into since comes
 * back: no one's words leave the screen. Rarely the text then shows twice, which the writer
 * deletes.
 */

/** A structure value an edit set: what the key held before the edit, and what the edit left. */
export interface SetValue {
  before: unknown;
  left: unknown;
}

/** An edit's structure values, by stored map name (`order`, a draft's `d.order`) then key. */
export type EditValues = Map<string, Map<string, SetValue>>;

/** What an edit, or its last run, wrote in one text doc: the frontiers either side. */
export interface TextSpan {
  before: Frontiers;
  after: Frontiers;
}

/** An edit an Undo takes back: a Ctrl+Z step, one change of a press, or an AI write. */
export interface Edit {
  values: EditValues;
  texts: Map<DocKey, TextSpan>;
  /**
   * What the edit's copy showed, just after it, of every text doc under a block it touched and of
   * every doc it wrote (`readOf`). A removal its Undo writes counts these as read; a doc outside
   * them counts as unread.
   */
  read: Map<DocKey, DocVersion>;
}

/**
 * Add to `into` what `docs` show now of the text docs `edit` wrote and of those under every block
 * its structure values name, keeping a doc's first reading: call it just after the edit.
 */
export function readOf(
  docs: RoomDocs,
  edit: Pick<Edit, "values" | "texts">,
  into: Map<DocKey, DocVersion> = new Map(),
): Map<DocKey, DocVersion> {
  const keys = new Set<DocKey>(edit.texts.keys());
  if (edit.values.size > 0) {
    const view = new StructureView(docs);
    for (const [name, values] of edit.values)
      for (const key of values.keys())
        for (const id of membersOf(name, key))
          for (const under of view.textKeysUnder(id)) keys.add(under);
  }
  for (const key of keys) {
    if (into.has(key)) continue;
    const doc = docs.textOf(key);
    if (doc) into.set(key, plainVersion(doc.version()));
  }
  return into;
}

/**
 * Add to `into` the structure keys the commits from `before` to `after` set: for a key not in it
 * yet the value before them, and for every key the value they left.
 */
export function valuesOf(
  doc: LoroDoc,
  before: Frontiers,
  after: Frontiers,
  into: EditValues = new Map(),
): EditValues {
  const old = new Map(doc.diff(after, before, true));
  for (const [container, diff] of doc.diff(before, after, true)) {
    if (diff.type !== "map") continue;
    const name = mapName(container);
    const was = old.get(container);
    const keys = keysOf(into, name);
    for (const [key, left] of Object.entries(diff.updated)) {
      const value = keys.get(key) ?? {
        before: was?.type === "map" ? was.updated[key] : undefined,
        left,
      };
      value.left = left;
      keys.set(key, value);
    }
  }
  return into;
}

/** What an Undo's put-back of structure knows of the text. */
export interface PutBackText {
  /** What the edit's copy showed (`Edit.read`). */
  read: ReadonlyMap<DocKey, DocVersion>;
  /** The text docs the Undo put text into, just before. */
  inserted: ReadonlySet<DocKey>;
}

/**
 * Write every structure value of an edit back, in one commit by `by`: each key gets the value it
 * held before the edit. A block the edit made goes as a removal through `StructureWriter.remove`,
 * and keeps its other keys to come back with; a removal record the edit replaced is written anew
 * the same way. Each removal counts as read what the edit's copy showed (`text.read`), what its
 * record had read, what a removal under it read, and the Undo's own ops; any other op is unread.
 * Then rule 1 runs over the commit, the text the Undo put in, the shown blocks it moved and the
 * blocks it brought back (`answerRemovals`): a removed block someone else typed into since comes
 * back, and so does a container a peer removed around a block the Undo puts back. Returns the
 * changes, the restores included, and the values of the way back. `view`, if given, reads the
 * structure as it is.
 */
export function putBackValues(
  docs: RoomDocs,
  values: EditValues,
  text: PutBackText,
  options: { view?: StructureView; by?: CommitAuthor } = {},
): { changes: DocChange[]; values: EditValues } {
  const back: EditValues = new Map();
  const { structure } = docs;
  const before = structure.frontiers();
  if (values.size === 0)
    return { changes: answerRemovals(docs, before, { typed: text.inserted }), values: back };
  const read = options.view ?? new StructureView(docs);
  const puts = planOf(docs, read, values);
  // A removal record put back goes in as it was first, so the removals written below read the
  // blocks under it.
  for (const { name, key, value, at } of puts) {
    if (at === undefined || value !== undefined)
      inMap(structure, name, (map) => {
        if (value === undefined) map.delete(key);
        else map.set(key, value as never);
      });
    keysOf(back, name).set(key, { before: values.get(name)?.get(key)?.left, left: undefined });
  }
  // A removal counts the text under it as the run leaves it, a block the run puts back under it
  // included.
  const removals = puts.filter(({ at }) => at !== undefined);
  if (removals.length > 0) {
    const wrote = puts.some(({ value, at }) => at === undefined || value !== undefined);
    const writer = new StructureWriter(docs, wrote ? new StructureView(docs) : read);
    for (const { key, at, seen } of removals)
      writer.remove(key, at ?? undefined, sawOf(docs, writer.view, key, text.read, seen));
  }
  const change = commitStructure(docs, before, { by: options.by });
  for (const [name, keys] of back)
    inMap(structure, name, (map) => {
      for (const [key, value] of keys) value.left = map.get(key);
    });
  const moved = puts
    .filter(({ name, key, value }) => {
      const { map } = mapKind(name);
      if (map === "parent") return typeof value === "string" && read.shown.has(key);
      return map === "order" && isOrderKey(value) && removalOf(read.value("order", key)) !== null;
    })
    .map(({ key }) => key);
  return {
    changes: [
      ...(change ? [change] : []),
      ...answerRemovals(docs, before, { typed: text.inserted, moved }),
    ],
    values: back,
  };
}

/**
 * What the removal of `id` an Undo writes counts as read of each text doc under it. Of a block the
 * edit made (no `record`), a doc where no character shows that the edit's copy did not (`read`)
 * and the undoing side did not put in counts as read whole: no one's words leave with it, ops
 * whose text an Undo since took out included. A record put back keeps what it did not read.
 * Otherwise it counts what the edit's copy showed, what the record put back had read
 * (`record`), what a removal on the doc's path below `id` read (a block that stays removed shows
 * none of its text) and the Undo's own ops, so rule 1 brings `id` back with those words.
 */
function sawOf(
  docs: RoomDocs,
  view: StructureView,
  id: BlockId,
  read: ReadonlyMap<DocKey, DocVersion>,
  record?: ReadonlyMap<DocKey, DocVersion>,
): (key: DocKey) => DocVersion | undefined {
  const own = [docs.peer, docs.live?.peer].filter((peer) => peer !== undefined) as string[];
  return (key) => {
    const doc = docs.textOf(key);
    if (!doc) return undefined;
    if (!record && !showsUnread(docs, doc, read.get(key), own)) return plainVersion(doc.version());
    const seen = new Map<string, number>();
    const add = (version: DocVersion | undefined) => {
      for (const [peer, counter] of version ?? [])
        if (counter > (seen.get(peer) ?? 0)) seen.set(peer, counter);
    };
    add(read.get(key));
    add(record?.get(key));
    for (let at: BlockId | null | undefined = key; at && at !== id; at = view.parent(at))
      add(view.removal(at)?.seen.get(key));
    // The Undo's own ops: this copy's, and in a draft its Live copy's (a press Undo's Live side).
    for (const peer of own) {
      const counter = docVersion(doc).get(peer as PeerId);
      if (counter) seen.set(peer, counter);
    }
    return seen as DocVersion;
  };
}

/**
 * Whether `doc` shows a character put in since `read` by a peer not in `own`, past text the
 * undoing side put back where it stood (`unchanged`). A doc cut at its history cutoff since `read`
 * can't say, and counts as showing one.
 */
function showsUnread(
  docs: RoomDocs,
  doc: LoroDoc,
  read: DocVersion | undefined,
  own: readonly string[],
): boolean {
  if (doc.isShallow() && !docCovers(read, plainVersion(doc.shallowSinceVV()))) return true;
  const from = read ? withVector(read, (vector) => doc.vvToFrontiers(vector)) : [];
  const since = unchanged(
    textDiff(doc, from, doc.frontiers()),
    textDiff(doc, [], from),
    putBackBy(docs, doc, new Set()),
  );
  return inText(doc, (text) => {
    let at = 0;
    for (const op of since) {
      if (op.delete != null) continue;
      if (op.insert != null)
        for (let k = at; k < at + length(op); k++) {
          const peer = text.getEditorOf(k);
          if (peer !== undefined && !own.includes(peer)) return true;
        }
      at += length(op);
    }
    return false;
  });
}

/**
 * A write of a put-back: `at` set makes it a removal of block `key` (null: at its key now), which
 * counts `seen`, what the removal put back had read, besides the Undo's own reading.
 */
interface Put {
  name: string;
  key: string;
  value: unknown;
  at?: string | null;
  seen?: ReadonlyMap<DocKey, DocVersion>;
}

/**
 * What putting `values` back writes, key by key: the value each held before the edit, except a
 * removal, which is written anew (`Put.at`).
 */
function planOf(docs: RoomDocs, view: StructureView, values: EditValues): Put[] {
  const order = docs.draft ? overrideMap("order") : "order";
  // A block the edit made had no `order` before it; in a draft, none in Live either.
  const made = new Set<BlockId>();
  for (const [id, { before, left }] of values.get(order) ?? [])
    if (
      before === undefined &&
      left !== undefined &&
      (!docs.draft || view.baseValue("order", id) === undefined)
    )
      made.add(id);
  const puts: Put[] = [];
  for (const [name, keys] of values)
    for (const [key, { before, left }] of keys) {
      if (sameValue(before, left)) continue;
      if (name === order && made.has(key)) {
        if (isOrderKey(view.value("order", key)))
          puts.push({ name, key, value: undefined, at: null });
        continue;
      }
      if (name !== order && membersOf(name, key).every((id) => made.has(id))) continue;
      const removal = name === order ? removalOf(before) : null;
      puts.push(
        removal
          ? { name, key, value: before, at: removal.at, seen: removal.seen }
          : { name, key, value: before },
      );
    }
  return puts;
}

/**
 * Take `edits` back on `docs` (a press's Undo, an AI write's): each text doc by its inverse
 * (`textInverse`), in a commit by `by`; then every structure value in one commit by `by`
 * (`putBackValues`), after the text, so a removal record it writes counts the text put back.
 * `view` reads the structure as it is. Returns the changes.
 */
export function takeBack(
  docs: RoomDocs,
  edits: readonly Edit[],
  view: StructureView,
  by?: CommitAuthor,
): DocChange[] {
  const out: DocChange[] = [];
  const values: EditValues = new Map();
  const read = new Map<DocKey, DocVersion>();
  const inserted = new Set<DocKey>();
  for (const edit of edits) {
    for (const [key, span] of edit.texts) {
      // A draft's span of a doc it reads through Live: the text stays Live's.
      const doc = docs.doc(key);
      if (!doc) continue;
      const inverse = textInverse(docs, doc, span);
      if (inverse.length === 0) continue;
      if (inverse.some((op) => op.insert != null)) inserted.add(key);
      const before = doc.frontiers();
      inText(doc, (text) => text.applyDelta(inverse));
      doc.commit({ message: commitMessage(by, docs.draft) });
      out.push({ key, doc, before, after: doc.frontiers() });
    }
    for (const [name, keys] of edit.values) {
      const into = values.get(name) ?? new Map<string, SetValue>();
      for (const [key, value] of keys) into.set(key, value);
      values.set(name, into);
    }
    mergeVersion(read, edit.read);
  }
  out.push(...putBackValues(docs, values, { read, inserted }, { view, by }).changes);
  return out;
}

export type TextOp = Delta<string>;

const length = (op: TextOp) => op.retain ?? op.delete ?? (op.insert as string).length;

/**
 * The text Undo of a write (`span`) in `doc`, for the text as it is now: the inverse
 * `diff(after, before)` moved through what happened since, so it deletes only the write's
 * characters that still stand, puts back what it deleted, and keeps whatever anyone wrote since.
 */
function textInverse(docs: RoomDocs, doc: LoroDoc, { before, after }: TextSpan): TextOp[] {
  const inverse = textDiff(doc, after, before);
  if (inverse.length === 0) return [];
  const since = unchanged(
    textDiff(doc, after, doc.frontiers()),
    textDiff(doc, [], after),
    putBackBy(docs, doc, spanPeers(doc, before, after)),
  );
  const out: TextOp[] = [];
  const a = inverse.map((op) => ({ ...op }));
  const b = since.map((op) => ({ ...op }));
  let i = 0;
  let j = 0;
  const shrink = (op: TextOp, n: number) => {
    if (op.retain != null) (op as { retain: number }).retain -= n;
    else (op as { delete: number }).delete -= n;
  };
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x?.insert != null) {
      out.push(x);
      i++;
      continue;
    }
    if (y?.insert != null) {
      const n = (y.insert as string).length;
      const last = out.at(-1);
      if (last?.retain != null && !last.attributes) (last as { retain: number }).retain += n;
      else out.push({ retain: n });
      j++;
      continue;
    }
    if (!x) break;
    if (!y) {
      out.push(x);
      i++;
      continue;
    }
    const n = Math.min(length(x), length(y));
    if (y.delete == null) {
      if (x.delete != null) out.push({ delete: n });
      else out.push({ retain: n, ...(x.attributes ? { attributes: x.attributes } : {}) } as TextOp);
    }
    shrink(x, n);
    shrink(y, n);
    if (length(x) === 0) i++;
    if (length(y) === 0) j++;
  }
  while (out.length > 0 && out.at(-1)?.retain != null && !out.at(-1)?.attributes) out.pop();
  return out;
}

/** The peers of the ops from `before` to `after` in `doc`. */
function spanPeers(doc: LoroDoc, before: Frontiers, after: Frontiers): Set<string> {
  const was = plainVersion(doc.frontiersToVV(before));
  const peers = new Set<string>();
  for (const [peer, counter] of plainVersion(doc.frontiersToVV(after)))
    if (counter > (was.get(peer) ?? 0)) peers.add(peer);
  return peers;
}

/**
 * Whether the characters now at `[from, to)` of `doc`'s text were put in by the undoing side:
 * `peers` (a write's own), this copy, or a peer whose commits name an author (`by`: a chat's turn
 * or a press, such as an earlier Undo's copy). A writer's typing names none, so it never counts.
 */
function putBackBy(
  docs: RoomDocs,
  doc: LoroDoc,
  peers: Set<string>,
): (from: number, to: number) => boolean {
  const own = new Set<string>(peers);
  for (const peer of [docs.peer, docs.live?.peer]) if (peer !== undefined) own.add(peer);
  const now = docVersion(doc);
  const side = (peer: string) => {
    if (!own.has(peer)) {
      const last = now.get(peer as PeerId);
      if (
        !last ||
        !readCommitMessage(doc.getChangeAt({ peer: peer as PeerId, counter: last - 1 }).message).by
      )
        return false;
      own.add(peer);
    }
    return true;
  };
  return (from, to) =>
    inText(doc, (text) => {
      for (let at = from; at < to; at++) {
        // Loro reads no editor at the second half of a surrogate pair.
        const peer = text.getEditorOf(at);
        if (peer !== undefined && !side(peer)) return false;
      }
      return true;
    });
}

/**
 * `since` with every delete beside an insert of the same text, styles included, that the undoing
 * side put in (`putBack`) read as no change. An Undo puts deleted text back as new characters
 * (Loro has no undelete), so the Undo of a later edit leaves the text an earlier edit wrote
 * looking deleted and retyped; the earlier edit's Undo must still take it out. A writer who
 * retypes the same word keeps it. The one case left: an AI write of another turn that deletes the
 * edit's text and types the same text in its place, which the edit's Undo takes out with it.
 * `base` is the text at `since`'s start, as one insert delta.
 */
function unchanged(
  since: TextOp[],
  base: TextOp[],
  putBack: (from: number, to: number) => boolean,
): TextOp[] {
  const chars = base.flatMap((op) =>
    [...(op.insert as string)].map((char) => char + JSON.stringify(op.attributes ?? {})),
  );
  const spelled = (op: TextOp) =>
    [...(op.insert as string)].map((char) => char + JSON.stringify(op.attributes ?? {})).join("");
  const out: TextOp[] = [];
  let at = 0;
  let now = 0;
  for (let i = 0; i < since.length; i++) {
    const op = since[i] as TextOp;
    const next = since[i + 1];
    const [del, ins] =
      op.delete != null && next?.insert != null
        ? [op, next]
        : op.insert != null && next?.delete != null
          ? [next, op]
          : [];
    if (
      del &&
      ins &&
      chars.slice(at, at + (del.delete as number)).join("") === spelled(ins) &&
      putBack(now, now + length(ins))
    ) {
      out.push({ retain: del.delete as number });
      at += del.delete as number;
      now += length(ins);
      i++;
      continue;
    }
    out.push(op);
    if (op.insert == null) at += length(op);
    if (op.delete == null) now += length(op);
  }
  return out;
}

/** The delta of `doc`'s text from `from` to `to`. */
function textDiff(doc: LoroDoc, from: Frontiers, to: Frontiers): TextOp[] {
  const hit = doc.diff(from, to, false).find(([, diff]) => diff.type === "text");
  return hit ? ((hit[1] as { diff?: TextOp[] }).diff ?? []) : [];
}

function keysOf(values: EditValues, name: string): Map<string, SetValue> {
  let keys = values.get(name);
  if (!keys) {
    keys = new Map();
    values.set(name, keys);
  }
  return keys;
}

/** The structure doc holds root maps only: `cid:root-<name>:Map`. */
const mapName = (container: string) => container.slice("cid:root-".length, -":Map".length);

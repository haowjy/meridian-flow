import type { Frontiers, LoroDoc, PeerID } from "loro-crdt";
import { inText } from "./handles.js";
import type { RoomDocs } from "./room-docs.js";
import type { BlockId, DocKey } from "./shape.js";
import type { StructureView } from "./structure.js";
import {
  type Edit,
  type EditValues,
  putBackValues,
  type SetValue,
  type TakenBack,
  type TextOp,
  takeBackMessage,
  textDiff,
  textSince,
} from "./take-back.js";
import { type DocVersion, plainVersion, withVector } from "./version.js";
import type { DocChange } from "./write.js";

/** The version `doc` holds at `frontiers`. */
export function versionOf(doc: LoroDoc, frontiers: Frontiers): DocVersion {
  return plainVersion(doc.frontiersToVV(frontiers));
}

/** The frontiers of `version` in `doc`, which must hold every op of it. */
export function frontiersOf(doc: LoroDoc, version: DocVersion): Frontiers {
  return withVector(version, (vector) => doc.vvToFrontiers(vector));
}

type VersionJson = Record<string, number>;

/**
 * An `Edit` as a press stores it for its Undo (design §2, "For the press"): JSON, with versions
 * for frontiers. Its note can't be taken again later: `noteEdit` reads the oplog as it is.
 */
export interface StoredEdit {
  peer: PeerID;
  values: [string, [string, SetValue][]][];
  texts: [DocKey, { before: VersionJson; after: VersionJson; ops: TakenBack }][];
  leaving: [BlockId, VersionJson][];
  arriving: BlockId[];
  shown: DocKey[];
  structureAt: VersionJson;
}

/** `edit`, made and noted on `docs`, as stored. */
export function storeEdit(docs: RoomDocs, edit: Edit): StoredEdit {
  const json = (version: DocVersion): VersionJson => Object.fromEntries(version);
  const texts: StoredEdit["texts"] = [];
  for (const [key, { before, after, ops }] of edit.texts) {
    const doc = docs.doc(key);
    if (doc)
      texts.push([
        key,
        { before: json(versionOf(doc, before)), after: json(versionOf(doc, after)), ops },
      ]);
  }
  return {
    peer: edit.peer,
    values: [...edit.values].map(([name, keys]) => [name, [...keys]]),
    texts,
    leaving: [...edit.leaving].map(([id, version]) => [id, json(version)]),
    arriving: [...edit.arriving],
    shown: [...edit.shown],
    structureAt: json(versionOf(docs.structure, edit.structureAt)),
  };
}

/** A stored edit back on `docs`, which hold every op it names. */
export function loadEdit(docs: RoomDocs, stored: StoredEdit): Edit {
  const version = (json: VersionJson): DocVersion => new Map(Object.entries(json)) as DocVersion;
  const texts: Edit["texts"] = new Map();
  for (const [key, { before, after, ops }] of stored.texts) {
    const doc = docs.doc(key);
    if (doc)
      texts.set(key, {
        before: frontiersOf(doc, version(before)),
        after: frontiersOf(doc, version(after)),
        ops,
      });
  }
  return {
    peer: stored.peer,
    values: new Map(stored.values.map(([name, keys]) => [name, new Map(keys)])),
    texts,
    leaving: new Map(stored.leaving.map(([id, json]) => [id, version(json)])),
    arriving: new Set(stored.arriving),
    shown: new Set(stored.shown),
    structureAt: frontiersOf(docs.structure, version(stored.structureAt)),
  };
}

/**
 * Take back `edits` on `docs`, each of which passed `editStays` there (a press's Undo, design §2):
 * each text doc by its inverse moved through what happened since (`transformedInverse`), in a
 * commit that names the ops it takes back (`takeBackMessage`); then every structure value in one
 * commit under `message` (`putBackValues`), after the text, so a removal record it writes counts
 * the text put back. `view` reads the structure as it is. Returns the changes.
 */
export function takeBack(
  docs: RoomDocs,
  edits: readonly Edit[],
  view: StructureView,
  message?: string,
): DocChange[] {
  const out: DocChange[] = [];
  const values: EditValues = new Map();
  for (const edit of edits) {
    for (const [key, span] of edit.texts) {
      const doc = docs.doc(key);
      if (!doc) continue;
      const moved = transformedInverse(doc, span.before, span.after);
      if (moved.length === 0) continue;
      const before = doc.frontiers();
      inText(doc, (text) => text.applyDelta(moved));
      doc.commit({ message: takeBackMessage(span.ops) });
      out.push({ key, doc, before, after: doc.frontiers() });
    }
    for (const [name, keys] of edit.values) {
      const into = values.get(name) ?? new Map<string, SetValue>();
      for (const [key, value] of keys) into.set(key, value);
      values.set(name, into);
    }
  }
  const { change } = putBackValues(docs, values, view, message);
  if (change) out.push(change);
  return out;
}

const length = (op: TextOp) => op.retain ?? op.delete ?? (op.insert as string).length;

/**
 * The text Undo of a write made between `before` and `after`, for the text as it is now (design
 * §2): the inverse `diff(after, before)`, moved through what happened since (`textSince`, where
 * text an Undo put back reads as the characters it stands for), so a deletion skips what is
 * already gone and keeps what was typed inside it.
 *
 * One condition, the value map's in text form (settled (a)): where the write replaced text (a
 * deletion and an insertion at one place), the old text comes back only while some of what the
 * write put in there remains. When a later write removed all of it, the Undo leaves that write
 * alone. A write that only deleted always gives its text back.
 */
export function transformedInverse(doc: LoroDoc, before: Frontiers, after: Frontiers): TextOp[] {
  const inverse = textDiff(doc, after, before);
  if (inverse.length === 0) return [];
  const since = textSince(doc, after);
  return transform(dropReplaced(inverse, removedBy(since)), since);
}

/** Which units of the text at the write's `after` the ops since have deleted. */
function removedBy(since: readonly TextOp[]): boolean[] {
  const gone: boolean[] = [];
  let pos = 0;
  for (const op of since) {
    if (op.retain != null) pos += op.retain;
    else if (op.delete != null) {
      for (let i = 0; i < op.delete; i++) gone[pos + i] = true;
      pos += op.delete;
    }
  }
  return gone;
}

/**
 * The inverse without the old text of each replacement whose new text a later write removed
 * whole: at one place, the inverse deletes what the write inserted and inserts what it deleted.
 */
function dropReplaced(inverse: readonly TextOp[], gone: readonly boolean[]): TextOp[] {
  const out: TextOp[] = [];
  let pos = 0;
  for (let i = 0; i < inverse.length; ) {
    const op = inverse[i];
    if (op.retain != null) {
      out.push(op);
      pos += op.retain;
      i++;
      continue;
    }
    const place: TextOp[] = [];
    let deleted = 0;
    while (i < inverse.length && inverse[i].retain == null) {
      const one = inverse[i++];
      place.push(one);
      if (one.delete != null) deleted += one.delete;
    }
    let removed = deleted > 0 && place.some((one) => one.insert != null);
    for (let k = pos; removed && k < pos + deleted; k++) removed = gone[k] === true;
    for (const one of place) if (!(removed && one.insert != null)) out.push(one);
    pos += deleted;
  }
  return out;
}

/** `inverse` and `since` both start from one text; the result is `inverse` after `since`. */
function transform(inverse: readonly TextOp[], since: readonly TextOp[]): TextOp[] {
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
      out.push({ retain: (y.insert as string).length });
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

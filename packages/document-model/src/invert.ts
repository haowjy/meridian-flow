import type { Frontiers, LoroDoc } from "loro-crdt";
import type { CommitAuthor } from "./commit-message.js";
import type { RoomDocs } from "./room-docs.js";
import { type DocKey, STRUCTURE_KEY } from "./shape.js";
import { StructureView } from "./structure.js";
import { type Edit, readOf, type SetValue, takeBack, valuesOf } from "./take-back.js";
import {
  type DocVersion,
  docCovers,
  plainVersion,
  type RoomVersion,
  withVector,
} from "./version.js";
import type { DocChange } from "./write.js";

export function versionOf(doc: LoroDoc, frontiers: Frontiers): DocVersion {
  return plainVersion(doc.frontiersToVV(frontiers));
}

export function frontiersOf(doc: LoroDoc, version: DocVersion): Frontiers {
  return withVector(version, (vector) => doc.vvToFrontiers(vector));
}

type VersionJson = Record<string, number>;

export interface StoredEdit {
  values: [string, [string, SetValue][]][];
  texts: [DocKey, { before: VersionJson; after: VersionJson }][];
  /** `Edit.read`. A row an older build stored lacks it: its Undo counts every doc unread. */
  read?: [DocKey, VersionJson][];
}

export function storeEdit(docs: RoomDocs, edit: Edit): StoredEdit {
  const json = (version: DocVersion): VersionJson => Object.fromEntries(version);
  const texts: StoredEdit["texts"] = [];
  for (const [key, { before, after }] of edit.texts) {
    const doc = docs.textOf(key);
    if (doc)
      texts.push([
        key,
        { before: json(versionOf(doc, before)), after: json(versionOf(doc, after)) },
      ]);
  }
  return {
    values: [...edit.values].map(([name, keys]) => [name, [...keys]]),
    texts,
    read: [...edit.read].map(([key, version]) => [key, json(version)]),
  };
}

export function loadEdit(docs: RoomDocs, stored: StoredEdit): Edit {
  const version = (json: VersionJson): DocVersion => new Map(Object.entries(json)) as DocVersion;
  const texts: Edit["texts"] = new Map();
  for (const [key, { before, after }] of stored.texts) {
    const doc = docs.textOf(key);
    if (!doc) throw new Error(`no text doc ${key} for a stored edit`);
    texts.set(key, {
      before: frontiersOf(doc, version(before)),
      after: frontiersOf(doc, version(after)),
    });
  }
  return {
    values: new Map(stored.values.map(([name, keys]) => [name, new Map(keys)])),
    texts,
    read: new Map((stored.read ?? []).map(([key, json]) => [key, version(json)])),
  };
}

/**
 * The edit made in `keys` since `since`, stored as it left `docs` (an AI write, design §5): every
 * op from `since` to now in those docs is the write's, so a caller passes a copy that has taken
 * nothing else in since. A doc `since` lacks is one the write made.
 */
export function editSince(docs: RoomDocs, since: RoomVersion, keys: Iterable<DocKey>): StoredEdit {
  const edit: Edit = { values: new Map(), texts: new Map(), read: new Map() };
  for (const key of keys) {
    const doc = docs.doc(key);
    if (!doc) continue;
    const at = since.get(key);
    const before = at ? frontiersOf(doc, at) : [];
    const after = doc.frontiers();
    if (key === STRUCTURE_KEY) valuesOf(doc, before, after, edit.values);
    else edit.texts.set(key, { before, after });
  }
  readOf(docs, edit, edit.read);
  return storeEdit(docs, edit);
}

/**
 * Whether `docs` still hold the history `stored`'s text needs: a doc cut at its history cutoff
 * since (design §4) can't check the edit out, so its Undo can't run. The one case an Undo is
 * not taken.
 */
export function holdsEdit(docs: RoomDocs, stored: StoredEdit): boolean {
  return stored.texts.every(([key, { before }]) => {
    const doc = docs.textOf(key);
    return (
      !!doc &&
      (!doc.isShallow() ||
        docCovers(
          new Map(Object.entries(before)) as DocVersion,
          plainVersion(doc.shallowSinceVV()),
        ))
    );
  });
}

/**
 * An Undo of stored edits on `docs`, in the order given (newest first), by design §2's rule
 * (`takeBack`): each goes back, but one whose history `docs` no longer hold (`holdsEdit`). Returns
 * the changes, committed, and the indexes of the edits it could not take.
 */
export function undoEdits(
  docs: RoomDocs,
  edits: readonly StoredEdit[],
  by?: CommitAuthor,
): { changes: DocChange[]; compacted: Set<number> } {
  const changes: DocChange[] = [];
  const compacted = new Set<number>();
  let view = new StructureView(docs);
  edits.forEach((stored, index) => {
    if (!holdsEdit(docs, stored)) {
      compacted.add(index);
      return;
    }
    const wrote = takeBack(docs, [loadEdit(docs, stored)], view, by);
    changes.push(...wrote);
    if (wrote.some((change) => change.key === STRUCTURE_KEY)) view = new StructureView(docs);
  });
  return { changes, compacted };
}

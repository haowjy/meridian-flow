import type { Delta, Frontiers, LoroDoc } from "loro-crdt";
import { inMap, inText } from "./handles.js";
import { restampRemovals } from "./removals.js";
import type { RoomDocs } from "./room-docs.js";
import { type DocKey, overrideMap, STRUCTURE_KEY, STRUCTURE_MAPS, sameValue } from "./shape.js";
import { type DocVersion, plainVersion, withVector } from "./version.js";
import type { DocChange } from "./write.js";

/**
 * One doc a press (or its Undo) committed, with its versions either side: what `press_commits`
 * stores and what the Undo inverts (design §2). `side` is the room: the document's Live room, or
 * the draft's fork room.
 */
export interface PressCommit {
  side: "live" | "fork";
  key: DocKey;
  before: DocVersion;
  after: DocVersion;
}

/** `change` as a press stores it. */
export function pressCommit(side: PressCommit["side"], change: DocChange): PressCommit {
  return {
    side,
    key: change.key,
    before: versionOf(change.doc, change.before),
    after: versionOf(change.doc, change.after),
  };
}

/** The version `doc` holds at `frontiers`. */
export function versionOf(doc: LoroDoc, frontiers: Frontiers): DocVersion {
  return plainVersion(doc.frontiersToVV(frontiers));
}

/** The frontiers of `version` in `doc`, which must hold every op of it. */
export function frontiersOf(doc: LoroDoc, version: DocVersion): Frontiers {
  return withVector(version, (vector) => doc.vvToFrontiers(vector));
}

/**
 * Take back one commit of one doc of `docs`, made between `before` and `after` (design §2, "One
 * Undo rule for a press"), as a new commit at the doc's head. Returns the change, or null when it
 * writes nothing.
 *
 * - The structure doc, key by key: a key goes back to its value at `before` only while it still
 *   holds the value the commit left, so an Undo never overwrites a later write. A draft's copy
 *   writes only its `d.*` overrides and Live's only its base maps: no step applies a diff to a
 *   fork's base maps.
 * - A text doc, as positions moved through what happened since (`transformedInverse`), so the
 *   Undo of dependent presses undone in turn lands, and what was typed since stays.
 *
 * It needs no state between the commit and its Undo, so it runs on any copy over commits made by
 * any peers. The copy writes under its own peer: a server command's copy has a fresh one. Invert a
 * room's text docs before its structure doc, so a removal record put back counts the text.
 */
export function invertCommit(
  docs: RoomDocs,
  key: DocKey,
  before: DocVersion,
  after: DocVersion,
  message?: string,
): DocChange | null {
  const doc = docs.doc(key);
  if (!doc) return null;
  const head = doc.frontiers();
  const from = frontiersOf(doc, after);
  const to = frontiersOf(doc, before);
  if (key === STRUCTURE_KEY) invertValues(doc, from, to, docs.draft);
  else {
    const moved = transformedInverse(doc, to, from);
    if (moved.length > 0) inText(doc, (text) => text.applyDelta(moved));
  }
  doc.commit({ message });
  // A removal record put back says what the first removal read, not what this copy holds now:
  // text written since (an Undo's own text inverse included) would make every other copy answer
  // it with a restore. Write it again with what the copy reads, as Undo's replay does.
  if (key === STRUCTURE_KEY) restampRemovals(docs, head);
  const now = doc.frontiers();
  return sameValue(head, now) ? null : { key, doc, before: head, after: now };
}

/** A map's values at `frontiers`, from a checked-out copy that is freed after. */
function valuesAt(doc: LoroDoc, frontiers: Frontiers, names: readonly string[]) {
  const view = doc.fork();
  try {
    view.checkout(frontiers);
    return names.map((name) => inMap(view, name, (map) => map.toJSON() as Record<string, unknown>));
  } finally {
    view.free();
  }
}

function invertValues(doc: LoroDoc, after: Frontiers, before: Frontiers, draft: boolean) {
  const names = draft ? STRUCTURE_MAPS.map(overrideMap) : [...STRUCTURE_MAPS];
  const old = valuesAt(doc, before, names);
  const written = valuesAt(doc, after, names);
  names.forEach((name, i) => {
    inMap(doc, name, (current) => {
      for (const key of new Set([...Object.keys(old[i]), ...Object.keys(written[i])])) {
        const prior = old[i][key];
        const last = written[i][key];
        if (sameValue(prior, last) || !sameValue(current.get(key), last)) continue;
        if (prior === undefined) current.delete(key);
        else current.set(key, prior as never);
      }
    });
  });
}

type Op = Delta<string>;

const length = (op: Op) => op.retain ?? op.delete ?? (op.insert as string).length;

function textDiff(doc: LoroDoc, from: Frontiers, to: Frontiers): Op[] {
  const hit = doc.diff(from, to, false).find(([, diff]) => diff.type === "text");
  return hit ? ((hit[1] as { diff: Op[] }).diff ?? []) : [];
}

/** A style set as a comparable key: a style Loro reports as `null` is no style. */
const styleKey = (attributes: Op["attributes"]) =>
  JSON.stringify(
    Object.entries(attributes ?? {})
      .filter(([, value]) => value != null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** The text at `frontiers` as one key per unit: its character and its styles. */
function unitsAt(doc: LoroDoc, frontiers: Frontiers): string[] {
  const view = doc.fork();
  try {
    view.checkout(frontiers);
    const delta = inText(view, (text) => text.toDelta()) as Op[];
    return delta.flatMap((op) =>
      [...(op.insert ?? "")].map((ch) => `${ch}\u0000${styleKey(op.attributes)}`),
    );
  } finally {
    view.free();
  }
}

/**
 * The text Undo of a commit made between `before` and `after`, for the text as it is now (design
 * §2): the inverse `diff(after, before)`, moved through `diff(after, now)`. Where what happened
 * since deleted text and put it back at one place (`align`), the text put back reads as unchanged,
 * so text a later Undo put back as new characters is still the commit's, and words typed inside it
 * stay an insert. A deletion skips what is already gone and keeps what was typed inside it.
 *
 * One condition, the value map's in text form (settled (a)): where the commit replaced text (a
 * deletion and an insertion at one place), the old text comes back only while some of what the
 * commit put in there remains. When a later write removed all of it, the Undo leaves that write
 * alone. A commit that only deleted always gives its text back.
 */
export function transformedInverse(doc: LoroDoc, before: Frontiers, after: Frontiers): Op[] {
  const inverse = textDiff(doc, after, before);
  if (inverse.length === 0) return [];
  const base = unitsAt(doc, after);
  const since = normalizeSince(textDiff(doc, after, doc.frontiers()), base);
  return transform(dropReplaced(inverse, removedBy(since, base.length)), since);
}

/** Which units of the text at the commit's `after` the ops since have deleted. */
function removedBy(since: readonly Op[], size: number): boolean[] {
  const gone = new Array<boolean>(size).fill(false);
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
 * whole: at one place, the inverse deletes what the commit inserted and inserts what it deleted.
 */
function dropReplaced(inverse: readonly Op[], gone: readonly boolean[]): Op[] {
  const out: Op[] = [];
  let pos = 0;
  for (let i = 0; i < inverse.length; ) {
    const op = inverse[i];
    if (op.retain != null) {
      out.push(op);
      pos += op.retain;
      i++;
      continue;
    }
    const place: Op[] = [];
    let deleted = 0;
    while (i < inverse.length && inverse[i].retain == null) {
      const one = inverse[i++];
      place.push(one);
      if (one.delete != null) deleted += one.delete;
    }
    const replaced = deleted > 0 && place.some((one) => one.insert != null);
    const removed = replaced && gone.slice(pos, pos + deleted).every(Boolean);
    for (const one of place) if (!(removed && one.insert != null)) out.push(one);
    pos += deleted;
  }
  return out;
}

type Unit = { ch: string; attributes: Op["attributes"]; key: string };
type Step = { kind: "same" | "insert" | "delete"; unit?: Unit };

/**
 * `since` with each delete-and-insert at one place aligned against the units it deleted (`base`,
 * the text the delta starts from), the shared units kept as retains.
 */
function normalizeSince(since: readonly Op[], base: readonly string[]): Op[] {
  const out: Op[] = [];
  const push = (op: Op) => {
    const last = out.at(-1);
    if (op.retain != null && !op.attributes && last?.retain != null && !last.attributes)
      (last as { retain: number }).retain += op.retain;
    else if (op.delete != null && last?.delete != null)
      (last as { delete: number }).delete += op.delete;
    else out.push(op);
  };
  let pos = 0;
  for (let i = 0; i < since.length; ) {
    const op = since[i];
    if (op.retain != null) {
      push({ ...op });
      pos += op.retain;
      i++;
      continue;
    }
    let deleted = 0;
    const came: Unit[] = [];
    while (i < since.length && since[i].retain == null) {
      const one = since[i++];
      if (one.delete != null) deleted += one.delete;
      else
        for (const ch of one.insert as string)
          came.push({
            ch,
            attributes: one.attributes,
            key: `${ch}\u0000${styleKey(one.attributes)}`,
          });
    }
    for (const step of align(base.slice(pos, pos + deleted), came)) {
      if (step.kind === "same") push({ retain: 1 });
      else if (step.kind === "delete") push({ delete: 1 });
      else {
        const { ch, attributes } = step.unit as Unit;
        push({ insert: ch, ...(attributes ? { attributes } : {}) } as Op);
      }
    }
    pos += deleted;
  }
  return out;
}

/**
 * The units that went (`gone`) against those that came. They are one text when one is the other
 * with a stretch inserted or deleted in its middle (what an Undo put back, with typing inside it
 * since), and that stretch is no longer than what they share: then the shared prefix and suffix
 * read as unchanged. Anything else reads as all gone and all new. A rewrite of the commit's text
 * shares words with it by chance (two sentences share " to the "); reading those as unchanged
 * would have the Undo delete them from the rewrite.
 */
function align(gone: readonly string[], came: readonly Unit[]): Step[] {
  const n = gone.length;
  const m = came.length;
  let prefix = 0;
  while (prefix < n && prefix < m && gone[prefix] === came[prefix].key) prefix++;
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    gone[n - 1 - suffix] === came[m - 1 - suffix].key
  )
    suffix++;
  const shared = prefix + suffix;
  const one = (shared === n || shared === m) && 2 * shared >= Math.max(n, m);
  const steps: Step[] = [];
  if (!one) {
    for (let a = 0; a < n; a++) steps.push({ kind: "delete" });
    for (const unit of came) steps.push({ kind: "insert", unit });
    return steps;
  }
  for (let b = 0; b < prefix; b++) steps.push({ kind: "same", unit: came[b] });
  for (let a = prefix; a < n - suffix; a++) steps.push({ kind: "delete" });
  for (let b = prefix; b < m - suffix; b++) steps.push({ kind: "insert", unit: came[b] });
  for (let b = m - suffix; b < m; b++) steps.push({ kind: "same", unit: came[b] });
  return steps;
}

/** `inverse` and `since` both start from one text; the result is `inverse` after `since`. */
function transform(inverse: readonly Op[], since: readonly Op[]): Op[] {
  const out: Op[] = [];
  const a = inverse.map((op) => ({ ...op }));
  const b = since.map((op) => ({ ...op }));
  let i = 0;
  let j = 0;
  const shrink = (op: Op, n: number) => {
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
      else out.push({ retain: n, ...(x.attributes ? { attributes: x.attributes } : {}) } as Op);
    }
    shrink(x, n);
    shrink(y, n);
    if (length(x) === 0) i++;
    if (length(y) === 0) j++;
  }
  while (out.length > 0 && out.at(-1)?.retain != null && !out.at(-1)?.attributes) out.pop();
  return out;
}

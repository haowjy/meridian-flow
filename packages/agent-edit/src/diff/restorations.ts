/**
 * Restoration links: which browser items Undo re-created from deleted ones.
 *
 * Yjs never undeletes. `redoItem` creates a new item at a new id with a copy of the old content, so one
 * restoration proof feeds the classifier's single provenance resolver, for every kind of item:
 *
 * - `redone` pointers, where the doc has them (the browser that ran the Undo): exact.
 * - Text: a run whose `rightOrigin` names a deleted item is linked only when the whole run's text equals
 *   the original slice. The server (gc off) keeps the text; a browser keeps it only for the tombstones its
 *   own undo stacks retained.
 * - Elements: a new element whose `rightOrigin` names a deleted element of the same name restores it, and
 *   its descendants come back inside it with no origin of their own, so they are paired by content, in
 *   order: the original's children, text, formats and attributes against the new element's. An element is
 *   linked only when everything the original held was found in it.
 * - Formats: a new format item whose `rightOrigin` names a deleted format of the same key and value.
 * - Attributes: a map item that repeats the value of an earlier, deleted item of its own chain.
 *
 * Where a restoration cannot be proven there is no link, and the classifier reads the item as unknown
 * rather than as the writer's.
 */
import * as Y from "yjs";

/** `[client, clock, length, toClient, toClock]`: ids `client:clock..+length` restore `toClient:toClock..`. */
export type RestorationLink = readonly [
  client: number,
  clock: number,
  length: number,
  toClient: number,
  toClock: number,
];

/** Characters of unit pairing one restoration may spend before it is left unproven. */
const PAIR_WORK = 2_000_000;

const textOf = (item: Y.Item) =>
  item.content instanceof Y.ContentString ? item.content.str : null;
const sameId = (a: Y.ID | null, client: number, clock: number) =>
  !!a && a.client === client && a.clock === clock;

/** Whether `next` continues the insertion run that `prev` ends: consecutive clocks, chained origin, same rightOrigin. */
function continues(prev: Y.AbstractStruct, next: Y.AbstractStruct): next is Y.Item {
  if (!(prev instanceof Y.Item) || !(next instanceof Y.Item)) return false;
  const ro = prev.rightOrigin;
  return (
    prev.id.client === next.id.client &&
    next.id.clock === prev.id.clock + prev.length &&
    prev.content instanceof Y.ContentString &&
    next.content instanceof Y.ContentString &&
    !!ro &&
    sameId(next.rightOrigin, ro.client, ro.clock) &&
    sameId(next.origin, prev.id.client, prev.id.clock + prev.length - 1)
  );
}

/** Appends a link, extending the last one when both sides continue it. */
function emit(out: RestorationLink[], to: Y.ID, original: Y.ID, length = 1) {
  const last = out[out.length - 1];
  if (
    last &&
    last[0] === to.client &&
    last[1] + last[2] === to.clock &&
    last[3] === original.client &&
    last[4] + last[2] === original.clock
  )
    out[out.length - 1] = [last[0], last[1], last[2] + length, last[3], last[4]];
  else out.push([to.client, to.clock, length, original.client, original.clock]);
}

const nameOf = (type: Y.AbstractType<unknown>) =>
  type instanceof Y.XmlElement ? type.nodeName : (type.constructor as { name: string }).name;

/** The value an item holds, for deciding that two items hold the same one. */
function valueKey(item: Y.Item): string | null {
  const { content } = item;
  if (content instanceof Y.ContentFormat)
    return `${content.key}\u0000${JSON.stringify(content.value)}`;
  if (content instanceof Y.ContentDeleted || content instanceof Y.ContentType) return null;
  return JSON.stringify(content.getContent());
}

interface Unit {
  key: string;
  id: Y.ID;
  type?: Y.AbstractType<unknown>;
}

/** A type's children one unit per character or object, in order, live or deleted. */
function unitsOf(type: Y.AbstractType<unknown>): Unit[] {
  const out: Unit[] = [];
  for (let c = type._start; c; c = c.right) {
    const { content } = c;
    if (content instanceof Y.ContentString)
      for (let i = 0; i < content.str.length; i++)
        out.push({ key: content.str[i], id: Y.createID(c.id.client, c.id.clock + i) });
    else if (content instanceof Y.ContentType)
      out.push({ key: `<${nameOf(content.type)}`, id: c.id, type: content.type });
    else if (!(content instanceof Y.ContentDeleted)) {
      const key = valueKey(c) ?? "";
      for (let i = 0; i < c.length; i++)
        out.push({ key: `${key}#${i}`, id: Y.createID(c.id.client, c.id.clock + i) });
    } else out.push({ key: "\u0000gone", id: c.id });
  }
  return out;
}

/**
 * Pairs the restored type `r` with the original `o` it came from and emits what matched. True when every
 * unit of the original was found in the same order (the restored type may hold more: the writer typed).
 */
function pair(
  r: Y.AbstractType<unknown>,
  o: Y.AbstractType<unknown>,
  out: RestorationLink[],
  work: { left: number },
): boolean {
  for (const [key, was] of o._map) {
    const now = r._map.get(key);
    if (now && now !== was && valueKey(now) !== null && valueKey(now) === valueKey(was))
      emit(out, now.id, was.id);
  }
  const now = unitsOf(r);
  const was = unitsOf(o);
  let ok = true;
  let from = 0;
  for (const unit of was) {
    let at = from;
    while (at < now.length && now[at].key !== unit.key) at++;
    work.left -= at - from + 1;
    if (at === now.length || work.left < 0) {
      ok = false;
      if (work.left < 0) break;
      continue;
    }
    emit(out, now[at].id, unit.id);
    if (
      unit.type &&
      now[at].type &&
      !pair(now[at].type as Y.AbstractType<unknown>, unit.type, out, work)
    )
      ok = false;
    from = at + 1;
  }
  return ok;
}

export function restorationLinks(doc: Y.Doc): RestorationLink[] {
  const out: RestorationLink[] = [];
  const store = doc.store;
  for (const structs of store.clients.values()) {
    for (let i = 0; i < structs.length; i++) {
      const head = structs[i];
      if (!(head instanceof Y.Item)) continue;
      if (head.redone)
        out.push([
          head.redone.client,
          head.redone.clock,
          head.length,
          head.id.client,
          head.id.clock,
        ]);
      const ro = head.rightOrigin;
      const { content } = head;
      if (content instanceof Y.ContentString) {
        if (!ro || (i > 0 && continues(structs[i - 1], head))) continue; // not a run head
        textRun(doc, structs, i, head, ro, out);
      } else if (head.parentSub !== null && !(content instanceof Y.ContentType)) {
        const key = valueKey(head);
        for (let z = head.left; key !== null && z; z = z.left)
          if (z.deleted && valueKey(z) === key) {
            emit(out, head.id, z.id);
            break;
          }
      } else if (ro && content instanceof Y.ContentFormat) {
        const was = Y.getItem(store, ro);
        if (was instanceof Y.Item && was.deleted && valueKey(was) === valueKey(head))
          emit(out, head.id, was.id);
      } else if (ro && content instanceof Y.ContentType) {
        const was = Y.getItem(store, ro);
        const original =
          was instanceof Y.Item && was.deleted && was.content instanceof Y.ContentType
            ? was.content.type
            : null;
        if (
          original &&
          nameOf(original) === nameOf(content.type) &&
          pair(content.type, original, out, { left: PAIR_WORK })
        )
          emit(out, head.id, was.id);
      }
    }
  }
  return out;
}

/** The text run starting at `structs[i]`: linked only when it repeats the original's slice exactly. */
function textRun(
  doc: Y.Doc,
  structs: Y.AbstractStruct[],
  i: number,
  head: Y.Item,
  ro: Y.ID,
  out: RestorationLink[],
) {
  const original = Y.getItem(doc.store, ro);
  const was = original instanceof Y.Item && original.deleted ? textOf(original) : null;
  if (!(original instanceof Y.Item) || was === null) return;
  const run = [head];
  while (i + run.length < structs.length && continues(run[run.length - 1], structs[i + run.length]))
    run.push(structs[i + run.length] as Y.Item);
  const texts = run.map(textOf);
  const offset = ro.clock - original.id.clock;
  const joined = texts.every((t) => t !== null) ? texts.join("") : null;
  if (joined === null || joined.length > original.length - offset) return;
  if (joined !== was.slice(offset, offset + joined.length)) return;
  let k = 0;
  for (const part of run) {
    out.push([part.id.client, part.id.clock, part.length, ro.client, ro.clock + k]);
    k += part.length;
  }
}

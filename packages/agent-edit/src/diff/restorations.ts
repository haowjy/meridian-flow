/**
 * Restoration links: which browser items Undo re-created from deleted ones.
 *
 * Yjs never undeletes. `redoItem` creates a new item whose `rightOrigin` is the original's id, and text
 * typed in front of an item that is later deleted has the same `rightOrigin`. A run is linked only when
 * the whole run's text equals the original slice, so the link needs the text: the server (gc off) keeps
 * it, a browser keeps it only for the tombstones its own undo stacks retained. Where the text is gone
 * there is no link: the item reads as the writer's, never a guess from length.
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

export function restorationLinks(doc: Y.Doc): RestorationLink[] {
  const out: RestorationLink[] = [];
  for (const structs of doc.store.clients.values()) {
    for (let i = 0; i < structs.length; i++) {
      const head = structs[i];
      const ro = head instanceof Y.Item ? head.rightOrigin : null;
      if (!(head instanceof Y.Item) || !ro || !(head.content instanceof Y.ContentString)) continue;
      if (i > 0 && continues(structs[i - 1], head)) continue; // not a run head
      const original = Y.getItem(doc.store, ro);
      const was = original instanceof Y.Item && original.deleted ? textOf(original) : null;
      if (!(original instanceof Y.Item) || was === null) continue;
      const run = [head];
      while (
        i + run.length < structs.length &&
        continues(run[run.length - 1], structs[i + run.length])
      )
        run.push(structs[i + run.length] as Y.Item);
      const texts = run.map(textOf);
      const offset = ro.clock - original.id.clock;
      const joined = texts.every((t) => t !== null) ? texts.join("") : null;
      if (joined === null || joined.length > original.length - offset) continue;
      if (joined !== was.slice(offset, offset + joined.length)) continue;
      let k = 0;
      for (const part of run) {
        out.push([part.id.client, part.id.clock, part.length, ro.client, ro.clock + k]);
        k += part.length;
      }
    }
  }
  return out;
}

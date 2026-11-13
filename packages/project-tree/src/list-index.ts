import type * as Y from "yjs";
import { recordsOf, type SettleRecord, settleLogOf, type TreeRecord } from "./record.js";

/**
 * What admission and the commands ask of the whole list, kept with a copy as it changes instead
 * of read out of it each time: every record id, every node id a create has used, every command
 * id a settlement carries. It follows any write to the copy, whoever makes it.
 */
export type ListIndex = {
  records: Set<string>;
  nodes: Set<string>;
  commands: Set<string>;
};

const indexes = new WeakMap<Y.Doc, ListIndex>();

export function listIndex(doc: Y.Doc): ListIndex {
  const held = indexes.get(doc);
  if (held) return held;
  const index: ListIndex = { records: new Set(), nodes: new Set(), commands: new Set() };
  const ops = recordsOf(doc);
  const settle = settleLogOf(doc);
  for (const record of ops.toArray()) {
    index.records.add(record.id);
    if (record.type === "create") index.nodes.add(record.node);
  }
  for (const entry of settle.toArray()) if (entry.command) index.commands.add(entry.command);
  ops.observe((event) => {
    for (const item of event.changes.added)
      for (const record of item.content.getContent() as TreeRecord[]) {
        index.records.add(record.id);
        if (record.type === "create") index.nodes.add(record.node);
      }
  });
  settle.observe((event) => {
    for (const item of event.changes.added)
      for (const entry of item.content.getContent() as SettleRecord[])
        if (entry.command) index.commands.add(entry.command);
  });
  indexes.set(doc, index);
  return index;
}

/** A command id answers one request. A repeated request is the caller's to answer, so reuse is a bug. */
export function assertNewCommand(doc: Y.Doc, command: string): void {
  if (listIndex(doc).commands.has(command)) throw new Error(`command ${command} was already used`);
}

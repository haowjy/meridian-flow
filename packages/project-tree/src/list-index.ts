import type * as Y from "yjs";
import { type SettleRecord, settleLogOf } from "./record.js";

/**
 * Every command id a settlement carries, kept with a copy as it changes instead of read out of
 * the settle log each time. It follows any write to the copy, whoever makes it.
 */
const indexes = new WeakMap<Y.Doc, Set<string>>();

function commandsOf(doc: Y.Doc): Set<string> {
  const held = indexes.get(doc);
  if (held) return held;
  const commands = new Set<string>();
  const settle = settleLogOf(doc);
  for (const entry of settle.toArray()) if (entry.command) commands.add(entry.command);
  settle.observe((event) => {
    for (const item of event.changes.added)
      for (const entry of item.content.getContent() as SettleRecord[])
        if (entry.command) commands.add(entry.command);
  });
  indexes.set(doc, commands);
  return commands;
}

/** A command id answers one request. A repeated request is the caller's to answer, so reuse is a bug. */
export function assertNewCommand(doc: Y.Doc, command: string): void {
  if (commandsOf(doc).has(command)) throw new Error(`command ${command} was already used`);
}

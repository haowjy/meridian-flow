import type { LoroDoc } from "loro-crdt";
import { listMark, listOf } from "./list-doc.js";

/**
 * Every command id a settlement carries, kept with a copy and read again only once the copy
 * changed (its lists' lengths moved), instead of out of the settle log for each command.
 */
const indexes = new WeakMap<LoroDoc, { mark: string; commands: Set<string> }>();

function commandsOf(doc: LoroDoc): Set<string> {
  const mark = listMark(doc);
  const held = indexes.get(doc);
  if (held?.mark === mark) return held.commands;
  const commands = new Set<string>();
  for (const entry of listOf(doc).settles()) if (entry.command) commands.add(entry.command);
  indexes.set(doc, { mark, commands });
  return commands;
}

/** A command id answers one request. A repeated request is the caller's to answer, so reuse is a bug. */
export function assertNewCommand(doc: LoroDoc, command: string): void {
  if (commandsOf(doc).has(command)) throw new Error(`command ${command} was already used`);
}

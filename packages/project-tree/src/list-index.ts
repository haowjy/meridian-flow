import type { LoroDoc } from "loro-crdt";
import { listMark, listOf } from "./list-doc.js";

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

export function assertNewCommand(doc: LoroDoc, command: string): void {
  if (commandsOf(doc).has(command)) throw new Error(`command ${command} was already used`);
}

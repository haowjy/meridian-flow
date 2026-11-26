import { editHandle } from "@meridian/agent-edit/integration";
import { effectiveActionIndex, partKey as key } from "./inverse-actions.js";
import type { StoredInversePart } from "./turn-inverse-service.js";

export type Entry = {
  id: string;
  handle: string;
  parts: StoredInversePart[];
};
export const entryKeys = (entry: Entry) => entry.parts.map(key);
export function entries(history: readonly StoredInversePart[], threadId: string): Entry[] {
  const map = new Map<string, Entry>();
  for (const part of history) {
    if (
      part.threadId !== threadId ||
      part.actor !== "agent" ||
      part.wId === null ||
      (part.kind !== "write" && part.kind !== "revert") ||
      part.delta === null
    )
      continue;
    const entry = map.get(part.editId) ?? {
      id: part.editId,
      handle: editHandle(part.wId),
      parts: [],
    };
    entry.parts.push(part);
    map.set(part.editId, entry);
  }
  return [...map.values()].sort((a, b) => Number(b.handle.slice(1)) - Number(a.handle.slice(1)));
}
export function inspectionActions(history: StoredInversePart[], own: Entry[]) {
  const actions = effectiveActionIndex(history, new Set(own.flatMap(entryKeys)));
  const modelConsumed = new Set(
    actions.actions.flatMap((action) =>
      action.parts.every((part) => part.actor === "agent") ? [...action.targets] : [],
    ),
  );
  const stack = own.filter((entry) => {
    const keys = entryKeys(entry);
    return (
      !keys.some((key) => modelConsumed.has(key)) && !keys.every((key) => actions.byPart.has(key))
    );
  });
  return {
    actions,
    stack,
    top: stack[0],
  };
}

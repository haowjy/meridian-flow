/** Shared model inverse stack selection and immutable-view classification. */

import { editHandle, type PreparedEditRoots } from "@meridian/agent-edit/integration";
import { effectiveActionIndex, partKey as key } from "./inverse-actions.js";
import type { StoredInversePart } from "./turn-inverse-service.js";

/** One model-visible edit on the stack. */
export type Entry = {
  id: string;
  handle: string;
  parts: StoredInversePart[];
};
export const entryKeys = (entry: Entry) => entry.parts.map(key);
export const entryRows = (entry: Entry): { id: number; key: string }[] =>
  entry.parts.map((part) => ({ id: part.id, key: key(part) }));
export function entries(history: readonly StoredInversePart[], threadId: string): Entry[] {
  const map = new Map<string, Entry>();
  for (const part of history) {
    if (
      part.threadId !== threadId ||
      part.actor !== "agent" ||
      part.wId === null ||
      (part.kind !== "write" && part.kind !== "revert") ||
      (!part.effect.inserted.length && !part.effect.deleted.length)
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
  const rolledBack = (part: StoredInversePart) => actions.rolledBack.has(key(part));
  const modelConsumed = new Set(
    actions.actions.flatMap((action) =>
      action.parts.every((part) => part.actor === "agent") ? [...action.targets] : [],
    ),
  );
  const stack = own.filter((entry) => {
    const keys = entryKeys(entry);
    return (
      !keys.some((key) => modelConsumed.has(key)) &&
      !keys.every((key) => actions.byPart.has(key) || actions.rolledBack.has(key))
    );
  });
  return {
    actions,
    rolledBack,
    stack,
    top: stack[0],
    candidate: actions.actions.find(
      (action) =>
        !own.some((entry) =>
          entryRows(entry).some(
            (row) => row.id > action.newest && !actions.rolledBack.has(row.key),
          ),
        ),
    ),
  };
}
/** Facts belong to one immutable view. Advancing a scratch plan replaces this context. */
export function inspectionContext(
  index: PreparedEditRoots,
  actions: ReturnType<typeof inspectionActions>,
) {
  const classifications = new Map<string, ReturnType<PreparedEditRoots["classify"]>[number]>();
  return {
    index,
    ...actions,
    states(parts: StoredInversePart[]) {
      const missing = parts.filter((part) => !classifications.has(key(part)));
      if (missing.length)
        for (const state of index.classify(missing)) classifications.set(key(state.part), state);
      return parts.map((part) => {
        const state = classifications.get(key(part));
        if (!state) throw new Error("Missing inverse classification");
        return state;
      });
    },
  };
}
export type Inspection = ReturnType<typeof inspectionContext>;

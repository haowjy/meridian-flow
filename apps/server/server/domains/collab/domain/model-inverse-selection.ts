/** Shared model inverse stack selection and immutable-view classification. */

import { editHandle, type PreparedEditRoots } from "@meridian/agent-edit/integration";
import { effectiveActionIndex, partKey as key } from "./inverse-actions.js";
import {
  isTransitionEntry,
  materializedTreeEditIds,
  type StoredTreeEntry,
  type TransitionEntry,
  treeKey,
} from "./tree-inverse.js";
import type { InverseDocument, StoredInversePart } from "./turn-inverse-service.js";

/** One model-visible edit on the stack. A creation owns its initial text and tree placement. */
export type Entry = {
  id: string;
  handle: string;
  parts: StoredInversePart[];
  tree?: TransitionEntry;
};
export const entryKeys = (entry: Entry) => [
  ...entry.parts.map(key),
  ...(entry.tree ? [treeKey(entry.tree.editId)] : []),
];
export const entryRows = (entry: Entry): { id: number; key: string }[] => [
  ...entry.parts.map((part) => ({ id: part.id, key: key(part) })),
  ...(entry.tree ? [{ id: entry.tree.id, key: treeKey(entry.tree.editId) }] : []),
];
export function entries(document: InverseDocument, threadId: string): Entry[] {
  const map = new Map<string, Entry>();
  const materialized = materializedTreeEditIds(document.tree);
  for (const row of document.tree)
    if (
      isTransitionEntry(row) &&
      !materialized.has(row.editId) &&
      row.threadId === threadId &&
      row.actor === "agent" &&
      row.wId !== null &&
      (row.kind === "write" || row.kind === "revert")
    )
      map.set(row.editId, { id: row.editId, handle: editHandle(row.wId), parts: [], tree: row });
  for (const part of document.history) {
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
  const ordered = [...map.values()].sort(
    (a, b) => Number(b.handle.slice(1)) - Number(a.handle.slice(1)),
  );
  const mergedCreates = new Set<Entry>();
  for (const [index, entry] of ordered.entries()) {
    if (!entry.parts.length) continue;
    const create = ordered[index + 1];
    if (
      create?.tree?.tree.op !== "create" ||
      create.parts.length ||
      Number(entry.handle.slice(1)) !== Number(create.handle.slice(1)) + 1 ||
      entry.parts[0]?.turnId !== create.tree.turnId ||
      entry.parts[0]?.responseId !== create.tree.responseId ||
      entry.parts[0]?.editScopeId !== create.tree.editScopeId ||
      !entry.parts[0]?.toolCallId ||
      entry.parts[0].toolCallId !== create.tree.toolCallId
    )
      continue;
    entry.tree = create.tree;
    mergedCreates.add(create);
  }
  return ordered.filter((entry) => !mergedCreates.has(entry));
}
export function inspectionActions(
  history: StoredInversePart[],
  tree: readonly StoredTreeEntry[],
  own: Entry[],
) {
  const actions = effectiveActionIndex<StoredInversePart | StoredTreeEntry>(
    [...history, ...tree],
    new Set(own.flatMap(entryKeys)),
  );
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

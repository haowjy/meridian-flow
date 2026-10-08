/**
 * Which handles an `undo` or `redo` selects when a document has creates,
 * moves or deletes as well as content writes, and the order to act on them.
 * Both kinds share one `w_id` sequence per document and thread, so the
 * engine's own selector picks from both: undo by `w_id`, redo by when each
 * was undone. The walk goes newest first on undo and oldest first on redo; a
 * create shares its content write's handle and goes after it on undo, before
 * it on redo. Consecutive content writes go to the engine as one step.
 */
import {
  type ReversalSelection,
  selectByHandle,
  writeHandle,
} from "@meridian/agent-edit/integration";
import {
  liveAfter,
  type NamespaceChangeRecord,
  type WriteHandleHistory,
} from "../../domains/collab/index.js";

type ReversalStep =
  | { kind: "content"; handles: string[] }
  | { kind: "namespace"; change: NamespaceChangeRecord };

type ReversalWalk =
  | { ok: true; steps: ReversalStep[] }
  | { ok: false; status: "invalid_write" | "cant_undo_dependent"; message: string };

type Entry = { handle: string; wId: number; at: number; change?: NamespaceChangeRecord };

export function planReversalWalk(input: {
  direction: "undo" | "redo";
  selection: ReversalSelection;
  history: WriteHandleHistory;
  /** Whether the document exists now, and the path the model named it by. */
  live: boolean;
  path: string;
}): ReversalWalk {
  const { direction, history } = input;
  const undo = direction === "undo";
  const status = undo ? "active" : "reversed";
  // Undo takes the newest writes; redo the most recently undone.
  const at = (wId: number, reversedAt: Date | null) => (undo ? wId : (reversedAt?.getTime() ?? 0));
  const entries: Entry[] = [
    ...history.content
      .filter((handle) => handle.status === status)
      .map((handle) => ({
        handle: writeHandle(handle.wId),
        wId: handle.wId,
        at: at(handle.wId, handle.reversedAt),
      })),
    ...history.namespace
      .filter((change) => change.status === status)
      .map((change) => ({
        handle: writeHandle(change.wId),
        wId: change.wId,
        at: at(change.wId, change.reversedAt),
        change,
      })),
  ];

  const byHandle = new Map<
    string,
    { handle: string; turnId: null; createdSeq: number; at: number }
  >();
  for (const entry of entries) {
    const seen = byHandle.get(entry.handle);
    byHandle.set(entry.handle, {
      handle: entry.handle,
      turnId: null,
      createdSeq: entry.wId,
      at: Math.max(seen?.at ?? entry.at, entry.at),
    });
  }
  const ordered = [...byHandle.values()].sort(
    (left, right) => left.at - right.at || left.createdSeq - right.createdSeq,
  );
  const selected = selectByHandle(ordered, input.selection);
  if (!selected.ok) return selected;
  const chosen = new Set(selected.items.map((item) => item.handle));
  const picked = entries.filter((entry) => chosen.has(entry.handle));

  const refusal = dependencyRefusal(direction, picked, entries, chosen);
  if (refusal) return { ok: false, status: "cant_undo_dependent", message: refusal };

  // A create ranks just under its content write: after it on undo, before it on redo.
  const rank = (entry: Entry) => entry.wId * 2 + (entry.change ? 0 : 1);
  picked.sort((left, right) => (undo ? rank(right) - rank(left) : rank(left) - rank(right)));

  const steps: ReversalStep[] = [];
  let live = input.live;
  for (const entry of picked) {
    if (entry.change) {
      steps.push({ kind: "namespace", change: entry.change });
      live = liveAfter(entry.change, direction);
      continue;
    }
    if (!live) {
      return { ok: false, status: "invalid_write", message: deletedRefusal(input) };
    }
    const last = steps.at(-1);
    if (last?.kind === "content") last.handles.push(entry.handle);
    else steps.push({ kind: "content", handles: [entry.handle] });
  }
  return { ok: true, steps };
}

/** A deleted document's content writes wait for the change that removed it. */
function deletedRefusal(input: {
  direction: "undo" | "redo";
  history: WriteHandleHistory;
  path: string;
}): string {
  const remover = [...input.history.namespace]
    .reverse()
    .find(
      (change) =>
        (change.kind === "delete" && change.status === "active") ||
        (change.kind === "create" && change.status === "reversed"),
    );
  const done = input.direction === "undo" ? "undone" : "redone";
  const first = !remover
    ? "Undo the delete first."
    : `${remover.kind === "delete" ? "Undo" : "Redo"} ${writeHandle(remover.wId)} first.`;
  return `${input.path} is deleted, so its other writes can't be ${done}. ${first}`;
}

/**
 * Creates, moves and deletes are a stack: one reverses from where the next
 * left the document, so undo takes the later ones with it and redo the
 * earlier ones. Undoing a create deletes the document, so it takes every
 * later write too.
 */
function dependencyRefusal(
  direction: "undo" | "redo",
  picked: readonly Entry[],
  candidates: readonly Entry[],
  chosen: ReadonlySet<string>,
): string | undefined {
  const changes = picked.filter((entry) => entry.change);
  if (changes.length === 0) return undefined;
  const undo = direction === "undo";
  const wIds = changes.map((entry) => entry.wId);
  const edge = undo ? Math.min(...wIds) : Math.max(...wIds);
  const create = undo && changes.some((entry) => entry.change?.kind === "create");
  const blocking = [
    ...new Set(
      candidates
        .filter((entry) => !chosen.has(entry.handle))
        .filter((entry) => (undo ? entry.wId > edge : entry.wId < edge))
        .filter((entry) => entry.change || create)
        .map((entry) => entry.wId),
    ),
  ];
  if (blocking.length === 0) return undefined;
  const handles = (ids: readonly number[]) =>
    [...new Set(ids)].sort((left, right) => left - right).map(writeHandle);
  const list = (ids: readonly number[]) => handles(ids).join(", ");
  const all = [...wIds, ...blocking];
  const range = `${writeHandle(Math.min(...all))}..${writeHandle(Math.max(...all))}`;
  return undo
    ? `Can't undo ${list(wIds)} on its own — ${list(blocking)} changed the document after it. Undo ${list(blocking)} first, or undo the range ${range}.`
    : `Can't redo ${list(wIds)} on its own — ${list(blocking)}, undone too, came before it. Redo ${list(blocking)} first, or redo the range ${range}.`;
}

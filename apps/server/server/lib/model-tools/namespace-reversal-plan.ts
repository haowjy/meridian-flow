/**
 * Which handles an `undo` or `redo` selects when a document has moves or
 * deletes as well as content writes. Both kinds share one `w_id` sequence per
 * document and thread, so `last: N` and the handle selectors count them
 * together: undo by `w_id`, redo by when each was undone. The content part
 * goes to the engine as a selector of its own.
 */
import { parseWriteHandle, writeHandle } from "@meridian/agent-edit/integration";
import type {
  NamespaceChangeRecord,
  WriteHandleHistory,
} from "../../domains/collab/domain/ports/agent-namespace-changes.js";

/** The selector fields `undo` and `redo` take; none means the latest. */
export type ReversalFields = { to?: string; since?: string; last?: number; all?: boolean };

export type NamespaceReversalPlan =
  | {
      ok: true;
      /** In the order to act on: undo newest first, redo oldest first. */
      namespace: NamespaceChangeRecord[];
      /** The engine's selector for the content writes, or null when none are selected. */
      content: ReversalFields | null;
    }
  | { ok: false; status: "invalid_write" | "cant_undo_dependent"; message: string };

type Entry =
  | { kind: "namespace"; wId: number; at: number; change: NamespaceChangeRecord }
  | { kind: "content"; wId: number; at: number };

export function planNamespaceReversal(
  direction: "undo" | "redo",
  fields: ReversalFields,
  history: WriteHandleHistory,
): NamespaceReversalPlan {
  const status = direction === "undo" ? "active" : "reversed";
  const changes = history.namespace.filter((change) => change.status === status);
  const unchanged = { ok: true as const, namespace: [], content: fields };
  if (changes.length === 0) return unchanged;

  const contents = history.content.filter((handle) => handle.status === status);
  // Undo takes the newest writes; redo the most recently undone.
  const at = (wId: number, reversedAt: Date | null) =>
    direction === "undo" ? wId : (reversedAt?.getTime() ?? 0);
  const entries: Entry[] = [
    ...changes.map((change) => ({
      kind: "namespace" as const,
      wId: change.wId,
      at: at(change.wId, change.reversedAt),
      change,
    })),
    ...contents.map((handle) => ({
      kind: "content" as const,
      wId: handle.wId,
      at: at(handle.wId, handle.reversedAt),
    })),
  ].sort((left, right) => left.at - right.at || left.wId - right.wId);

  const selected = select(entries, fields);
  if (!selected.ok) return selected;
  const namespace = selected.entries.flatMap((entry) =>
    entry.kind === "namespace" ? [entry.change] : [],
  );
  if (namespace.length === 0) return unchanged;
  const contentCount = selected.entries.length - namespace.length;
  const refusal = dependencyRefusal(direction, namespace, changes);
  if (refusal) return { ok: false, status: "cant_undo_dependent", message: refusal };

  namespace.sort((left, right) =>
    direction === "undo" ? right.wId - left.wId : left.wId - right.wId,
  );
  if (contentCount === 0) return { ok: true, namespace, content: null };
  return {
    ok: true,
    namespace,
    // A selector by handle names the same writes to the engine; a count counts only its own.
    content: fields.last !== undefined ? { last: contentCount } : fields,
  };
}

function select(
  entries: readonly Entry[],
  fields: ReversalFields,
): { ok: true; entries: Entry[] } | Extract<NamespaceReversalPlan, { ok: false }> {
  if (fields.all) return { ok: true, entries: [...entries] };
  if (fields.last !== undefined) return { ok: true, entries: entries.slice(-fields.last) };
  if (fields.to !== undefined && fields.since !== undefined) {
    const since = parseWriteHandle(fields.since);
    const to = parseWriteHandle(fields.to);
    if (since === undefined || to === undefined || since > to) {
      return { ok: false, status: "invalid_write", message: "Invalid write range" };
    }
    return {
      ok: true,
      entries: entries.filter((entry) => entry.wId >= since && entry.wId <= to),
    };
  }
  if (fields.to !== undefined) {
    const to = parseWriteHandle(fields.to);
    return { ok: true, entries: entries.filter((entry) => entry.wId === to) };
  }
  return { ok: true, entries: entries.slice(-1) };
}

/**
 * A move or delete reverses from where the next one left the document, so
 * undo takes the later ones with it and redo the earlier ones.
 */
function dependencyRefusal(
  direction: "undo" | "redo",
  selected: readonly NamespaceChangeRecord[],
  candidates: readonly NamespaceChangeRecord[],
): string | undefined {
  const chosen = new Set(selected.map((change) => change.id));
  const edge =
    direction === "undo"
      ? Math.min(...selected.map((change) => change.wId))
      : Math.max(...selected.map((change) => change.wId));
  const blocking = candidates
    .filter((change) => !chosen.has(change.id))
    .filter((change) => (direction === "undo" ? change.wId > edge : change.wId < edge))
    .map((change) => change.wId);
  if (blocking.length === 0) return undefined;
  const handles = (wIds: readonly number[]) =>
    [...wIds].sort((left, right) => left - right).map(writeHandle);
  const picked = handles(selected.map((change) => change.wId));
  const blockers = handles(blocking);
  const all = [...selected.map((change) => change.wId), ...blocking];
  const range = `${writeHandle(Math.min(...all))}..${writeHandle(Math.max(...all))}`;
  const list = (items: string[]) => items.join(", ");
  return direction === "undo"
    ? `Can't undo ${list(picked)} on its own — ${list(blockers)} moved or deleted the document after it. Undo ${list(blockers)} first, or undo the range ${range}.`
    : `Can't redo ${list(picked)} on its own — ${list(blockers)}, undone too, came before it. Redo ${list(blockers)} first, or redo the range ${range}.`;
}

/** Mixed-history reversal planning, eligibility and per-document execution, shared by model tools, writer turns and receipt projection. */
import {
  type ReversalSelection,
  selectByHandle,
  writeHandle,
} from "@meridian/agent-edit/integration";
import type { Result } from "../../../shared/result.js";
import {
  type ChangeClaimed,
  liveAfter,
  locationAfter,
  type NamespaceChanges,
  type NamespaceTree,
} from "./namespace-changes.js";
import type { NamespaceChangeRecord, WriteHandleHistory } from "./ports/agent-namespace-changes.js";

type ReversalStep =
  | { kind: "content"; handles: string[] }
  | { kind: "namespace"; change: NamespaceChangeRecord };

type ReversalWalk =
  | { ok: true; steps: ReversalStep[] }
  | { ok: false; status: "invalid_write"; message: string }
  | { ok: false; status: "invalid_write"; deletedBy: NamespaceChangeRecord | undefined }
  | {
      ok: false;
      status: "cant_undo_dependent";
      selected: number[];
      blocking: number[];
      undoFirst: number[];
    };

type Entry = { handle: string; wId: number; at: number; change?: NamespaceChangeRecord };

export function planReversalWalk(input: {
  direction: "undo" | "redo";
  selection: ReversalSelection;
  history: WriteHandleHistory;
  /** Whether the document exists at the start of this walk. */
  live: boolean;
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

  const eligibility = namespaceReversalEligibility({
    direction,
    history,
    changes: picked.flatMap((entry) => (entry.change ? [entry.change] : [])),
    contentHandles: new Set(picked.filter((entry) => !entry.change).map((entry) => entry.wId)),
  });
  if (!eligibility.ok) return { ...eligibility, status: "cant_undo_dependent" };

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
      return {
        ok: false,
        status: "invalid_write",
        deletedBy: [...history.namespace]
          .reverse()
          .find(
            (change) =>
              (change.kind === "delete" && change.status === "active") ||
              (change.kind === "create" && change.status === "reversed"),
          ),
      };
    }
    const last = steps.at(-1);
    if (last?.kind === "content") last.handles.push(entry.handle);
    else steps.push({ kind: "content", handles: [entry.handle] });
  }
  return { ok: true, steps };
}

type Eligibility =
  | { ok: true }
  | { ok: false; selected: number[]; blocking: number[]; undoFirst: number[] };

export function namespaceReversalEligibility(input: {
  direction: "undo" | "redo";
  changes: readonly NamespaceChangeRecord[];
  history: WriteHandleHistory;
  /** Content writes reversed by the same command, not dependencies left behind. */
  contentHandles: ReadonlySet<number>;
}): Eligibility {
  const { direction, changes, history, contentHandles } = input;
  if (changes.length === 0) return { ok: true };
  const undo = direction === "undo";
  const selected = changes.map((change) => change.wId);
  const chosen = new Set(changes.map((change) => change.id));
  const edge = undo ? Math.min(...selected) : Math.max(...selected);
  const creates = changes.filter((change) => change.kind === "create");
  const blocking = [
    ...history.namespace
      .filter(
        (change) =>
          !chosen.has(change.id) &&
          (undo
            ? change.status === "active" && change.wId > edge
            : change.status === "reversed"
              ? change.wId < edge
              : change.wId > Math.min(...selected)),
      )
      .map((change) => change.wId),
    ...(undo && creates.length > 0
      ? history.content
          .filter(
            (handle) =>
              handle.status === "active" &&
              handle.wId >= Math.min(...creates.map((change) => change.wId)) &&
              !contentHandles.has(handle.wId),
          )
          .map((handle) => handle.wId)
      : []),
  ];
  return blocking.length === 0
    ? { ok: true }
    : {
        ok: false,
        selected,
        blocking: [...new Set(blocking)],
        undoFirst: undo
          ? []
          : history.namespace
              .filter((change) => change.status === "active" && blocking.includes(change.wId))
              .map((change) => change.wId),
      };
}

/** A whole turn selects its own content and namespace writes, without changing either. */
export async function turnNamespaceEligibility(
  history: Pick<NamespaceChanges, "history">,
  input: {
    threadId: string;
    turnId: string;
    direction: "undo" | "redo";
    changes: readonly NamespaceChangeRecord[];
  },
): Promise<{ ok: true } | { ok: false; change: NamespaceChangeRecord }> {
  const documents = new Map<string, [NamespaceChangeRecord, ...NamespaceChangeRecord[]]>();
  for (const change of input.changes) {
    const changes = documents.get(change.documentId);
    if (changes) changes.push(change);
    else documents.set(change.documentId, [change]);
  }
  for (const [documentId, changes] of documents) {
    const first = changes[0];
    const handles = await history.history(documentId, input.threadId);
    const eligibility = namespaceReversalEligibility({
      direction: input.direction,
      changes,
      history: handles,
      contentHandles: new Set(
        handles.content
          .filter((handle) => handle.turnId === input.turnId)
          .map((handle) => handle.wId),
      ),
    });
    if (!eligibility.ok) return { ok: false, change: first };
  }
  return { ok: true };
}

export type ReversalLocation = { live: boolean; uri: string };

/** Access and content are host ports; the walk owns order, location and completed handles. */
type ReversalPorts<T, E> = {
  changes: Pick<NamespaceChanges, "reverse">;
  tree: NamespaceTree<E>;
  access(
    change: NamespaceChangeRecord,
    at: ReversalLocation,
    apply: () => Promise<Result<void, E | ChangeClaimed>>,
  ): Promise<Result<void, E | ChangeClaimed>>;
  content(
    uri: string,
    handles: readonly string[],
  ): Promise<Result<{ value: T; writes: readonly string[] }, E>>;
};

export async function executeNamespaceReversal<T, E>(
  ports: ReversalPorts<T, E>,
  input: { direction: "undo" | "redo"; start: ReversalLocation; steps: readonly ReversalStep[] },
) {
  let location = input.start;
  let last: T | null = null;
  const done: string[] = [];
  const contentDone = new Set<string>();
  const progress = () => ({ location, last, writes: done });
  for (const step of input.steps) {
    if (step.kind === "namespace") {
      const { change } = step;
      const applied = await ports.access(change, location, () =>
        ports.changes.reverse(ports.tree, change, input.direction),
      );
      if (!applied.ok)
        return {
          ...progress(),
          failure: { kind: "namespace" as const, change, error: applied.error },
        };
      done.push(writeHandle(change.wId));
      location = {
        live: liveAfter(change, input.direction),
        uri: locationAfter(change, input.direction),
      };
    } else {
      // Writer turn reversals can group handles; never apply one twice in a walk.
      const handles = step.handles.filter((handle) => !contentDone.has(handle));
      if (handles.length === 0) continue;
      const applied = await ports.content(location.uri, handles);
      if (!applied.ok)
        return { ...progress(), failure: { kind: "content" as const, error: applied.error } };
      for (const handle of applied.value.writes) {
        done.push(handle);
        contentDone.add(handle);
      }
      last = applied.value.value;
    }
  }
  return { ...progress(), failure: undefined };
}

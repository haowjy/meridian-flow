/**
 * Splits a model undo or redo between the two journals a thread's writes to
 * one document can land in: live, and the thread's Work draft. Each selected
 * write is reversed where it landed, so a selection that spans both runs once
 * per journal with the part that journal holds; `mergeReversals` joins the
 * parts' results.
 */
import {
  type ActiveWriteSummary,
  isWriteErrorStatus,
  parseWriteHandle,
  type ReversalRecord,
  type ReversalSelection,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import { type FileAccessDenied, FileEditRefusedError } from "../../file-policy/index.js";
import type { RoutedWriteOutcome } from "./agent-edit-cores.js";

export type ReversalSide = "live" | "draft";

/** One journal's reversible writes for a thread on a document. */
export type ReversalHistory = {
  active: readonly Pick<ActiveWriteSummary, "handle">[];
  reversals: readonly Pick<ReversalRecord, "writeIds" | "status" | "reversedAt" | "expiresAt">[];
};

/** What one journal runs, and the writes it selected there. */
type ReversalRoute = { selection: ReversalSelection; handles: string[] };

type Candidate = { handle: string; side: ReversalSide; ordinal: number; undoneAt: number };

/**
 * The selection each journal runs, draft first. A selection that matches no
 * write runs live, which reports it as nothing to reverse or as invalid.
 */
export function splitReversal(input: {
  direction: "undo" | "redo";
  selection: ReversalSelection;
  live: ReversalHistory;
  draft: ReversalHistory | null;
  now?: Date;
}): Map<ReversalSide, ReversalRoute> {
  const now = input.now ?? new Date();
  const histories: Array<[ReversalSide, ReversalHistory]> = [["live", input.live]];
  if (input.draft) histories.push(["draft", input.draft]);
  const candidates = histories
    .flatMap(([side, history]) =>
      input.direction === "undo"
        ? undoCandidates(side, history)
        : redoCandidates(side, history, now),
    )
    .sort((left, right) => left.undoneAt - right.undoneAt || left.ordinal - right.ordinal);
  const selected = selectCandidates(input.selection, candidates);
  const routes = new Map<ReversalSide, ReversalRoute>();
  for (const side of ["draft", "live"] as const) {
    const handles = selected
      .filter((candidate) => candidate.side === side)
      .map((candidate) => candidate.handle);
    if (handles.length === 0) continue;
    // `last` counts within the journal: its share of the most recent writes.
    const selection: ReversalSelection =
      input.selection.kind === "last" ? { kind: "last", count: handles.length } : input.selection;
    routes.set(side, { selection, handles });
  }
  if (routes.size === 0) routes.set("live", { selection: input.selection, handles: [] });
  return routes;
}

function undoCandidates(side: ReversalSide, history: ReversalHistory): Candidate[] {
  return history.active.map((write) => ({
    handle: write.handle,
    side,
    ordinal: parseWriteHandle(write.handle) ?? 0,
    undoneAt: 0,
  }));
}

/** Undone writes still eligible to redo, ordered by when they were undone. */
function redoCandidates(side: ReversalSide, history: ReversalHistory, now: Date): Candidate[] {
  return history.reversals
    .filter(
      (record) => record.status === "reversed" && !(record.expiresAt && record.expiresAt <= now),
    )
    .flatMap((record) =>
      record.writeIds.map((handle) => ({
        handle,
        side,
        ordinal: parseWriteHandle(handle) ?? 0,
        undoneAt: record.reversedAt?.getTime() ?? 0,
      })),
    );
}

function selectCandidates(selection: ReversalSelection, candidates: Candidate[]): Candidate[] {
  switch (selection.kind) {
    case "latest":
      return candidates.slice(-1);
    case "last":
      return candidates.slice(-selection.count);
    case "single":
      return candidates.filter((candidate) => candidate.handle === selection.to);
    case "handles":
      return candidates.filter((candidate) => selection.ids.includes(candidate.handle));
    case "range": {
      const since = parseWriteHandle(selection.since);
      const to = parseWriteHandle(selection.to);
      if (since === undefined || to === undefined) return [];
      return candidates.filter(
        (candidate) => candidate.ordinal >= since && candidate.ordinal <= to,
      );
    }
    case "all":
    case "turn":
      return candidates;
  }
}

/**
 * One result for a reversal that ran in both journals, or was refused in one.
 * Anything reversed makes it `partial` unless every part reversed; with
 * nothing reversed, an error from either part is the result, and a refusal
 * alone is thrown as the refusal it is.
 */
export function mergeReversals(
  direction: "undo" | "redo",
  outcomes: readonly WriteOutcome[],
  refused: { writeIds: string[]; denial: FileAccessDenied }[],
): RoutedWriteOutcome {
  const noop = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";
  const effective = outcomes.filter((outcome) => outcome.status !== noop);
  const [first] = effective.length > 0 ? effective : outcomes;
  if (!first) throw new FileEditRefusedError(refused.map(({ denial }) => denial));
  if (refused.length === 0 && effective.length <= 1) return first;
  const reversed = effective.filter(
    (outcome) => outcome.status === "reversed" || outcome.status === "reconciled",
  );
  if (reversed.length === 0) {
    if (effective.length === 0) throw new FileEditRefusedError(refused.map(({ denial }) => denial));
    return first;
  }
  const whole = reversed.length === effective.length && refused.length === 0;
  const status = !whole
    ? "partial"
    : reversed.some((outcome) => outcome.status === "reconciled")
      ? "reconciled"
      : "reversed";
  const results = effective.map((outcome) => outcome.result);
  const messages = results.flatMap((result) => (result.message ? [result.message] : []));
  const blocks = results.flatMap((result) => result.blocks ?? []);
  const writes = reversed
    .flatMap((outcome) => outcome.result.reversal?.writes ?? [])
    .sort((left, right) => (parseWriteHandle(left) ?? 0) - (parseWriteHandle(right) ?? 0));
  return {
    ...first,
    status,
    isError: isWriteErrorStatus(status),
    result: {
      ...first.result,
      status,
      reversal: { direction, writes },
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
    },
    ...(refused.length > 0 ? { refusedWrites: refused } : {}),
  } as RoutedWriteOutcome;
}

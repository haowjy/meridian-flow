import type { Turn } from "@meridian/contracts/protocol";
import { compareSeq } from "@meridian/contracts/protocol";
import { retryTargetOf } from "@meridian/contracts/threads";
import type { RunStateView } from "./run-state-view";

export type RetryEntry = {
  id: string;
  from: string;
  executionId: string | null;
  answerVersion: string | null;
};

function reservationEnded(
  view: RunStateView,
  entry: { executionId: string | null; answerVersion: string },
): boolean {
  const record = view.record;
  if (!record || compareSeq(record.version, entry.answerVersion) < 0) return false;
  return record.execution === null || record.execution.executionId !== entry.executionId;
}

export type RetryReconciliation<E extends RetryEntry> = {
  remaining: readonly E[];
  standIns: readonly E[];
  hidden: ReadonlySet<string>;
};

const NONE: ReadonlySet<string> = new Set();

export function reconcileRetries<E extends RetryEntry>(input: {
  entries: readonly E[];
  storedTurns: readonly Turn[];
  view: RunStateView;
  supersedes: boolean;
}): RetryReconciliation<E> {
  const { entries, storedTurns, view, supersedes } = input;
  const stored = new Set(storedTurns.map((turn) => turn.id));
  const named = new Set<string>();
  for (const turn of storedTurns) {
    const target = retryTargetOf(turn);
    if (target !== null) named.add(target);
  }
  const settled = (entry: E) =>
    stored.has(entry.id)
      ? !supersedes || named.has(entry.from)
      : entry.answerVersion !== null &&
        reservationEnded(view, { ...entry, answerVersion: entry.answerVersion });
  const remaining = entries.filter((entry) => !settled(entry));
  return {
    remaining: remaining.length === entries.length ? entries : remaining,
    standIns: remaining.filter((entry) => !stored.has(entry.id)),
    hidden: supersedes && remaining.length ? new Set(remaining.map((entry) => entry.from)) : NONE,
  };
}

/**
 * Retry's retirement, decided once. A Retry that writes a new turn is an entry the client holds
 * from the press until the turn exists, the reservation ended without one, or the stored turns
 * say the Retry is shown. `reconcileRetries` takes the entries, the stored turns and the run-state
 * view and returns which entries remain, which of those stand in as turns, and which failed
 * replies the transcript leaves out for them. The app keeps transport and storage only.
 *
 * The separate `hidden` set exists because a stored turn can carry `metadata.retryOf` without
 * being the Retry's reply: the Retry's first reserved turn carries it, and that can be a
 * compaction or switch turn ahead of the reply. The failed reply stays out of view from the
 * press until a stored turn names it, even when the reply itself is already stored.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { compareSeq } from "@meridian/contracts/protocol";
import type { RunStateView } from "./run-state-view";

/** What a Retry entry is known by: its turn id, the failed reply it retries, and its answer. */
export type RetryEntry = {
  /** The Retry's new turn: its stand-in, then the server's turn by the same id. */
  id: string;
  /** The failed reply the writer pressed Retry on. */
  from: string;
  /** The execution the server answered with; null until it does (or for a request holding none). */
  executionId: string | null;
  /** The version of the record the answer carried; null until it answers (or for none). */
  answerVersion: string | null;
};

/** The failed reply a turn is the Retry of, from its `metadata.retryOf` (a stored turn's or a stand-in's). */
export function retryTargetOf(turn: Turn): string | null {
  const { metadata } = turn;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const target = (metadata as { retryOf?: unknown }).retryOf;
  return typeof target === "string" ? target : null;
}

/**
 * Whether the held record, at or after the Retry answer's version, shows an execution other than
 * the Retry's, or none: its reservation ended, and no reply will come from it.
 */
function reservationEnded(
  view: RunStateView,
  entry: { executionId: string | null; answerVersion: string },
): boolean {
  const record = view.record;
  if (!record || compareSeq(record.version, entry.answerVersion) < 0) return false;
  return record.execution === null || record.execution.executionId !== entry.executionId;
}

export type RetryReconciliation<E extends RetryEntry> = {
  /** The entries still held: those not yet settled. The same array when none settled. */
  remaining: readonly E[];
  /** The remaining entries the store does not have by id: drawn as stand-ins. */
  standIns: readonly E[];
  /** Failed replies the transcript leaves out for a remaining Retry; empty unless `supersedes`. */
  hidden: ReadonlySet<string>;
};

const NONE: ReadonlySet<string> = new Set();

/**
 * `supersedes`: the Retry replaces the reply it retries (a failed reply's Retry; not a handoff
 * brief's). Then a stored turn settles an entry only once some stored turn names its target,
 * and until then the target stays hidden and the entry is only that, once the store has its turn.
 */
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

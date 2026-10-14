/**
 * The run-state view: the server's latest record of a chat, and this device's
 * intents that the record does not yet cover.
 *
 * A record is a server fact stamped with a `version` (an event seq). Everything the
 * server says about a chat's run state, whether it arrives in a snapshot, a socket frame
 * or an HTTP answer, is received as a record, and versions are compared with
 * `compareSeq` and nothing else. An intent is something the writer did that the server
 * has not shown yet. This module owns the one rule for newness and retirement:
 *
 * - a record replaces the current one only if it is newer;
 * - an intent with an answer leaves once the record's version is at or after its answer;
 * - an intent with no answer leaves only by `dropIntent`;
 * - an answer is kept beside the intents (`answers`), so one that arrives before its intent,
 *   or an intent that a journal rebuild adds again after it left, still meets its answer.
 *
 * Folds (`fold-switches.ts`, `fold-messages.ts`) are pure selectors over the view and decide nothing about
 * either. This directory imports only `@meridian/contracts`.
 */
import { compareSeq } from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";

export type RunStateIntent =
  /** An admitted writer message. `id` is the user turn id; `answer` is the admission's `runStateVersion`. */
  | { kind: "message"; id: string; answer: string }
  /**
   * A hand-back request (Stop, the x, Cancel queue). `id` is its requestId. `candidates` are the
   * waiting writer messages it covers, frozen at the press: it hides those and nothing else.
   */
  | {
      kind: "handBack";
      id: string;
      candidates: readonly string[];
      /** The last attempt did not succeed: the rows show again, still queued. */
      failed: boolean;
      answer: string | null;
    }
  | {
      kind: "switch";
      id: string;
      /** The local journal's per-chat order: unique and monotonic. */
      order: number;
      mode: AiWriteMode;
      /** The version of the server's answer, once it has answered. */
      answer: string | null;
      /** The last attempt did not succeed: shown with Retry, and the fold leaves it out. */
      failed?: boolean;
      /** Posted and not refused: the server may hold it, so Retry only. */
      awaitingServer?: boolean;
    }
  | {
      kind: "withdraw";
      /** The control withdrawn. */
      id: string;
      order: number;
      answer: string | null;
      /** The request failed: the row stays, with the failure on it. */
      failed?: boolean;
    };

export type RunStateView = {
  /** The newest record of the chat any carrier delivered, or null before the first. */
  readonly record: RunState | null;
  readonly intents: readonly RunStateIntent[];
  /**
   * Answer evidence by `${kind}:${id}`. It outlives the intent, so a source that adds the
   * intent again (the journal re-adds every unstamped entry on each rebuild) cannot erase it.
   */
  readonly answers: ReadonlyMap<string, string>;
};

export const INITIAL_RUN_STATE_VIEW: RunStateView = {
  record: null,
  intents: [],
  answers: new Map(),
};

const same = (a: RunStateIntent, kind: RunStateIntent["kind"], id: string) =>
  a.kind === kind && a.id === id;
const answerKey = (kind: RunStateIntent["kind"], id: string) => `${kind}:${id}`;

const covered = (record: RunState | null, answer: string | null) =>
  answer !== null && record !== null && compareSeq(record.version, answer) >= 0;

/** The later of two answers. */
const later = (a: string | null | undefined, b: string | null | undefined) =>
  a == null ? (b ?? null) : b == null ? a : compareSeq(a, b) >= 0 ? a : b;

/**
 * Record an answer, keeping the later of two. Evidence is never evicted: the view is per chat,
 * so it stays small, and dropping an old answer would let the journal rebuild bring its intent back.
 */
function withAnswer(
  answers: ReadonlyMap<string, string>,
  kind: RunStateIntent["kind"],
  id: string,
  version: string,
): ReadonlyMap<string, string> {
  const key = answerKey(kind, id);
  const held = answers.get(key);
  if (held !== undefined && compareSeq(held, version) >= 0) return answers;
  return new Map(answers).set(key, version);
}

/**
 * Covered intents leave. A switch keeps its answer, because the journal can add that intent
 * again; `message` and `withdraw` intents come from one call and take their answer with them.
 */
function retire(view: RunStateView): RunStateView {
  const gone = view.intents.filter((intent) => covered(view.record, intent.answer));
  if (gone.length === 0) return view;
  const answers = new Map(view.answers);
  for (const intent of gone)
    if (intent.kind !== "switch") answers.delete(answerKey(intent.kind, intent.id));
  return {
    ...view,
    intents: view.intents.filter((intent) => !gone.includes(intent)),
    answers,
  };
}

/** Take a server record: it replaces the current one only if newer, then covered intents leave. */
export function receiveRecord(view: RunStateView, record: RunState): RunStateView {
  const current = view.record;
  if (current && compareSeq(record.version, current.version) <= 0) return view;
  return retire({ ...view, record });
}

/**
 * Add an intent, or replace the same one. Its answer is the latest of its own, the held
 * intent's and the evidence for it. An intent the record already covers is not kept.
 */
export function addIntent(view: RunStateView, intent: RunStateIntent): RunStateView {
  const existing = view.intents.find((known) => same(known, intent.kind, intent.id));
  const answer = later(
    later(intent.answer, existing?.answer),
    view.answers.get(answerKey(intent.kind, intent.id)),
  );
  // An answer a switch brings is evidence too: a later rebuild adds the bare intent again.
  const answers =
    answer !== null && intent.kind === "switch"
      ? withAnswer(view.answers, intent.kind, intent.id, answer)
      : view.answers;
  const others = view.intents.filter((known) => known !== existing);
  if (covered(view.record, answer)) return { ...view, intents: others, answers };
  const next = { ...intent, answer } as RunStateIntent;
  return {
    ...view,
    answers,
    intents: existing
      ? view.intents.map((known) => (known === existing ? next : known))
      : [...view.intents, next],
  };
}

/**
 * Record the server's answer for an intent, even before the intent exists, then stamp the
 * intent if it does and retire it if the record already covers it.
 */
export function answerIntent(
  view: RunStateView,
  kind: RunStateIntent["kind"],
  id: string,
  version: string,
): RunStateView {
  const answers = withAnswer(view.answers, kind, id, version);
  const existing = view.intents.find((known) => same(known, kind, id));
  const answered = existing
    ? view.intents.map((known) =>
        known === existing ? { ...known, answer: later(known.answer, version) } : known,
      )
    : view.intents;
  return retire({ ...view, answers, intents: answered as readonly RunStateIntent[] });
}

/** Remove an intent the server will never answer, and its evidence: a refusal, a failed request, a local cancel. */
export function dropIntent(
  view: RunStateView,
  kind: RunStateIntent["kind"],
  id: string,
): RunStateView {
  const intents = view.intents.filter((known) => !same(known, kind, id));
  const key = answerKey(kind, id);
  if (intents.length === view.intents.length && !view.answers.has(key)) return view;
  const answers = new Map(view.answers);
  answers.delete(key);
  return { ...view, intents, answers };
}

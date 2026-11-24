import { compareSeq } from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { FailedCommand, Occurrence } from "../commands";

export type RunStateIntent =
  | { kind: "message"; id: string; answer: string }
  | {
      kind: "handBack";
      id: string;
      candidates: readonly string[];
      failed: boolean;
      answer: string | null;
    }
  | ({
      kind: "switch";
      id: string;
      order: number;
      mode: AiWriteMode;
      answer: string | null;
      awaitingServer?: boolean;
    } & FailedCommand)
  | {
      kind: "withdraw";
      id: string;
      order: number;
      answer: string | null;
      failed?: boolean;
      occurrence: Occurrence;
    };

export type RunStateView = {
  readonly record: RunState | null;
  readonly intents: readonly RunStateIntent[];
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

const later = (a: string | null | undefined, b: string | null | undefined) =>
  a == null ? (b ?? null) : b == null ? a : compareSeq(a, b) >= 0 ? a : b;

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

export function receiveRecord(view: RunStateView, record: RunState): RunStateView {
  const current = view.record;
  if (current && compareSeq(record.version, current.version) <= 0) return view;
  return retire({ ...view, record });
}

export function addIntent(view: RunStateView, intent: RunStateIntent): RunStateView {
  const existing = view.intents.find((known) => same(known, intent.kind, intent.id));
  const answer = later(
    later(intent.answer, existing?.answer),
    view.answers.get(answerKey(intent.kind, intent.id)),
  );
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

export function failIntent(view: RunStateView, id: string): RunStateView {
  const held = view.intents.find((known) => same(known, "handBack", id));
  if (held?.kind !== "handBack" || held.failed) return view;
  return {
    ...view,
    intents: view.intents.map((known) => (known === held ? { ...held, failed: true } : known)),
  };
}

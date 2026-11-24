import { compareSeq } from "@meridian/contracts/protocol";
import type { ControlBody, PendingInboxItem, RunState } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { type FailedCommand, nextOccurrence } from "../commands";
import { switchState } from "./fold-switches";
import {
  addIntent,
  answerIntent,
  dropIntent,
  failIntent,
  INITIAL_RUN_STATE_VIEW,
  type RunStateIntent,
  type RunStateView,
  receiveRecord,
} from "./run-state-view";

export type JournalSwitch = {
  id: string;
  mode: AiWriteMode;
  seq: number;
  posted: boolean;
  refused: boolean;
  answer: { runState: RunState; at: number } | null;
} & FailedCommand;

export const isWriteModeControl = (item: PendingInboxItem) =>
  item.intent === "control" && item.control?.kind === "write_mode";

export function queuedSwitchKey(record: Pick<RunState, "items">): string {
  return record.items
    .filter(isWriteModeControl)
    .map((item) => item.id)
    .join(",");
}

export function switchDisplay(view: RunStateView, base: AiWriteMode) {
  return (
    switchState(view) ??
    switchState({
      ...view,
      record: {
        version: "0",
        items: [],
        sentThrough: 0,
        execution: null,
        mode: base,
        blocked: null,
      },
    }) ?? { mode: base, rows: [] }
  );
}

export type QueuedNews = {
  n: number;
  id: string;
  control: Extract<ControlBody, { kind: "write_mode" }>;
  waiting: boolean;
};

export type AppliedNews = { n: number; turnId: string; controlId: string; mode: AiWriteMode };

export type RunStateSlice = {
  view: RunStateView;
  heard: ReadonlySet<string>;
  news: readonly QueuedNews[];
  seed: string | null;
  appliedHeard: ReadonlySet<string>;
  applied: readonly AppliedNews[];
  spoken: { queued: number; applied: number };
  history: string | null;
};
export const INITIAL_RUN_STATE_SLICE: RunStateSlice = {
  view: INITIAL_RUN_STATE_VIEW,
  heard: new Set(),
  news: [],
  seed: null,
  appliedHeard: new Set(),
  applied: [],
  spoken: { queued: 0, applied: 0 },
  history: null,
};

export type RunStateAction =
  | { type: "snapshot"; runState: RunState }
  | { type: "history"; runState: RunState }
  | { type: "record"; runState: RunState }
  | { type: "switched"; seq: string; controlId: string; turnId: string; mode: AiWriteMode }
  | { type: "intent"; intent: RunStateIntent }
  | { type: "answer"; kind: RunStateIntent["kind"]; id: string; version: string }
  | { type: "drop"; kind: RunStateIntent["kind"]; id: string }
  | { type: "failHandBack"; id: string }
  | { type: "journal"; switches: readonly JournalSwitch[] }
  | { type: "spoken"; queued: number; applied: number }
  | { type: "withdraw"; id: string; requestId: string; failed?: boolean }
  | { type: "withdrawn"; id: string; runState: RunState }
  | { type: "dropWithdraw"; id: string };

export function reduceRunState(state: RunStateSlice, action: RunStateAction): RunStateSlice {
  const next = reduceSlice(state, action);
  if (action.type !== "history") return next;
  const { version } = action.runState;
  return next.history !== null && compareSeq(version, next.history) <= 0
    ? next
    : { ...next, history: version };
}

function reduceSlice(state: RunStateSlice, action: RunStateAction): RunStateSlice {
  if (action.type === "spoken") {
    const queued = Math.max(state.spoken.queued, action.queued);
    const applied = Math.max(state.spoken.applied, action.applied);
    return queued === state.spoken.queued && applied === state.spoken.applied
      ? state
      : { ...state, spoken: { queued, applied } };
  }
  const view = reduceView(state.view, action);
  const record = view.record;
  const seeded =
    state.seed === null && record !== null ? { ...state, seed: record.version } : state;
  const withApplied = action.type === "switched" ? appliedBy(seeded, action) : seeded;
  if (!record || record === state.view.record)
    return view === state.view ? withApplied : { ...withApplied, view };
  const live =
    state.view.record !== null && (action.type === "journal" || action.type === "record");
  const heard = new Set(withApplied.heard);
  const news = [...withApplied.news];
  for (const item of record.items) {
    if (!isWriteModeControl(item) || item.control?.kind !== "write_mode") continue;
    if (heard.has(item.id)) continue;
    heard.add(item.id);
    if (live)
      news.push({
        n: news.length + 1,
        id: item.id,
        control: item.control,
        waiting: item.deliveryState === "waiting",
      });
  }
  return { ...withApplied, view, heard, news };
}

function appliedBy(
  state: RunStateSlice,
  action: Extract<RunStateAction, { type: "switched" }>,
): RunStateSlice {
  if (state.seed === null || compareSeq(action.seq, state.seed) <= 0) return state;
  if (state.appliedHeard.has(action.turnId)) return state;
  return {
    ...state,
    appliedHeard: new Set(state.appliedHeard).add(action.turnId),
    applied: [
      ...state.applied,
      {
        n: state.applied.length + 1,
        turnId: action.turnId,
        controlId: action.controlId,
        mode: action.mode,
      },
    ],
  };
}

function reduceView(view: RunStateView, action: RunStateAction): RunStateView {
  switch (action.type) {
    case "intent":
      return addIntent(view, action.intent);
    case "answer":
      return answerIntent(view, action.kind, action.id, action.version);
    case "drop":
      return dropIntent(view, action.kind, action.id);
    case "failHandBack":
      return failIntent(view, action.id);
    case "snapshot":
    case "history":
    case "record":
      return receiveRecord(view, action.runState);
    case "switched":
      return answerIntent(view, "switch", action.controlId, action.seq);
    case "journal": {
      let next = view;
      const held = new Set(action.switches.map((entry) => entry.id));
      for (const entry of action.switches) {
        if (entry.answer) {
          if (next.record) next = receiveRecord(next, entry.answer.runState);
          else if (
            !next.intents.some((known) => known.kind === "switch" && known.id === entry.id)
          ) {
            next = answerIntent(next, "switch", entry.id, entry.answer.runState.version);
            continue;
          }
        }
        next = addIntent(next, {
          kind: "switch",
          id: entry.id,
          order: entry.seq,
          mode: entry.mode,
          answer: entry.answer?.runState.version ?? null,
          awaitingServer: !entry.answer && entry.posted && !entry.refused,
          ...(!entry.answer && entry.failed
            ? { failed: true as const, failure: entry.failure }
            : { failed: false as const }),
        });
      }
      for (const intent of next.intents)
        if (intent.kind === "switch" && !held.has(intent.id))
          next = dropIntent(next, "switch", intent.id);
      return next;
    }
    case "withdraw": {
      const held = view.intents.find(
        (intent) => intent.kind === "withdraw" && intent.id === action.id,
      );
      const before =
        held?.kind === "withdraw" ? held.occurrence : { requestId: action.requestId, attempt: 0 };
      return addIntent(view, {
        kind: "withdraw",
        id: action.id,
        order: 0,
        answer: null,
        failed: action.failed,
        occurrence: action.failed ? before : nextOccurrence(before.attempt, action.requestId),
      });
    }
    case "withdrawn":
      return answerIntent(
        receiveRecord(view, action.runState),
        "withdraw",
        action.id,
        action.runState.version,
      );
    case "dropWithdraw":
      return dropIntent(view, "withdraw", action.id);
    case "spoken":
      return view;
  }
}

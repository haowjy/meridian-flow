/**
 * The chat's run-state slice and the one reducer every fact about the chat's run state goes
 * through: the accepted snapshot, the `subscribed` state, `meridian.run_state` frames, answers,
 * the journal's switches (stamped once answered), and this device's intents (admitted messages,
 * switches, Withdraws, hand-backs). The thread store holds one slice per chat; the mounted
 * subscriber, the composer, the queued tray, Stop, the transcript and the switch hook all read
 * it, and the display table test drives this reducer, so the table exercises the production
 * ingestion path.
 *
 * Every server fact is a whole `RunState`, so a frame before the snapshot is simply the first
 * record: nothing is buffered, and `run-state-view.ts` alone decides what is newer. A
 * `write_mode.switched` frame is not a record but the server's answer for its control's intent.
 *
 * It also classifies announcement eligibility where a record is taken, because only the carrier
 * says whether a queued switch is news: a live record frame or a journal stamp, taken after the
 * first record, announces each queued switch once. The first record, a snapshot (however much
 * newer) and the frames replayed after the first record stay silent. The same holds for an
 * applied switch: a `switched` frame at or below the first record's version is not news.
 */
import { compareSeq } from "@meridian/contracts/protocol";
import type { ControlBody, PendingInboxItem, RunState } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import {
  addIntent,
  answerIntent,
  dropIntent,
  failIntent,
  INITIAL_RUN_STATE_VIEW,
  type RunStateIntent,
  type RunStateView,
  receiveRecord,
  switchState,
} from "@meridian/thread-client";
import type { JournalSwitch } from "@/client/chat-submissions/owner";

export const isWriteModeControl = (item: PendingInboxItem) =>
  item.intent === "control" && item.control?.kind === "write_mode";

/** The ids of the record's write-mode switches, as one comparable key; "" when none is pending. */
export function queuedSwitchKey(record: Pick<RunState, "items">): string {
  return record.items
    .filter(isWriteModeControl)
    .map((item) => item.id)
    .join(",");
}

/**
 * What the toolbar and rows show. Before the first record the chat's own mode (`base`, the
 * thread row's) stands in as the applied one, so a choice made before the snapshot still
 * shows at once.
 */
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

/** A queued write-mode switch the writer should hear about; `n` counts them, from 1. */
export type QueuedNews = {
  n: number;
  id: string;
  control: Extract<ControlBody, { kind: "write_mode" }>;
  /** The server's `deliveryState`: a reply that already held the chat has to finish first. */
  waiting: boolean;
};

/** A switch applied since the first record, which the writer should hear about; `n` counts them, from 1. */
export type AppliedNews = { n: number; turnId: string; controlId: string; mode: AiWriteMode };

export type RunStateSlice = {
  view: RunStateView;
  /** The queued switches already seen, from any carrier. */
  heard: ReadonlySet<string>;
  news: readonly QueuedNews[];
  /** The first record's version: what it holds is not news, and neither is a frame at or below it. */
  seed: string | null;
  /** The applied switches already seen, by their divider's turn. */
  appliedHeard: ReadonlySet<string>;
  applied: readonly AppliedNews[];
  /**
   * How much of `news` and `applied` the writer has been told, by `n`. It lives with the lists,
   * so a remounted view speaks only what no mounted view has.
   */
  spoken: { queued: number; applied: number };
  /**
   * The version of the newest accepted snapshot, whose turns reached the transcript with it:
   * proof that a control absent from those turns, and from a record at or below this version,
   * did not run.
   */
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
  /** A record that is not news: an accepted snapshot, a `subscribed` state, or an answer's. */
  | { type: "snapshot"; runState: RunState }
  /** The accepted snapshot's record, dispatched with its turns: a `snapshot` that also marks `history`. */
  | { type: "history"; runState: RunState }
  /** A `meridian.run_state` frame. */
  | { type: "record"; runState: RunState }
  /** A `meridian.write_mode.switched` frame: the server's answer for its control. */
  | { type: "switched"; seq: string; controlId: string; turnId: string; mode: AiWriteMode }
  /** This device's intent: an admitted message, or a hand-back request. */
  | { type: "intent"; intent: RunStateIntent }
  | { type: "answer"; kind: RunStateIntent["kind"]; id: string; version: string }
  | { type: "drop"; kind: RunStateIntent["kind"]; id: string }
  /** The last attempt at a hand-back request did not succeed: its rows show again. */
  | { type: "failHandBack"; id: string }
  | { type: "journal"; switches: readonly JournalSwitch[] }
  /** The view told the writer of the news through these counts. */
  | { type: "spoken"; queued: number; applied: number }
  | { type: "withdraw"; id: string; failed?: boolean }
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

/** A switched frame past the first record, whose divider the writer has not been told about. */
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
          // A stamp is the server's answer, read as a fact by every tab. Without a snapshot
          // it is evidence for its intent, never a record, and a stamp left over from before
          // a reload makes no row.
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
          ...(entry.answer
            ? {}
            : {
                failed: entry.failed,
                failure: entry.failure,
                awaitingServer: entry.posted && !entry.refused,
              }),
        });
      }
      // An entry that left the journal was withdrawn or refused here, or pruned while this
      // tab was blind: its intent and evidence go, and frames bring the server state.
      for (const intent of next.intents)
        if (intent.kind === "switch" && !held.has(intent.id))
          next = dropIntent(next, "switch", intent.id);
      return next;
    }
    case "withdraw": {
      const held = view.intents.find(
        (intent) => intent.kind === "withdraw" && intent.id === action.id,
      );
      const attempt = held?.kind === "withdraw" ? (held.failure?.attempt ?? 0) : 0;
      return addIntent(view, {
        kind: "withdraw",
        id: action.id,
        order: 0,
        answer: null,
        failed: action.failed,
        failure: {
          requestId: `withdraw:${action.id}`,
          attempt: attempt + (action.failed ? 0 : 1),
          kind: "lost",
        },
      });
    }
    case "withdrawn":
      // The answer's record, then the intent's answer at its version.
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

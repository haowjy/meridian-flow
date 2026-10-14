/**
 * The chat's switch state and the one reducer every fact about a switch goes through:
 * the accepted snapshot, socket frames, the journal's switches (stamped once answered),
 * and the writer's Withdraw. `useSwitchView` dispatches into it, and the display table
 * test drives it, so the table exercises the production ingestion path.
 *
 * It also classifies announcement eligibility where a record is taken, because only the
 * carrier says whether a queued switch is news: a live inbox frame or an answer, taken
 * after the first record, announces each queued switch once. The first record, a snapshot
 * (however much newer) and the frames replayed after the first record stay silent.
 */
import type { ControlBody } from "@meridian/contracts/threads";
import type { JournalSwitch } from "@/client/chat-submissions/owner";
import {
  addIntent,
  answerIntent,
  dropIntent,
  EMPTY_VIEW,
  type RunStateView,
  receiveRecord,
} from "@/client/run-state/run-state-view";
import {
  isWriteModeControl,
  type Received,
  receiveFrame,
  recordFromAnswer,
  recordFromSnapshot,
  type SnapshotFacts,
  type SwitchAnswerFacts,
  type SwitchFrame,
  seedFrames,
} from "./switch-record";

/** A queued write-mode switch the writer should hear about; `n` counts them, from 1. */
export type QueuedNews = {
  n: number;
  id: string;
  control: Extract<ControlBody, { kind: "write_mode" }>;
  /** The server lists it behind a reply it can't affect: the same fact the row's copy reads. */
  waiting: boolean;
};

export type SwitchState = Received & {
  /** The queued switches already seen, from any carrier. */
  heard: ReadonlySet<string>;
  news: readonly QueuedNews[];
};
export const INITIAL_SWITCH_STATE: SwitchState = {
  view: EMPTY_VIEW,
  early: [],
  heard: new Set(),
  news: [],
};

export type SwitchAction =
  | { type: "snapshot"; snapshot: SnapshotFacts }
  | { type: "frame"; frame: SwitchFrame }
  | { type: "journal"; switches: readonly JournalSwitch[] }
  | { type: "withdraw"; id: string; failed?: boolean }
  | { type: "withdrawn"; id: string; answer: SwitchAnswerFacts }
  | { type: "dropWithdraw"; id: string };

export function reduceSwitch(state: SwitchState, action: SwitchAction): SwitchState {
  const received =
    action.type === "frame"
      ? receiveFrame(state, action.frame)
      : seedFrames(reduceView(state.view, action), state.early);
  const record = received.view.record;
  if (!record || record === state.view.record) return { ...state, ...received };
  const live =
    state.view.record !== null &&
    (action.type === "journal" || (action.type === "frame" && action.frame.kind === "inbox"));
  const heard = new Set(state.heard);
  const news = [...state.news];
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
  return { ...received, heard, news };
}

function reduceView(
  view: RunStateView,
  action: Exclude<SwitchAction, { type: "frame" }>,
): RunStateView {
  switch (action.type) {
    case "snapshot":
      return receiveRecord(view, recordFromSnapshot(action.snapshot));
    case "journal": {
      let next = view;
      const held = new Set(action.switches.map((entry) => entry.id));
      for (const entry of action.switches) {
        if (entry.answer) {
          // A stamp is the server's answer, read as a fact by every tab. Without a snapshot
          // it has nothing to extend: it is evidence for its intent, never a record, and a
          // stamp left over from before a reload makes no row.
          if (next.record) next = receiveRecord(next, recordFromAnswer(next.record, entry.answer));
          else if (
            !next.intents.some((known) => known.kind === "switch" && known.id === entry.id)
          ) {
            next = answerIntent(next, "switch", entry.id, entry.answer.seq);
            continue;
          }
        }
        next = addIntent(next, {
          kind: "switch",
          id: entry.id,
          order: entry.seq,
          mode: entry.mode,
          answer: entry.answer?.seq ?? null,
          ...(entry.answer
            ? {}
            : { failed: entry.failed, awaitingServer: entry.posted && !entry.refused }),
        });
      }
      // An entry that left the journal was withdrawn or refused here, or pruned while this
      // tab was blind: its intent and evidence go, and frames bring the server state.
      for (const intent of next.intents)
        if (intent.kind === "switch" && !held.has(intent.id))
          next = dropIntent(next, "switch", intent.id);
      return next;
    }
    case "withdraw":
      return addIntent(view, {
        kind: "withdraw",
        id: action.id,
        order: 0,
        answer: null,
        failed: action.failed,
      });
    case "withdrawn":
      // Like the enqueue answer: the server's facts at its head, then the intent's answer.
      return answerIntent(
        view.record ? receiveRecord(view, recordFromAnswer(view.record, action.answer)) : view,
        "withdraw",
        action.id,
        action.answer.seq,
      );
    case "dropWithdraw":
      return dropIntent(view, "withdraw", action.id);
  }
}

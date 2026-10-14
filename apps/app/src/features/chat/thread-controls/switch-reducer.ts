/**
 * The chat's switch state and the one reducer every fact about a switch goes through:
 * the accepted snapshot, `meridian.run_state` frames, the journal's switches (stamped once
 * answered), and the writer's Withdraw. `useSwitchView` dispatches into it, and the display
 * table test drives it, so the table exercises the production ingestion path.
 *
 * Every server fact is a whole `RunState`, so a frame before the snapshot is simply the first
 * record: nothing is buffered, and `run-state-view.ts` alone decides what is newer. A
 * `write_mode.switched` frame is not a record but the server's answer for its control's
 * intent.
 *
 * It also classifies announcement eligibility where a record is taken, because only the
 * carrier says whether a queued switch is news: a live record frame or a journal stamp, taken
 * after the first record, announces each queued switch once. The first record, a snapshot
 * (however much newer) and the frames replayed after the first record stay silent.
 */
import type { ControlBody, PendingInboxItem, RunState } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import {
  addIntent,
  answerIntent,
  dropIntent,
  INITIAL_RUN_STATE_VIEW,
  type RunStateView,
  receiveRecord,
  switchState,
} from "@meridian/thread-client";
import type { JournalSwitch } from "@/client/chat-submissions/owner";

export const isWriteModeControl = (item: PendingInboxItem) =>
  item.intent === "control" && item.control?.kind === "write_mode";

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
};

export type SwitchState = {
  view: RunStateView;
  /** The queued switches already seen, from any carrier. */
  heard: ReadonlySet<string>;
  news: readonly QueuedNews[];
};
export const INITIAL_SWITCH_STATE: SwitchState = {
  view: INITIAL_RUN_STATE_VIEW,
  heard: new Set(),
  news: [],
};

export type SwitchAction =
  | { type: "snapshot"; runState: RunState }
  /** A `meridian.run_state` frame. */
  | { type: "record"; runState: RunState }
  /** A `meridian.write_mode.switched` frame: the server's answer for its control. */
  | { type: "switched"; seq: string; controlId: string }
  | { type: "journal"; switches: readonly JournalSwitch[] }
  | { type: "withdraw"; id: string; failed?: boolean }
  | { type: "withdrawn"; id: string; runState: RunState }
  | { type: "dropWithdraw"; id: string };

export function reduceSwitch(state: SwitchState, action: SwitchAction): SwitchState {
  const view = reduceView(state.view, action);
  const record = view.record;
  if (!record || record === state.view.record)
    return view === state.view ? state : { ...state, view };
  const live =
    state.view.record !== null && (action.type === "journal" || action.type === "record");
  const heard = new Set(state.heard);
  const news = [...state.news];
  for (const item of record.items) {
    if (!isWriteModeControl(item) || item.control?.kind !== "write_mode") continue;
    if (heard.has(item.id)) continue;
    heard.add(item.id);
    if (live) news.push({ n: news.length + 1, id: item.id, control: item.control });
  }
  return { view, heard, news };
}

function reduceView(view: RunStateView, action: SwitchAction): RunStateView {
  switch (action.type) {
    case "snapshot":
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
      // The answer's record, then the intent's answer at its version.
      return answerIntent(
        receiveRecord(view, action.runState),
        "withdraw",
        action.id,
        action.runState.version,
      );
    case "dropWithdraw":
      return dropIntent(view, "withdraw", action.id);
  }
}

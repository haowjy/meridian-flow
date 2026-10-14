/**
 * The chat's switch state and the one reducer every fact about a switch goes through:
 * the accepted snapshot, socket frames, the journal's switches (stamped once answered),
 * and the writer's Withdraw. `useSwitchView` dispatches into it, and the display table
 * test drives it, so the table exercises the production ingestion path.
 */
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
  type Received,
  receiveFrame,
  recordFromAnswer,
  recordFromSnapshot,
  type SnapshotFacts,
  type SwitchAnswerFacts,
  type SwitchFrame,
  seedFrames,
} from "./switch-record";

export type SwitchState = Received;
export const INITIAL_SWITCH_STATE: SwitchState = { view: EMPTY_VIEW, early: [] };

export type SwitchAction =
  | { type: "snapshot"; snapshot: SnapshotFacts }
  | { type: "frame"; frame: SwitchFrame }
  | { type: "journal"; switches: readonly JournalSwitch[] }
  | { type: "withdraw"; id: string; failed?: boolean }
  | { type: "withdrawn"; id: string; answer: SwitchAnswerFacts }
  | { type: "dropWithdraw"; id: string };

export function reduceSwitch(state: SwitchState, action: SwitchAction): SwitchState {
  if (action.type === "frame") return receiveFrame(state, action.frame);
  return seedFrames(reduceView(state.view, action), state.early);
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
        // A stamp is the server's answer, read as a fact by every tab.
        if (entry.answer) {
          next = receiveRecord(next, recordFromAnswer(next.record, entry.answer));
          next = answerIntent(
            addIntent(next, {
              kind: "switch",
              id: entry.id,
              order: entry.seq,
              mode: entry.mode,
              answer: null,
            }),
            "switch",
            entry.id,
            entry.answer.seq,
          );
        } else {
          next = addIntent(next, {
            kind: "switch",
            id: entry.id,
            order: entry.seq,
            mode: entry.mode,
            answer: null,
            failed: entry.failed,
            awaitingServer: entry.posted && !entry.refused,
          });
        }
      }
      // A record that vanished unstamped was withdrawn or refused here, or its stamp was
      // pruned while this tab was blind: either way frames bring the server state.
      for (const intent of next.intents)
        if (intent.kind === "switch" && intent.answer === null && !held.has(intent.id))
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
        receiveRecord(view, recordFromAnswer(view.record, action.answer)),
        "withdraw",
        action.id,
        action.answer.seq,
      );
    case "dropWithdraw":
      return dropIntent(view, "withdraw", action.id);
  }
}

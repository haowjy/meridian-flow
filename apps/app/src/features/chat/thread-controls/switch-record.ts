/**
 * Composes the run-state view's records from the facts that exist today.
 *
 * The server does not yet send a run-state record, so the chat's subscriber builds one
 * from the seq-stamped facts it does send. Each is sound because only switch transitions
 * change the applied mode or the queued switch, and frames on one subscription arrive in
 * seq order:
 *
 * - a snapshot is `{ head, thread.aiWriteMode, liveState.pending }`, read in one transaction;
 * - an `inbox.changed` frame at K is `{ ...current, version: K, items }`;
 * - a `write_mode.switched` frame at K is `{ ...current, version: K, mode }` without the row
 *   of the control it applied, because the apply removed that row in the same transaction;
 * - a switch answer is its `seq`, `mode` and `pending`, over the current record's items
 *   with every write-mode control row replaced by that `pending`.
 *
 * A frame before the first record is held and applied, in order, once there is one.
 * `subscribed` is never a source: its head is read outside the pending read's transaction.
 */
import { headSeq } from "@meridian/contracts/protocol";
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import {
  answerIntent,
  type RunStateRecord,
  type RunStateView,
  receiveRecord,
} from "@/client/run-state/run-state-view";

export const isWriteModeControl = (item: PendingInboxItem) =>
  item.intent === "control" && item.control?.kind === "write_mode";

/** The facts of an accepted snapshot that make a record. */
export type SnapshotFacts = {
  nextSeq: string;
  thread: { aiWriteMode: AiWriteMode };
  liveState: { pending?: ThreadPendingInbox };
};

export function recordFromSnapshot(snapshot: SnapshotFacts): RunStateRecord {
  return {
    version: headSeq(snapshot.nextSeq),
    mode: snapshot.thread.aiWriteMode,
    items: snapshot.liveState.pending?.items ?? [],
  };
}

export type SwitchFrame =
  | { kind: "inbox"; seq: string; pending: ThreadPendingInbox }
  | { kind: "switched"; seq: string; mode: AiWriteMode; controlId: string };

export function recordFromFrame(
  current: RunStateRecord | null,
  frame: SwitchFrame,
): RunStateRecord | null {
  if (!current) return null;
  return frame.kind === "inbox"
    ? { ...current, version: frame.seq, items: frame.pending.items }
    : {
        ...current,
        version: frame.seq,
        mode: frame.mode,
        items: current.items.filter((item) => item.id !== frame.controlId),
      };
}

export type SwitchAnswerFacts = {
  seq: string;
  mode: AiWriteMode;
  pending: PendingInboxItem | null;
};

export function recordFromAnswer(
  current: RunStateRecord | null,
  answer: SwitchAnswerFacts,
): RunStateRecord {
  const others = (current?.items ?? []).filter((item) => !isWriteModeControl(item));
  return {
    version: answer.seq,
    mode: answer.mode,
    items: answer.pending ? [...others, answer.pending] : others,
  };
}

/** The view, and the frames that arrived before it had a first record. */
export type Received = { view: RunStateView; early: readonly SwitchFrame[] };

function applyFrame(view: RunStateView, frame: SwitchFrame): RunStateView {
  const record = recordFromFrame(view.record, frame);
  if (!record) return view;
  const next = receiveRecord(view, record);
  return frame.kind === "switched"
    ? answerIntent(next, "switch", frame.controlId, frame.seq)
    : next;
}

/**
 * Take a frame. A `write_mode.switched` frame is also the answer for its control's intent:
 * the apply it reports is that control's effect, at the frame's seq. Before the first
 * record the frame is held, not dropped: subscribe-then-fetch means the snapshot's head
 * can be older than frames that already arrived.
 */
export function receiveFrame(state: Received, frame: SwitchFrame): Received {
  return state.view.record
    ? { view: applyFrame(state.view, frame), early: state.early }
    : { view: state.view, early: [...state.early, frame] };
}

/** After any step that may have made the first record: apply the held frames in order. */
export function seedFrames(view: RunStateView, early: readonly SwitchFrame[]): Received {
  if (!view.record || early.length === 0) return { view, early };
  return { view: early.reduce(applyFrame, view), early: [] };
}

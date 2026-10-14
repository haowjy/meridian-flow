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
 * - a `write_mode.switched` frame at K is `{ ...current, version: K, mode }`;
 * - a switch answer is its `seq`, `mode` and `pending`, over the current record's items
 *   with every write-mode control row replaced by that `pending`.
 *
 * A frame before the first snapshot has no record to extend and is ignored. `subscribed`
 * is never a source: its head is read outside the pending read's transaction.
 */
import { headSeq } from "@meridian/contracts/protocol";
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { RunStateRecord } from "@/client/run-state/run-state-view";

export const isWriteModeControl = (item: PendingInboxItem) =>
  item.intent === "control" && item.control?.kind === "write_mode";

export function recordFromSnapshot(snapshot: {
  nextSeq: string;
  thread: { aiWriteMode: AiWriteMode };
  liveState: { pending?: ThreadPendingInbox };
}): RunStateRecord {
  return {
    version: headSeq(snapshot.nextSeq),
    mode: snapshot.thread.aiWriteMode,
    items: snapshot.liveState.pending?.items ?? [],
  };
}

export type SwitchFrame =
  | { kind: "inbox"; seq: string; pending: ThreadPendingInbox }
  | { kind: "switched"; seq: string; mode: AiWriteMode };

export function recordFromFrame(
  current: RunStateRecord | null,
  frame: SwitchFrame,
): RunStateRecord | null {
  if (!current) return null;
  return frame.kind === "inbox"
    ? { ...current, version: frame.seq, items: frame.pending.items }
    : { ...current, version: frame.seq, mode: frame.mode };
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

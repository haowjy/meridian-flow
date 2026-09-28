/**
 * Optimistic writer controls: the local half of `/compact`, compaction undo,
 * and handoff brief Retry, merged with the server's pending inbox.
 *
 * The writer sees a queued control the moment they ask for it. The server
 * inbox is the authority once it knows the id; until then the local entry
 * stands in, and a failed enqueue stays on the item with Retry (same id, so
 * the server treats a retry as a no-op). A withdrawal's outcome lands on the
 * item and stays until the transcript moves on.
 */
import type {
  ControlBody,
  PendingInboxItem,
  ThreadPendingInbox,
  WithdrawThreadControlResponse,
} from "@meridian/contracts/threads";

export type WithdrawOutcome = WithdrawThreadControlResponse["outcome"];

export type LocalControl = {
  id: string;
  control: ControlBody;
  request: "sending" | "sent" | "failed" | "finished";
  /** The server inbox has listed this id at least once. */
  seen: boolean;
  withdrawal: null | "withdrawing" | "failed" | WithdrawOutcome;
  /** Transcript leaf when the withdrawal settled; the outcome shows until it moves. */
  settledAtLeaf: string | null;
};

export type QueuedControlStatus =
  | "queued"
  | "failed"
  | "withdrawing"
  | "withdraw_failed"
  | WithdrawOutcome;

export type QueuedControl = {
  id: string;
  control: ControlBody;
  status: QueuedControlStatus;
};

export type ControlAction =
  | { type: "enqueue"; id: string; control: ControlBody }
  | { type: "retry"; id: string }
  | { type: "enqueued"; id: string; pending: PendingInboxItem | null; turnId: string | null }
  | { type: "enqueue_failed"; id: string }
  | { type: "withdraw"; id: string; control?: ControlBody }
  | { type: "withdrawn"; id: string; outcome: WithdrawOutcome; leafTurnId: string | null }
  | { type: "withdraw_failed"; id: string }
  | { type: "observe"; pendingIds: ReadonlySet<string> };

export function controlsReducer(
  state: readonly LocalControl[],
  action: ControlAction,
): readonly LocalControl[] {
  const patch = (id: string, change: Partial<LocalControl>) =>
    state.map((entry) => (entry.id === id ? { ...entry, ...change } : entry));
  switch (action.type) {
    case "enqueue":
      if (state.some((entry) => entry.id === action.id)) return state;
      return [
        ...state,
        {
          id: action.id,
          control: action.control,
          request: "sending",
          seen: false,
          withdrawal: null,
          settledAtLeaf: null,
        },
      ];
    case "retry":
      return patch(action.id, { request: "sending" });
    case "enqueued":
      // No pending row: it already ran (turn id) or was withdrawn earlier.
      return patch(action.id, { request: action.pending ? "sent" : "finished" });
    case "enqueue_failed":
      return patch(action.id, { request: "failed" });
    case "withdraw":
      if (!state.some((entry) => entry.id === action.id)) {
        if (!action.control) return state;
        // A server-only row (queued before this mount) gets a local shadow.
        return [
          ...state,
          {
            id: action.id,
            control: action.control,
            request: "sent",
            seen: true,
            withdrawal: "withdrawing",
            settledAtLeaf: null,
          },
        ];
      }
      return patch(action.id, { withdrawal: "withdrawing" });
    case "withdrawn":
      return patch(action.id, { withdrawal: action.outcome, settledAtLeaf: action.leafTurnId });
    case "withdraw_failed":
      return patch(action.id, { withdrawal: "failed" });
    case "observe": {
      let changed = false;
      const next = state.map((entry) => {
        if (entry.seen || !action.pendingIds.has(entry.id)) return entry;
        changed = true;
        return { ...entry, seen: true };
      });
      return changed ? next : state;
    }
  }
}

/**
 * The controls the writer should see: server rows first (in inbox order),
 * then local ones the server has not listed yet or has just settled.
 */
export function mergeQueuedControls(input: {
  local: readonly LocalControl[];
  pending: ThreadPendingInbox;
  /** Controls a transcript turn already names (divider or undo marker). */
  executedControlIds: ReadonlySet<string>;
  leafTurnId: string | null;
}): QueuedControl[] {
  const { local, pending, executedControlIds, leafTurnId } = input;
  const localById = new Map(local.map((entry) => [entry.id, entry]));
  const result: QueuedControl[] = [];
  const listed = new Set<string>();
  for (const item of pending.items) {
    if (item.intent !== "control" || !item.control) continue;
    listed.add(item.id);
    const withdrawal = localById.get(item.id)?.withdrawal ?? null;
    // A withdrawal response is fresher than the inbox frame that follows it.
    result.push({
      id: item.id,
      control: item.control,
      status:
        withdrawal === null ? "queued" : withdrawal === "failed" ? "withdraw_failed" : withdrawal,
    });
  }
  for (const entry of local) {
    if (listed.has(entry.id)) continue;
    const status = localStatus(entry, executedControlIds, leafTurnId);
    if (status) result.push({ id: entry.id, control: entry.control, status });
  }
  return result;
}

function localStatus(
  entry: LocalControl,
  executed: ReadonlySet<string>,
  leafTurnId: string | null,
): QueuedControlStatus | null {
  if (entry.withdrawal === "withdrawing") return "withdrawing";
  if (
    entry.withdrawal === "withdrawn" ||
    entry.withdrawal === "stopping" ||
    entry.withdrawal === "already_finished"
  ) {
    // A turn that names the control tells the rest of the story itself.
    if (executed.has(entry.id) || entry.settledAtLeaf !== leafTurnId) return null;
    return entry.withdrawal;
  }
  if (entry.request === "sending") return "queued";
  if (entry.request === "failed") return "failed";
  if (entry.request === "finished" || entry.seen || executed.has(entry.id)) return null;
  // Accepted, and the inbox echo has not arrived yet.
  return "queued";
}

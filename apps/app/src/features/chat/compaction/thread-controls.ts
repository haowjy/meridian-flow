/**
 * Optimistic writer commands: the local half of `/compact`, merged with the
 * server's pending inbox.
 *
 * Two pieces of local state, each small:
 * - `sends`: commands this tab asked for that the server inbox has not listed
 *   yet. The writer sees one the moment they ask; a failed enqueue stays on
 *   the item with Retry (same id, so the server treats a retry as a no-op).
 *   Once the inbox lists the id the server owns it, and the send is dropped.
 * - `withdrawals`: Withdraw hides a row at once, whichever side owns it, and
 *   always asks the server. A withdrawal the server confirmed (withdrawn, or
 *   already started, whose compaction divider carries the state) keeps the id
 *   hidden against stale inbox frames. A 404 only drops the local send: the
 *   enqueue may still have been committing, and if the inbox lists the id
 *   later the row shows again, queued, so it never runs unseen. A failed
 *   withdrawal brings the row back.
 *
 * A command runs only when no message waits, so every queued command renders
 * after every queued message, at the end of the queue, oldest first.
 */
import type {
  ControlBody,
  PendingInboxItem,
  ThreadPendingInbox,
} from "@meridian/contracts/threads";

export type LocalSend = {
  id: string;
  control: ControlBody;
  request: "sending" | "sent" | "failed" | "finished";
};

/** `settled`: the server confirmed it, either withdrawn or already started. */
export type Withdrawal = "withdrawing" | "failed" | "settled";

export type LocalControls = {
  sends: readonly LocalSend[];
  withdrawals: ReadonlyMap<string, Withdrawal>;
};

export const NO_LOCAL_CONTROLS: LocalControls = { sends: [], withdrawals: new Map() };

export type QueuedControlStatus = "queued" | "failed" | "withdraw_failed";

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
  | { type: "withdraw"; id: string }
  | { type: "withdrawn"; id: string }
  /** The server had no such command (404) when the withdrawal reached it. */
  | { type: "withdraw_not_found"; id: string }
  | { type: "withdraw_failed"; id: string }
  /** The server inbox lists these ids: it owns them from now on. */
  | { type: "listed"; pendingIds: ReadonlySet<string> };

export function controlsReducer(state: LocalControls, action: ControlAction): LocalControls {
  const patchSend = (id: string, request: LocalSend["request"]) => ({
    ...state,
    sends: state.sends.map((entry) => (entry.id === id ? { ...entry, request } : entry)),
  });
  const withdrawal = (id: string, next: Withdrawal) => ({
    ...state,
    withdrawals: new Map(state.withdrawals).set(id, next),
  });
  switch (action.type) {
    case "enqueue":
      if (state.sends.some((entry) => entry.id === action.id)) return state;
      return {
        ...state,
        sends: [...state.sends, { id: action.id, control: action.control, request: "sending" }],
      };
    case "retry":
      return patchSend(action.id, "sending");
    case "enqueued":
      // No pending row: it already ran (turn id) or was withdrawn earlier.
      return patchSend(action.id, action.pending ? "sent" : "finished");
    case "enqueue_failed":
      return patchSend(action.id, "failed");
    case "withdraw":
      return withdrawal(action.id, "withdrawing");
    case "withdrawn":
      return withdrawal(action.id, "settled");
    case "withdraw_failed":
      return withdrawal(action.id, "failed");
    case "withdraw_not_found": {
      const withdrawals = new Map(state.withdrawals);
      withdrawals.delete(action.id);
      return { sends: state.sends.filter((entry) => entry.id !== action.id), withdrawals };
    }
    case "listed": {
      const sends = state.sends.filter((entry) => !action.pendingIds.has(entry.id));
      return sends.length === state.sends.length ? state : { ...state, sends };
    }
  }
}

/**
 * The commands the writer should see: server rows first (in inbox order),
 * then local ones the server has not listed yet.
 */
export function mergeQueuedControls(input: {
  local: LocalControls;
  pending: ThreadPendingInbox;
  /** Commands a compaction divider already names. */
  executedControlIds: ReadonlySet<string>;
}): QueuedControl[] {
  const { local, pending, executedControlIds } = input;
  const result: QueuedControl[] = [];
  const listed = new Set<string>();
  for (const item of pending.items) {
    if (item.intent !== "control" || !item.control) continue;
    listed.add(item.id);
    // A withdrawal response is fresher than the inbox frame that follows it.
    const withdrawal = local.withdrawals.get(item.id);
    if (!withdrawal) result.push({ id: item.id, control: item.control, status: "queued" });
    else if (withdrawal === "failed") {
      result.push({ id: item.id, control: item.control, status: "withdraw_failed" });
    }
  }
  for (const entry of local.sends) {
    const withdrawal = local.withdrawals.get(entry.id);
    if (listed.has(entry.id) || (withdrawal && withdrawal !== "failed")) continue;
    const status = requestStatus(entry, executedControlIds);
    if (!status) continue;
    result.push({
      id: entry.id,
      control: entry.control,
      status: withdrawal && status === "queued" ? "withdraw_failed" : status,
    });
  }
  return result;
}

function requestStatus(
  entry: LocalSend,
  executed: ReadonlySet<string>,
): QueuedControlStatus | null {
  if (entry.request === "sending") return "queued";
  if (entry.request === "failed") return "failed";
  if (entry.request === "finished" || executed.has(entry.id)) return null;
  // Accepted, and the inbox echo has not arrived yet.
  return "queued";
}

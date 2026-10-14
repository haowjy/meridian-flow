/**
 * Optimistic writer commands: the local half of `/compact`, merged with the
 * record's waiting items. (A write-mode switch is the switch ledger's.)
 *
 * Local state, each piece small:
 * - `sends`: commands this tab asked for that the server inbox has not listed
 *   yet. The writer sees one the moment they ask; a failed enqueue stays on
 *   the item with Retry (same id, so the server treats a retry as a no-op).
 *   Once the inbox lists the id the server owns it, and the send is dropped.
 * - `withdrawals`: Withdraw hides a row at once, whichever side owns it, and
 *   always asks the server. A withdrawal the server confirmed (withdrawn, or
 *   already started, whose divider carries the state) keeps the id
 *   hidden against stale inbox frames. A 404 only drops the local send: the
 *   enqueue may still have been committing, and if the inbox lists the id
 *   later the row shows again, queued, so it never runs unseen. A failed
 *   withdrawal brings the row back.
 *
 * A command runs only when no message waits, so every queued command renders
 * after every queued message, at the end of the queue, oldest first.
 */
import { compareSeq } from "@meridian/contracts/protocol";
import type { ControlBody, PendingInboxItem } from "@meridian/contracts/threads";

export type CompactControl = Extract<ControlBody, { kind: "compact" }>;

export type LocalSend = {
  id: string;
  control: CompactControl;
  request: "sending" | "sent" | "failed" | "finished";
};

/** `settled`: the server confirmed it, either withdrawn or already started. */
export type Withdrawal = "withdrawing" | "failed" | "settled";

export type LocalControls = {
  sends: readonly LocalSend[];
  withdrawals: ReadonlyMap<string, Withdrawal>;
};

export const NO_LOCAL_CONTROLS: LocalControls = { sends: [], withdrawals: new Map() };

/** `sending`: the writer asked and the server has not answered. */
export type QueuedControlStatus = "sending" | "queued" | "failed" | "withdraw_failed";

export type QueuedControl = {
  id: string;
  control: ControlBody;
  status: QueuedControlStatus;
  /** A switch the server may hold and hasn't answered: Retry only, no local Withdraw. */
  awaitingServer?: boolean;
  /** A switch the record says applies at the next run's start: its notice sits before that run's reply. */
  awaitsRun?: boolean;
  /**
   * The server will not apply the switch at the next run's start: a reply that already held
   * the chat when it was made has to finish first (its `deliveryState` is `waiting`). Only the
   * words depend on it.
   */
  waiting?: boolean;
};

export type ControlAction =
  | { type: "enqueue"; id: string; control: CompactControl }
  | { type: "retry"; id: string }
  /** The server took the command; `sent` when the record lists it, else it already ran or was withdrawn. */
  | { type: "enqueued"; id: string; sent: boolean }
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
      // Not in the record: it already ran or was withdrawn earlier.
      return patchSend(action.id, action.sent ? "sent" : "finished");
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

export type MergeInput = {
  local: LocalControls;
  /** The run-state record's items, in inbox order. */
  items: readonly PendingInboxItem[];
};

/**
 * The commands the writer should see: server rows first (in inbox order),
 * then local ones the server has not listed yet.
 */
export function mergeQueuedControls(input: MergeInput): QueuedControl[] {
  const { local, items } = input;
  const result: QueuedControl[] = [];
  const listed = new Set<string>();
  for (const item of items) {
    if (item.intent !== "control" || item.control?.kind !== "compact") continue;
    listed.add(item.id);
    // A withdrawal response is fresher than the inbox frame that follows it.
    const withdrawal = local.withdrawals.get(item.id);
    if (!withdrawal) {
      result.push({ id: item.id, control: item.control, status: "queued" });
    } else if (withdrawal === "failed") {
      result.push({ id: item.id, control: item.control, status: "withdraw_failed" });
    }
  }
  for (const entry of local.sends) {
    const withdrawal = local.withdrawals.get(entry.id);
    if (listed.has(entry.id) || (withdrawal && withdrawal !== "failed")) continue;
    const status = requestStatus(entry);
    if (!status) continue;
    result.push({
      id: entry.id,
      control: entry.control,
      status: withdrawal && status !== "failed" ? "withdraw_failed" : status,
    });
  }
  return result;
}

function requestStatus(entry: LocalSend): QueuedControlStatus | null {
  if (entry.request === "sending") return "sending";
  if (entry.request === "failed") return "failed";
  if (entry.request === "finished") return null;
  // Accepted, and the inbox echo has not arrived yet.
  return "queued";
}

/** A row last seen, and the record version at which its sources first stopped showing it. */
export type HeldControls = Map<string, { row: QueuedControl; droppedAt: string | null }>;

/**
 * The one retirement rule for a queued command's row, switch or compaction, whichever source
 * showed it. A row stays until a transcript turn carries its control id (`answered`). A source
 * dropping it is not that: the record drops an item as the command starts, before its turn
 * reaches the transcript. The one other way out is proof it won't run: an accepted snapshot at
 * or after the dropping record (`history`) whose turns lack it, as after a Withdraw from another
 * tab. This device's own Withdraw releases the row at once (`held.delete`). Keyed by control
 * id, mutating `held` between calls.
 */
export function retainControls(
  held: HeldControls,
  input: {
    rows: readonly QueuedControl[];
    answered: ReadonlySet<string>;
    /** The newest record's version. */
    version: string | null;
    history: string | null;
  },
): QueuedControl[] {
  const { rows, answered, version, history } = input;
  const shown = new Set<string>();
  for (const row of rows) {
    shown.add(row.id);
    held.set(row.id, { row, droppedAt: null });
  }
  const result: QueuedControl[] = [];
  for (const [id, entry] of held) {
    if (answered.has(id)) {
      held.delete(id);
      continue;
    }
    if (!shown.has(id)) {
      entry.droppedAt ??= version;
      if (
        entry.droppedAt === null ||
        (history !== null && compareSeq(history, entry.droppedAt) >= 0)
      ) {
        held.delete(id);
        continue;
      }
    }
    result.push(entry.row);
  }
  return result;
}

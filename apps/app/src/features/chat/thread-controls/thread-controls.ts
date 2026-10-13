/**
 * Optimistic writer commands: the local half of `/compact` and write-mode
 * switches, merged with the server's pending inbox.
 *
 * Local state, each piece small:
 * - `sends`: commands this tab asked for that the server inbox has not listed
 *   yet. The writer sees one the moment they ask; a failed enqueue stays on
 *   the item with Retry (same id, so the server treats a retry as a no-op).
 *   Once the inbox lists the id the server owns it, and the send is dropped.
 *   A `/compact` is posted from here. A switch is posted by the submission
 *   journal's driver, so it only lands here once the server has answered.
 * - `journaled`: switches still in the journal, unposted or failed. They are
 *   the "Switching" and "Couldn't switch" rows, the same after a reload.
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
 *
 * A chat has at most one queued switch: a switch to the other mode cancels it
 * on the server. Until the server says so, a switch back that has not been
 * answered hides both rows at once (the writer's mode is where they started),
 * and the server's `null`/`null` answer confirms it.
 */
import type {
  ControlBody,
  PendingInboxItem,
  ThreadPendingInbox,
} from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";

export type CompactControl = Extract<ControlBody, { kind: "compact" }>;
export type WriteModeControl = Extract<ControlBody, { kind: "write_mode" }>;

export type LocalSend = {
  id: string;
  control: ControlBody;
  request: "sending" | "sent" | "failed" | "finished";
};

/** A switch the submission journal still holds: not yet admitted by the server. */
export type JournaledSwitch = { id: string; mode: AiWriteMode; failed: boolean };

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
};

export type ControlAction =
  | { type: "enqueue"; id: string; control: ControlBody }
  | { type: "retry"; id: string }
  | { type: "enqueued"; id: string; pending: PendingInboxItem | null; turnId: string | null }
  /**
   * The journal's driver got the server's answer to a switch. `cancels` are the
   * queued switches to the other mode that answer withdrew (`null`/`null`).
   */
  | {
      type: "switch_answered";
      id: string;
      control: WriteModeControl;
      pending: PendingInboxItem | null;
      turnId: string | null;
      cancels: readonly string[];
    }
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
    case "switch_answered": {
      const request: LocalSend["request"] = action.pending ? "sent" : "finished";
      const withdrawals = new Map(state.withdrawals);
      for (const id of action.cancels) withdrawals.set(id, "settled");
      const known = state.sends.some((entry) => entry.id === action.id);
      const sends = known
        ? state.sends.map((entry) => (entry.id === action.id ? { ...entry, request } : entry))
        : [...state.sends, { id: action.id, control: action.control, request }];
      return { sends, withdrawals };
    }
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
  pending: ThreadPendingInbox;
  /** Switches the journal still holds, oldest first. */
  journaled?: readonly JournaledSwitch[];
  /** Commands a divider already names. */
  executedControlIds: ReadonlySet<string>;
};

/**
 * The commands the writer should see: server rows first (in inbox order),
 * then local ones the server has not listed yet.
 */
export function mergeQueuedControls(input: MergeInput): QueuedControl[] {
  return foldSwitchBack(listControls(input)).map((row) => row.control);
}

type Listed = { control: QueuedControl; unanswered: boolean };

function listControls(input: MergeInput): Listed[] {
  const { local, pending, executedControlIds } = input;
  const result: Listed[] = [];
  const listed = new Set<string>();
  for (const item of pending.items) {
    if (item.intent !== "control" || !item.control) continue;
    listed.add(item.id);
    // A withdrawal response is fresher than the inbox frame that follows it.
    const withdrawal = local.withdrawals.get(item.id);
    if (!withdrawal) {
      result.push({
        control: { id: item.id, control: item.control, status: "queued" },
        unanswered: false,
      });
    } else if (withdrawal === "failed") {
      result.push({
        control: { id: item.id, control: item.control, status: "withdraw_failed" },
        unanswered: false,
      });
    }
  }
  for (const entry of local.sends) {
    const withdrawal = local.withdrawals.get(entry.id);
    if (listed.has(entry.id) || (withdrawal && withdrawal !== "failed")) continue;
    const status = requestStatus(entry, executedControlIds);
    if (!status) continue;
    result.push({
      control: {
        id: entry.id,
        control: entry.control,
        status: withdrawal && status !== "failed" ? "withdraw_failed" : status,
      },
      unanswered: entry.request === "sending",
    });
  }
  for (const entry of input.journaled ?? []) {
    const withdrawal = local.withdrawals.get(entry.id);
    if (listed.has(entry.id) || (withdrawal && withdrawal !== "failed")) continue;
    result.push({
      control: {
        id: entry.id,
        control: { kind: "write_mode", mode: entry.mode },
        status: entry.failed ? "failed" : "sending",
      },
      unanswered: !entry.failed,
    });
  }
  return result;
}

/**
 * The server keeps one queued switch: a switch to the other mode withdraws it,
 * and a repeat of the same mode changes nothing. Show that before the answer.
 * Only a switch the server has not answered is predicted; one it has listed or
 * answered is its word.
 */
function foldSwitchBack(rows: readonly Listed[]): Listed[] {
  const dropped = new Set<Listed>();
  let open: Listed | null = null;
  for (const row of rows) {
    const { control } = row.control;
    if (control.kind !== "write_mode" || row.control.status === "failed") continue;
    if (open && open.control.control.kind === "write_mode") {
      const same = open.control.control.mode === control.mode;
      if (row.unanswered && !same) {
        dropped.add(open);
        dropped.add(row);
        open = null;
        continue;
      }
      if (row.unanswered && same) {
        dropped.add(row);
        continue;
      }
    }
    open = row;
  }
  return rows.filter((row) => !dropped.has(row));
}

/**
 * The queued switches to the other mode that the server's `null`/`null` answer
 * to `entry` withdrew: the ones asked before it. A queued switch to the same
 * mode stays.
 */
export function switchesCancelledBy(
  input: MergeInput,
  entry: { id: string; mode: AiWriteMode },
): string[] {
  const rows = listControls(input).map((row) => row.control);
  const at = rows.findIndex((row) => row.id === entry.id);
  return (at < 0 ? rows : rows.slice(0, at))
    .filter(
      (row) =>
        row.status !== "failed" &&
        row.control.kind === "write_mode" &&
        row.control.mode !== entry.mode,
    )
    .map((row) => row.id);
}

/** The chat's mode as the writer should see it: the last live queued switch wins. */
export function overlaidWriteMode(
  base: AiWriteMode,
  queued: readonly QueuedControl[],
): AiWriteMode {
  let mode = base;
  for (const row of queued) {
    if (row.control.kind === "write_mode" && row.status !== "failed") mode = row.control.mode;
  }
  return mode;
}

function requestStatus(
  entry: LocalSend,
  executed: ReadonlySet<string>,
): QueuedControlStatus | null {
  if (entry.request === "sending") return "sending";
  if (entry.request === "failed") return "failed";
  if (entry.request === "finished" || executed.has(entry.id)) return null;
  // Accepted, and the inbox echo has not arrived yet.
  return "queued";
}

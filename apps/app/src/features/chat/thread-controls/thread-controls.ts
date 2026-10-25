/** Queued-control owner: reconcile authoritative lifetime before projecting optimistic rows. */
import { compareSeq } from "@meridian/contracts/protocol";
import type { ControlBody, PendingInboxItem } from "@meridian/contracts/threads";
import {
  type CardControl,
  type CommandFailure,
  durableControls,
  nextOccurrence,
  type Occurrence,
} from "@meridian/thread-client";

export type CompactControl = Extract<ControlBody, { kind: "compact" }>;
type Send = { attempt: number } & (
  | { request: "sending" | "sent" | "finished"; failure?: undefined }
  | { request: "failed"; failure: CommandFailure }
);
type Withdrawal = Occurrence &
  (
    | { status: "withdrawing" | "settled"; failure?: undefined }
    | { status: "failed"; failure: CommandFailure }
  );
type ControlEntry = {
  row: QueuedControl;
  send?: Send;
  withdrawal?: Withdrawal;
  admitted: boolean;
  /**
   * Newest record version known to list the command (an admission answer or an accepted record).
   * Only a newer record without it proves removal: an older one may predate admission.
   */
  listedAt: string | null;
  /** First authoritative absence, retained even while the writer hides the row. */
  droppedAt: string | null;
};
export type LocalControls = ReadonlyMap<string, ControlEntry>;
export const NO_LOCAL_CONTROLS: LocalControls = new Map();

/** `sending`: the writer asked and the server has not answered. */
export type QueuedControlStatus = "sending" | "queued" | "failed" | "withdraw_failed";

export type QueuedControl = CardControl & {
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

export type ControlFacts = {
  items: readonly PendingInboxItem[];
  switches: readonly QueuedControl[];
  answered: ReadonlySet<string>;
  version: string | null;
  history: string | null;
};
export type ControlAction =
  | { type: "enqueue"; id: string; control: CompactControl }
  | { type: "retry"; id: string }
  | { type: "enqueued"; id: string; sent: boolean; version: string }
  | { type: "enqueue_failed"; id: string; failure: CommandFailure }
  | { type: "withdraw"; row: QueuedControl; requestId: string }
  | { type: "withdrawn"; id: string; version: string }
  | { type: "withdraw_not_found"; id: string }
  | { type: "withdraw_failed"; id: string; failure: CommandFailure }
  | { type: "hide_switch"; id: string }
  | { type: "reconcile"; facts: ControlFacts };

export function controlsReducer(state: LocalControls, action: ControlAction): LocalControls {
  if (action.type === "reconcile") return reconcile(state, action.facts);
  const id = action.type === "withdraw" ? action.row.id : action.id;
  const entry = state.get(id);
  const next = new Map(state);
  if (action.type === "enqueue") {
    if (entry) return state;
    next.set(id, {
      row: { id, control: action.control, status: "queued" },
      send: { request: "sending", attempt: 1 },
      admitted: false,
      listedAt: null,
      droppedAt: null,
    });
    return next;
  }
  if (action.type === "withdraw") {
    next.set(id, {
      ...(entry ?? { row: action.row, admitted: true, listedAt: null, droppedAt: null }),
      withdrawal: {
        ...nextOccurrence(entry?.withdrawal?.attempt ?? 0, action.requestId),
        status: "withdrawing",
      },
    });
    return next;
  }
  if (!entry) return state;
  switch (action.type) {
    case "retry":
      if (!entry.send) return state;
      next.set(id, { ...entry, send: { request: "sending", attempt: entry.send.attempt + 1 } });
      break;
    case "enqueued":
      if (!entry.send) return state;
      next.set(id, {
        ...entry,
        admitted: true,
        // An answer listing the command is admission evidence; one without it fences removal.
        ...(action.sent
          ? { listedAt: newer(entry.listedAt, action.version) }
          : { droppedAt: action.version }),
        send: { request: action.sent ? "sent" : "finished", attempt: entry.send.attempt },
      });
      break;
    case "enqueue_failed":
      if (!entry.send) return state;
      next.set(id, {
        ...entry,
        send: { ...entry.send, request: "failed", failure: action.failure },
      });
      break;
    case "withdrawn":
      if (!entry.withdrawal) return state;
      next.set(id, {
        ...entry,
        send: undefined,
        admitted: true,
        droppedAt: action.version,
        withdrawal: { ...entry.withdrawal, status: "settled", failure: undefined },
      });
      break;
    case "withdraw_failed":
      if (!entry.withdrawal) return state;
      next.set(id, {
        ...entry,
        withdrawal: { ...entry.withdrawal, status: "failed", failure: action.failure },
      });
      break;
    case "withdraw_not_found":
    case "hide_switch":
      next.delete(id);
      break;
  }
  return next;
}

function reconcile(state: LocalControls, facts: ControlFacts): LocalControls {
  const next = new Map(state);
  const present = new Set<string>();
  const accept = (row: QueuedControl) => {
    present.add(row.id);
    next.set(row.id, {
      ...next.get(row.id),
      row,
      send: undefined,
      admitted: true,
      listedAt: newer(next.get(row.id)?.listedAt ?? null, facts.version),
      droppedAt: null,
    });
  };
  for (const item of durableControls(facts.items))
    if (item.control.kind === "compact")
      accept({ id: item.id, control: item.control, status: "queued" });
  for (const row of facts.switches) accept(row);
  for (const [id, entry] of next) {
    if (facts.answered.has(id)) {
      next.delete(id);
      continue;
    }
    // A snapshot predating admission cannot disprove a local request still in flight.
    if (present.has(id) || !entry.admitted) continue;
    const absentAt =
      facts.version !== null &&
      (entry.listedAt === null || compareSeq(facts.version, entry.listedAt) > 0)
        ? facts.version
        : null;
    const droppedAt = entry.droppedAt ?? absentAt;
    if (droppedAt !== null && facts.history !== null && compareSeq(facts.history, droppedAt) >= 0)
      next.delete(id);
    else if (droppedAt !== entry.droppedAt) next.set(id, { ...entry, droppedAt });
  }
  return next;
}

function newer(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  return compareSeq(a, b) >= 0 ? a : b;
}

/** Visibility has no authority: hiding a pending withdrawal preserves its target evidence. */
export function queuedControls(state: LocalControls): QueuedControl[] {
  const rows: QueuedControl[] = [];
  for (const entry of state.values()) {
    const { row, send, withdrawal } = entry;
    if (withdrawal) {
      if (withdrawal.status === "failed")
        rows.push({ ...row, status: "withdraw_failed", failure: withdrawal.failure });
    } else if (send?.request === "failed")
      rows.push({ ...row, status: "failed", failure: send.failure });
    else if (send?.request === "sending")
      rows.push({ ...row, status: "sending", failure: undefined });
    else rows.push(row);
  }
  return rows;
}

export function controlFailures(state: LocalControls): CommandFailure[] {
  return [...state.values()].flatMap(({ send, withdrawal }) => [
    ...(send?.request === "failed" && send.failure ? [send.failure] : []),
    ...(withdrawal?.status === "failed" && withdrawal.failure ? [withdrawal.failure] : []),
  ]);
}

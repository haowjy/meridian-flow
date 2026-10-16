/**
 * The switch fold: the toolbar's mode and the queued switch rows, as a pure selector over
 * the run-state view. It decides nothing about newness or retirement
 * (`run-state-view.ts` does), and a switch is never a writer message.
 *
 * It applies the server's enqueue rule over the switch intents in `(order, id)` order,
 * starting from the record's applied mode and its queued switch: a switch to the mode
 * the chat is heading to changes nothing, and a switch to the other mode withdraws the
 * queued one.
 */
import type { AiWriteMode } from "@meridian/contracts/works";
import type { CommandFailure } from "../commands";
import { durableControls } from "./durable-controls";
import type { RunStateIntent, RunStateView } from "./run-state-view";

export type SwitchRowStatus = "sending" | "queued" | "failed" | "withdraw_failed";

export type SwitchRow = {
  id: string;
  mode: AiWriteMode;
  /** The server may hold it and hasn't answered: Retry only, no Withdraw. */
  awaitingServer?: boolean;
  /**
   * The record says the switch applies when the next run starts (`awaiting_run`), so its
   * notice sits before that run's reply. Absent for a switch only this device holds, and for
   * one a reply holds the chat for (`waiting`): those stay at the tail.
   */
  awaitsRun?: boolean;
} & (
  | { status: "sending" | "queued"; failure?: never }
  | { status: "failed" | "withdraw_failed"; failure: CommandFailure }
);

type Switch = Extract<RunStateIntent, { kind: "switch" }>;
type Queued = { id: string; mode: AiWriteMode; from: "server" | Switch; awaitsRun?: boolean };

const byOrder = (a: Switch, b: Switch) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Null before the first record: there is no server mode to fold over, and the caller shows
 * its own (the thread row's). The row for a switch the server holds is `queued`; one only
 * this device holds is `sending`.
 */
export function switchState(view: RunStateView): { mode: AiWriteMode; rows: SwitchRow[] } | null {
  if (!view.record) return null;
  const applied = view.record.mode;
  const withdrawals = new Map<string, Extract<RunStateIntent, { kind: "withdraw" }>>();
  for (const intent of view.intents)
    if (intent.kind === "withdraw") withdrawals.set(intent.id, intent);

  let queued: Queued | null = null;
  for (const item of durableControls(view.record.items)) {
    if (item.control.kind !== "write_mode") continue;
    if (withdrawals.has(item.id) && !withdrawals.get(item.id)?.failed) continue;
    queued = {
      id: item.id,
      mode: item.control.mode,
      from: "server",
      awaitsRun: item.awaitsRun,
    };
    break;
  }

  const failedRows: SwitchRow[] = [];
  const switches = view.intents.filter((i): i is Switch => i.kind === "switch").sort(byOrder);
  for (const intent of switches) {
    if (withdrawals.has(intent.id) && !withdrawals.get(intent.id)?.failed) continue;
    if (intent.failed) {
      failedRows.push({
        id: intent.id,
        mode: intent.mode,
        status: "failed",
        failure: intent.failure,
        ...(intent.awaitingServer ? { awaitingServer: true } : {}),
      });
      continue;
    }
    if (intent.mode === (queued?.mode ?? applied)) continue;
    queued = queued ? null : { id: intent.id, mode: intent.mode, from: intent };
  }

  const rows = [...failedRows];
  if (queued) {
    const { id, mode, from, awaitsRun } = queued;
    if (from === "server") {
      const withdrawal = withdrawals.get(id);
      rows.push({
        id,
        mode,
        ...(awaitsRun ? { awaitsRun: true } : {}),
        ...(withdrawal?.failed
          ? { status: "withdraw_failed", failure: { ...withdrawal.occurrence, kind: "lost" } }
          : { status: "queued" }),
      });
    } else {
      rows.push({
        id,
        mode,
        status: "sending",
        ...(from.awaitingServer ? { awaitingServer: true } : {}),
      });
    }
  }
  return { mode: queued?.mode ?? applied, rows };
}

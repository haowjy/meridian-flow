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
import type { Intent, RunStateView } from "./run-state-view";

export type SwitchRowStatus = "sending" | "queued" | "failed" | "withdraw_failed";

export type SwitchRow = {
  id: string;
  mode: AiWriteMode;
  status: SwitchRowStatus;
  /** The server may hold it and hasn't answered: Retry only, no Withdraw. */
  awaitingServer?: boolean;
};

type Switch = Extract<Intent, { kind: "switch" }>;
type Queued = { id: string; mode: AiWriteMode; from: "server" | Switch };

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
  const withdrawals = new Map<string, boolean>();
  for (const intent of view.intents)
    if (intent.kind === "withdraw") withdrawals.set(intent.id, intent.failed === true);

  let queued: Queued | null = null;
  for (const item of view.record.items) {
    if (item.intent !== "control" || item.control?.kind !== "write_mode") continue;
    if (withdrawals.get(item.id) === false) continue;
    queued = { id: item.id, mode: item.control.mode, from: "server" };
    break;
  }

  const failedRows: SwitchRow[] = [];
  const switches = view.intents.filter((i): i is Switch => i.kind === "switch").sort(byOrder);
  for (const intent of switches) {
    if (withdrawals.get(intent.id) === false) continue;
    if (intent.failed) {
      failedRows.push({
        id: intent.id,
        mode: intent.mode,
        status: "failed",
        ...(intent.awaitingServer ? { awaitingServer: true } : {}),
      });
      continue;
    }
    if (intent.mode === (queued?.mode ?? applied)) continue;
    queued = queued ? null : { id: intent.id, mode: intent.mode, from: intent };
  }

  const rows = [...failedRows];
  if (queued) {
    const { id, mode, from } = queued;
    rows.push(
      from === "server"
        ? { id, mode, status: withdrawals.get(id) === true ? "withdraw_failed" : "queued" }
        : {
            id,
            mode,
            status: "sending",
            ...(from.awaitingServer ? { awaitingServer: true } : {}),
          },
    );
  }
  return { mode: queued?.mode ?? applied, rows };
}

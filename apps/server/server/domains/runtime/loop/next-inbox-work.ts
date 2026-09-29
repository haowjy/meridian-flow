/** Selects runnable work at start and adoptable rows at a reply boundary. */

import type { ControlBody } from "@meridian/contracts/threads";
import type { InboxMessage } from "./ports.js";

export type ControlMessage = InboxMessage & { intent: "control"; body: ControlBody };

export type InboxWorkSelection =
  | { kind: "batch"; rows: InboxMessage[] }
  | { kind: "control"; control: ControlMessage; rows: InboxMessage[] }
  | { kind: "none" };

export function next(
  pending: readonly InboxMessage[],
  at: "run_start" | "boundary",
): InboxWorkSelection {
  const rows = pending.filter((row) => row.intent !== "control");
  const hasMessages = rows.some((row) => row.intent === "message");
  if (at === "boundary") {
    const selected = hasMessages
      ? rows
      : rows.filter((row) => row.body.kind === "work_context_refresh");
    return selected.length > 0 ? { kind: "batch", rows: [...selected] } : { kind: "none" };
  }

  const controls = pending.filter((row) => row.intent === "control") as ControlMessage[];
  const runsFirst = controls.find((control) => control.runsFirst);
  if (runsFirst) return { kind: "control", control: runsFirst, rows: [...rows] };
  if (hasMessages) return { kind: "batch", rows: [...rows] };
  const control = controls[0];
  return control ? { kind: "control", control, rows: [...rows] } : { kind: "none" };
}

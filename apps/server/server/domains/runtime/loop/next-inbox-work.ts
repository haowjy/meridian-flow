/** Selects the next runnable inbox work at a run start or reply boundary. */

import type { ControlBody } from "@meridian/contracts/threads";
import type { InboxMessage } from "./ports.js";

export type ControlMessage = InboxMessage & { intent: "control"; body: ControlBody };

export type InboxWorkSelection =
  | { kind: "messages"; rows: InboxMessage[] }
  | { kind: "control"; control: ControlMessage; rows: InboxMessage[] }
  | { kind: "none" };

export function next(
  pending: readonly InboxMessage[],
  at: "run_start" | "boundary",
): InboxWorkSelection {
  const rows = pending.filter((row) => row.intent !== "control");
  const hasMessages = rows.some((row) => row.intent === "message");
  if (at === "boundary")
    return hasMessages ? { kind: "messages", rows: [...rows] } : { kind: "none" };

  const controls = pending.filter((row) => row.intent === "control") as ControlMessage[];
  const runsFirst = controls.find((control) => control.runsFirst);
  if (runsFirst) return { kind: "control", control: runsFirst, rows: [...rows] };
  if (hasMessages) return { kind: "messages", rows: [...rows] };
  const control = controls[0];
  return control ? { kind: "control", control, rows: [...rows] } : { kind: "none" };
}

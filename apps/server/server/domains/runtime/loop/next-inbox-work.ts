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
  if (at === "boundary") return rows.length > 0 ? { kind: "batch", rows } : { kind: "none" };

  if (pending.some((row) => row.intent === "message")) return { kind: "batch", rows };
  const control = pending.find(isControl);
  return control ? { kind: "control", control, rows: [] } : { kind: "none" };
}

function isControl(row: InboxMessage): row is ControlMessage {
  return row.intent === "control";
}

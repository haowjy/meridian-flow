/**
 * Selects runnable work at run start and adoptable rows at a request boundary
 * (between two model requests inside one reply).
 *
 * The queued write-mode switch S is the one exception to "messages first": a
 * message behind S (higher seq) must be answered in S's mode, so a request
 * boundary ends the reply (`yield`) and run start applies S (`switch`) before
 * any message runs. With nothing behind it, S runs as the oldest control.
 */

import type { ControlBody } from "@meridian/contracts/threads";
import type { InboxMessage } from "./ports.js";

export type ControlMessage = InboxMessage & { intent: "control"; body: ControlBody };
export type WriteModeSwitchMessage = InboxMessage & {
  intent: "control";
  body: Extract<ControlBody, { kind: "write_mode" }>;
};

export type InboxWorkSelection =
  | { kind: "batch"; rows: InboxMessage[] }
  | { kind: "control"; control: ControlMessage; rows: InboxMessage[] }
  | { kind: "switch"; control: WriteModeSwitchMessage }
  | { kind: "yield" }
  | { kind: "none" };

export function next(
  pending: readonly InboxMessage[],
  at: "run_start" | "boundary",
): InboxWorkSelection {
  const queuedSwitch = pending.find(isWriteModeSwitch);
  if (queuedSwitch && pending.some((row) => row.intent === "message" && row.seq > queuedSwitch.seq))
    return at === "boundary" ? { kind: "yield" } : { kind: "switch", control: queuedSwitch };

  const rows = pending.filter((row) => row.intent !== "control");
  if (at === "boundary") return rows.length > 0 ? { kind: "batch", rows } : { kind: "none" };

  if (pending.some((row) => row.intent === "message")) return { kind: "batch", rows };
  const control = pending.find(isControl);
  if (!control) return { kind: "none" };
  return isWriteModeSwitch(control)
    ? { kind: "switch", control }
    : { kind: "control", control, rows: [] };
}

/** The chat's queued switch; enqueue cancel-out keeps at most one. */
export function queuedWriteModeSwitch(
  pending: readonly InboxMessage[],
): WriteModeSwitchMessage | null {
  return pending.find(isWriteModeSwitch) ?? null;
}

function isControl(row: InboxMessage): row is ControlMessage {
  return row.intent === "control";
}

function isWriteModeSwitch(row: InboxMessage): row is WriteModeSwitchMessage {
  return row.intent === "control" && row.body.kind === "write_mode";
}

/** Materialization takes every waiting non-command row; a queued switch is not a boundary for it. */
export function prefixRows(eligible: readonly InboxMessage[]): InboxWorkSelection {
  const rows = eligible.filter((row) => row.intent !== "control");
  return rows.length > 0 ? { kind: "batch", rows } : { kind: "none" };
}

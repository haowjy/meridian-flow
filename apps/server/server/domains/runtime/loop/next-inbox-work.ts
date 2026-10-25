/**
 * Selects runnable work at run start and adoptable rows at a request boundary
 * (between two model requests inside one reply).
 *
 * The queued write-mode switch S is the one exception to "messages first": a
 * message behind S (higher seq) must be answered in S's mode, so a request
 * boundary ends the reply (`yield`) and run start applies S (`switch`) before
 * any message runs. A switch is pending until a run is about to start: with
 * nothing else to run, S stays queued and applies before the next run.
 */

import type { ControlBody } from "@meridian/contracts/threads";
import type { InboxMessage } from "./ports.js";

export type ControlMessage = InboxMessage & { intent: "control"; body: ControlBody };
export type AskResolvedMessage = InboxMessage & {
  intent: "control";
  body: { kind: "ask_resolved"; askId: string };
};
export type WriteModeSwitchMessage = InboxMessage & {
  intent: "control";
  body: Extract<ControlBody, { kind: "write_mode" }>;
};

export type InboxWorkSelection =
  | { kind: "batch"; rows: InboxMessage[] }
  | { kind: "control"; control: ControlMessage | AskResolvedMessage; rows: InboxMessage[] }
  | { kind: "switch"; control: WriteModeSwitchMessage }
  | { kind: "yield" }
  | { kind: "none" };

/** `retry`: a Retry starts a reply by itself, so a lone queued switch is due at run start. */
export function next(
  pending: readonly InboxMessage[],
  at: "run_start" | "boundary",
  retry = false,
): InboxWorkSelection {
  const continuation = pending.find(isAskResolved);
  if (continuation)
    return at === "run_start"
      ? { kind: "control", control: continuation, rows: [] }
      : { kind: "none" };
  const queuedSwitch = pending.find(isWriteModeSwitch);
  if (queuedSwitch && at === "run_start" && retry) return { kind: "switch", control: queuedSwitch };
  if (queuedSwitch && pending.some((row) => row.intent === "message" && row.seq > queuedSwitch.seq))
    return at === "boundary" ? { kind: "yield" } : { kind: "switch", control: queuedSwitch };

  const rows = pending.filter((row) => row.intent !== "control");
  if (at === "boundary") return rows.length > 0 ? { kind: "batch", rows } : { kind: "none" };

  if (pending.some((row) => row.intent === "message")) return { kind: "batch", rows };
  // Only a compaction runs by itself; a lone switch waits for the next run.
  const control = pending.find(isControl);
  if (!control || !pending.some((row) => isControl(row) && !isWriteModeSwitch(row)))
    return { kind: "none" };
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
  return row.intent === "control" && row.body.kind !== "ask_resolved";
}

function isAskResolved(row: InboxMessage): row is AskResolvedMessage {
  return row.intent === "control" && row.body.kind === "ask_resolved";
}

function isWriteModeSwitch(row: InboxMessage): row is WriteModeSwitchMessage {
  return row.intent === "control" && row.body.kind === "write_mode";
}

/** Materialization takes every waiting non-command row; a queued switch is not a boundary for it. */
export function prefixRows(eligible: readonly InboxMessage[]): InboxWorkSelection {
  const rows = eligible.filter((row) => row.intent !== "control");
  return rows.length > 0 ? { kind: "batch", rows } : { kind: "none" };
}

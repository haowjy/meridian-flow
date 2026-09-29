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
  const firstControl = pending.findIndex((row) => row.intent === "control");
  const prefix = pending.slice(0, firstControl < 0 ? pending.length : firstControl);
  if (prefix.length > 0) return { kind: "batch", rows: [...prefix] };
  if (at === "boundary" || firstControl < 0) return { kind: "none" };
  const control = pending[firstControl] as ControlMessage;
  return { kind: "control", control, rows: [] };
}

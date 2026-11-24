import type { ControlBody } from "@meridian/contracts/threads";
import type { AskResolvedBody, InboxMessage } from "./ports.js";

export type ControlMessage = InboxMessage & { intent: "control"; body: ControlBody };
export type AskResolvedMessage = InboxMessage & {
  intent: "control";
  body: AskResolvedBody;
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

export function next(
  pending: readonly InboxMessage[],
  at: "run_start" | "boundary",
  retry = false,
): InboxWorkSelection {
  const continuation = pending.find(isAskResolved);
  if (continuation) {
    const queuedSwitch = pending.find(isWriteModeSwitch);
    const rows = pending.filter(
      (row) => row.intent !== "control" && (!queuedSwitch || row.seq < queuedSwitch.seq),
    );
    return at === "run_start"
      ? {
          kind: "control",
          control: continuation,
          rows,
        }
      : { kind: "none" };
  }
  const queuedSwitch = pending.find(isWriteModeSwitch);
  if (queuedSwitch && at === "run_start" && retry) return { kind: "switch", control: queuedSwitch };
  if (queuedSwitch && pending.some((row) => row.intent === "message" && row.seq > queuedSwitch.seq))
    return at === "boundary" ? { kind: "yield" } : { kind: "switch", control: queuedSwitch };

  const rows = pending.filter((row) => row.intent !== "control");
  if (at === "boundary") return rows.length > 0 ? { kind: "batch", rows } : { kind: "none" };

  if (pending.some((row) => row.intent === "message")) return { kind: "batch", rows };
  const control = pending.find(isControl);
  if (!control || !pending.some((row) => isControl(row) && !isWriteModeSwitch(row)))
    return { kind: "none" };
  return isWriteModeSwitch(control)
    ? { kind: "switch", control }
    : { kind: "control", control, rows: [] };
}

export function queuedWriteModeSwitch(
  pending: readonly InboxMessage[],
): WriteModeSwitchMessage | null {
  return pending.find(isWriteModeSwitch) ?? null;
}

function isControl(row: InboxMessage): row is ControlMessage {
  return row.intent === "control" && row.body.kind !== "ask_resolved";
}

export function isAskResolved(row: InboxMessage): row is AskResolvedMessage {
  return row.intent === "control" && row.body.kind === "ask_resolved";
}

function isWriteModeSwitch(row: InboxMessage): row is WriteModeSwitchMessage {
  return row.intent === "control" && row.body.kind === "write_mode";
}

export function prefixRows(eligible: readonly InboxMessage[]): InboxWorkSelection {
  const queuedSwitch = eligible.find(isWriteModeSwitch);
  const rows = eligible.filter(
    (row) => row.intent !== "control" && (!queuedSwitch || row.seq < queuedSwitch.seq),
  );
  return rows.length > 0 ? { kind: "batch", rows } : { kind: "none" };
}

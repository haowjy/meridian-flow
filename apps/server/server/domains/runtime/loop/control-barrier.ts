/** Selects one boundary's eligible inbox prefix before Work coalescing or acknowledgement. */
import type { ControlBody } from "@meridian/contracts/threads";
import type { InboxMessage } from "./ports.js";

export type ControlMessage = InboxMessage & { intent: "control"; body: ControlBody };

export function planControlBarrier(input: {
  pending: readonly InboxMessage[];
  chainedIds: ReadonlySet<string>;
  boundIds: ReadonlySet<string>;
}): { batch: InboxMessage[]; execute: ControlMessage | null } {
  const unbound = input.pending.filter((row) => !input.boundIds.has(row.id));
  const index = unbound.findIndex((row) => row.intent === "control");
  if (index < 0) return { batch: unbound, execute: null };
  const head = unbound[index] as ControlMessage;
  const ahead = unbound.slice(0, index);
  const execute =
    !ahead.some((row) => row.intent === "message") ||
    unbound.slice(index + 1).some((row) => input.chainedIds.has(row.id));
  return {
    batch: unbound.filter(
      (row, position) =>
        row.intent !== "control" && (position < index || (execute && input.chainedIds.has(row.id))),
    ),
    execute: execute ? head : null,
  };
}

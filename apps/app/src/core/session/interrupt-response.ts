/**
 * interrupt-response — the local settlement identity and status for an
 * `interrupt.respond` send, keyed by the same `(threadId, turnId, interruptId)`
 * correlation tuple the server uses.
 *
 * This is not the answer authority. The agent outcome is server-confirmed by the
 * journaled `meridian.interrupt` lifecycle event; these entries only carry the
 * local send state (pending / proven-failed / ambiguous) that keeps the card's
 * controls honest and offers a tuple-preserving Retry.
 */
import type { JsonValue } from "@meridian/contracts/threads";

export type InterruptResponseIdentity = {
  threadId: string;
  turnId: string;
  interruptId: string;
};

export type InterruptResponseStatus = "pending" | "ambiguous" | "failed";

export type InterruptResponseState = {
  status: InterruptResponseStatus;
};

export type InterruptResponseEntry = InterruptResponseIdentity & {
  status: InterruptResponseStatus;
  /** The exact value submitted; Retry re-sends this with the same tuple. */
  value: JsonValue;
};

export function interruptResponseKey(identity: InterruptResponseIdentity): string {
  return `${identity.threadId}\u0000${identity.turnId}\u0000${identity.interruptId}`;
}
